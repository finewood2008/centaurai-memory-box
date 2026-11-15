from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
import multiprocessing
import re
import sqlite3
import threading

import pytest

from wanx_studio.contracts import StudioError
from wanx_studio.deployment.journal import Journal


TARGET = {"organizationId": "org", "boxId": "box", "applicationId": "app", "environment": "dev"}


def request(key="key", target=None, generation=0):
    return {"kind": "deploy", "target": deepcopy(target or TARGET), "expectedGeneration": generation,
            "idempotencyKey": key, "releaseRef": {"releaseId": "release", "bundleDigest": "sha256:" + "a" * 64}}


def submit(journal, key="key", target=None, owner="alice", generation=0):
    return journal.submit(owner, request(key, target, generation), "hash-" + key, 100, 500)


def receipt(op, state="succeeded", revision=0, receipt_id="receipt"):
    return {"receiptId": receipt_id, "operationId": op["id"], "operationRevision": op["revision"] + 1,
            "kind": op["request"]["kind"], "target": deepcopy(op["target"]), "outcome": state,
            "commitStatus": op["commitStatus"], "committedGeneration": op["committedGeneration"],
            "previousGeneration": op["previousGeneration"], "environmentRevision": revision}


def finish(journal, op, state="succeeded", now=102, receipt_id="receipt", **kwargs):
    op["state"] = state
    env = journal.get_environment(op["target"])
    revision = env["revision"] + int("environment" in kwargs or state in {"failed_degraded", "recovery_required"})
    return journal.save(op, "worker", op["fence"], now, receipt=receipt(op, state, revision, receipt_id), **kwargs)


@pytest.fixture
def journal(tmp_path):
    value = Journal(tmp_path)
    yield value
    value.close()


def test_releases_survive_reopen_and_are_scoped(tmp_path):
    journal = Journal(tmp_path)
    bundle = {"applicationId": "app", "releaseId": "rel", "bundleDigest": "sha256:a", "provenance": "first"}
    assert journal.register_release("alice", bundle) == bundle
    assert journal.register_release("alice", dict(bundle, provenance="second")) == bundle
    with pytest.raises(StudioError, match="RELEASE_CONFLICT"):
        journal.register_release("alice", dict(bundle, bundleDigest="sha256:b"))
    journal.close()
    journal = Journal(tmp_path)
    try:
        assert journal.release("alice", "app", bundle) == bundle
        with pytest.raises(StudioError) as exc:
            journal.release("bob", "app", bundle)
        assert exc.value.status == 404
        with pytest.raises(StudioError):
            journal.release("alice", "other", bundle)
        assert journal.register_release("bob", dict(bundle, bundleDigest="sha256:b"))["bundleDigest"] == "sha256:b"
    finally:
        journal.close()


def test_idempotency_precedes_environment_checks_and_owner_isolation(journal):
    op = submit(journal)
    assert re.fullmatch(r"[a-f0-9]{32}", op["id"])
    assert submit(journal) == op
    with pytest.raises(StudioError, match="IDEMPOTENCY_CONFLICT"):
        journal.submit("alice", request(), "different", 101, 501)
    changed = request()
    changed["expectedGeneration"] = 7
    with pytest.raises(StudioError, match="IDEMPOTENCY_CONFLICT"):
        journal.submit("alice", changed, "hash-key", 101, 501)
    # Distinct owners cannot obtain separate locks for the same physical target.
    with pytest.raises(StudioError, match="ENVIRONMENT_BUSY"):
        submit(journal, owner="bob")
    with pytest.raises(StudioError) as exc:
        journal.get_operation("bob", op["id"])
    assert exc.value.status == 404
    with pytest.raises(StudioError):
        journal.events("bob", op["id"])
    with pytest.raises(StudioError):
        journal.receipt("bob", op["id"])
    assert journal.list_operations("bob") == []
    assert journal.list_operations("alice", TARGET) == [op]


@pytest.mark.parametrize("field,value", [("organizationId", "other"), ("boxId", "other"),
                                         ("applicationId", "other"), ("environment", "prod")])
def test_each_target_dimension_has_independent_environment(journal, field, value):
    first = submit(journal)
    second = submit(journal, target=dict(TARGET, **{field: value}))
    assert first["id"] != second["id"]
    assert len(journal.pending(100)) == 2
    assert len(journal.list_operations("alice", TARGET)) == 1


def test_generation_and_strict_target(journal):
    assert journal.get_environment(TARGET)["generation"] == 0
    with pytest.raises(StudioError, match="GENERATION_CONFLICT"):
        submit(journal, generation=1)
    with pytest.raises(StudioError, match="TARGET_INVALID"):
        submit(journal, target=dict(TARGET, owner="alice"))
    with pytest.raises(StudioError, match="TARGET_INVALID"):
        submit(journal, target=dict(TARGET, environment="production"))
    assert journal.pending(100) == []


def test_two_handles_compete_for_one_claim_and_stale_fence_cannot_write(tmp_path):
    first, second = Journal(tmp_path), Journal(tmp_path)
    try:
        op = submit(first)
        barrier = threading.Barrier(2)
        def claim(journal, worker):
            barrier.wait()
            return journal.claim(op["id"], worker, 101, 10)
        with ThreadPoolExecutor(max_workers=2) as pool:
            futures = [pool.submit(claim, first, "a"), pool.submit(claim, second, "b")]
            winners = [x for future in futures if (x := future.result())]
        assert len(winners) == 1
        stale = winners[0]
        assert first.pending(110) == []
        assert second.claim(op["id"], "new", 110, 10) is None
        fresh = second.claim(op["id"], "new", 111, 10)
        assert fresh["fence"] > stale["fence"]
        with pytest.raises(StudioError, match="LEASE_LOST"):
            first.save(stale, stale["leaseOwner"], stale["fence"], 112)
        with pytest.raises(StudioError, match="LEASE_LOST"):
            first.release_claim(stale["id"], stale["leaseOwner"], stale["fence"], 112)
        with pytest.raises(StudioError, match="REVISION_CONFLICT"):
            second.save(dict(fresh, revision=fresh["revision"] - 1), "new", fresh["fence"], 112)
        fresh = second.save(fresh, "new", fresh["fence"], 112)
        assert fresh["revision"] > stale["revision"]
        with pytest.raises(StudioError, match="LEASE_LOST"):
            second.save(fresh, "new", fresh["fence"], 121)
    finally:
        first.close()
        second.close()


def test_delayed_release_is_respected_after_restart(tmp_path):
    journal = Journal(tmp_path)
    op = journal.claim(submit(journal)["id"], "worker", 101, 30)
    journal.release_claim(op["id"], "worker", op["fence"], 102, delay=10)
    journal.close()
    journal = Journal(tmp_path)
    try:
        assert journal.pending(111) == []
        assert journal.claim(op["id"], "worker", 111, 30) is None
        assert journal.pending(112)[0]["id"] == op["id"]
        assert journal.claim(op["id"], "worker", 112, 30)["fence"] > op["fence"]
    finally:
        journal.close()


def test_event_pagination_uses_durable_sequence_and_owner(journal):
    op = journal.claim(submit(journal)["id"], "worker", 101, 30)
    for i in range(3):
        op = journal.save(op, "worker", op["fence"], 102 + i, event={"type": "progress", "sequence": 999})
    page = journal.events("alice", op["id"], limit=2)
    assert [item["sequence"] for item in page["items"]] == [1, 2]
    assert page["hasMore"] is True
    rest = journal.events("alice", op["id"], after=page["nextCursor"], limit=2)
    assert [item["sequence"] for item in rest["items"]] == [3, 4]
    assert rest["hasMore"] is False
    assert journal.events("alice", op["id"], after=4)["nextCursor"] == 4


def test_save_atomicity_and_terminal_immutability(journal):
    op = journal.claim(submit(journal)["id"], "worker", 101, 30)
    before = deepcopy(op)
    op["state"] = "succeeded"
    invalid = receipt(op, revision=1)
    invalid["target"] = dict(TARGET, boxId="wrong")
    with pytest.raises(StudioError, match="RECEIPT_MISMATCH"):
        journal.save(op, "worker", op["fence"], 102, environment={"generation": 1}, receipt=invalid)
    assert journal.get_operation("alice", op["id"]) == before
    assert journal.get_environment(TARGET)["generation"] == 0
    assert journal.receipt("alice", op["id"]) is None
    assert len(journal.events("alice", op["id"])["items"]) == 1
    done = finish(journal, op, environment={"generation": 1, "health": "healthy"})
    assert done["leaseOwner"] is None
    assert journal.get_environment(TARGET)["activeOperationId"] is None
    assert journal.pending(1000) == []
    assert journal.claim(done["id"], "worker", 200, 30) is None
    with pytest.raises(StudioError, match="OPERATION_TERMINAL"):
        journal.save(done, "worker", done["fence"], 103)
    assert journal.submit("alice", request(), "hash-key", 200, 500) == done
    assert submit(journal, key="new", generation=1)["previousGeneration"] == 1


def test_sql_failure_rolls_back_outbox_operation_and_environment(journal):
    op = journal.claim(submit(journal)["id"], "worker", 101, 30)
    journal._db.execute("CREATE TRIGGER fail_event BEFORE INSERT ON deployment_events BEGIN SELECT RAISE(ABORT,'injected'); END")
    with pytest.raises(sqlite3.IntegrityError):
        finish(journal, deepcopy(op), environment={"generation": 1})
    assert journal.get_operation("alice", op["id"]) == op
    assert journal.get_environment(TARGET)["generation"] == 0
    assert journal.outbox_pending(1000) == []


def test_operation_identity_and_environment_fence_cannot_be_patched(journal):
    op = journal.claim(submit(journal)["id"], "worker", 101, 30)
    for changed in ({"owner": "bob"}, {"target": dict(TARGET, boxId="other")},
                    {"request": request("different")}, {"deadline": 999}, {"previousGeneration": 8}):
        with pytest.raises(StudioError, match="OPERATION_IMMUTABLE"):
            journal.save(dict(op, **changed), "worker", op["fence"], 102)
    for changed in ({"target": TARGET}, {"fence": 0}, {"activeOperationId": "other"}):
        with pytest.raises(StudioError, match="ENVIRONMENT_IMMUTABLE"):
            journal.save(op, "worker", op["fence"], 102, environment=changed)
    with pytest.raises(StudioError, match="RECEIPT_REQUIRED"):
        journal.save(dict(op, state="succeeded"), "worker", op["fence"], 102)
    with pytest.raises(StudioError, match="RECEIPT_PREMATURE"):
        journal.save(op, "worker", op["fence"], 102, receipt=receipt(op))


def test_outbox_retry_does_not_mutate_operation_and_delivered_never_reverts(tmp_path):
    journal = Journal(tmp_path)
    op = journal.claim(submit(journal)["id"], "worker", 101, 30)
    done = finish(journal, op)
    journal.close()
    journal = Journal(tmp_path)
    try:
        item = journal.outbox_pending(102)[0]
        assert item["attempts"] == 0
        journal.record_delivery(item["receiptId"], False, 103, 30)
        assert journal.outbox_pending(132) == []
        assert journal.outbox_pending(133)[0]["attempts"] == 1
        with pytest.raises(StudioError):
            journal.retry_delivery("bob", op["id"], 104)
        assert journal.retry_delivery("alice", op["id"], 104)["attempts"] == 1
        assert journal.outbox_pending(104)
        journal.record_delivery(item["receiptId"], True, 105, 30)
        journal.record_delivery(item["receiptId"], False, 106, 30)
        assert journal.retry_delivery("alice", op["id"], 107)["deliveryStatus"] == "delivered"
        assert journal.receipt("alice", op["id"])["attempts"] == 2
        assert journal.outbox_pending(1000) == []
        assert journal.get_operation("alice", op["id"]) == done
    finally:
        journal.close()


@pytest.mark.parametrize("outcome", ["failed_degraded", "recovery_required"])
def test_recovery_is_linked_and_preserves_original_checkpoint(journal, outcome):
    op = journal.claim(submit(journal)["id"], "worker", 101, 30)
    op.update(checkpoint={"step": "commit", "intent": "saved"}, components=[{"kind": "server"}],
              commitStatus="committed", committedGeneration=1)
    done = finish(journal, op, outcome, environment={"generation": 1})
    with pytest.raises(StudioError, match="RECOVERY_REQUIRED"):
        submit(journal, key="ordinary", generation=1)
    with pytest.raises(StudioError):
        journal.create_recovery("bob", done["id"], 103, 500)
    recovery = journal.create_recovery("alice", done["id"], 103, 500)
    assert recovery["id"] != done["id"]
    assert recovery["request"]["kind"] == "recover"
    assert recovery["recoveryOf"] == done["id"]
    assert recovery["phase"] == "recover"
    for key in ("commitStatus", "committedGeneration", "previousGeneration", "checkpoint", "components"):
        assert recovery[key] == done[key]
    assert journal.create_recovery("alice", done["id"], 104, 500) == recovery
    assert journal.get_operation("alice", done["id"]) == done
    assert journal.claim(recovery["id"], "worker", 104, 30)["fence"] > done["fence"]


def _claim_in_process(root, operation_id, worker, start, output):
    journal = Journal(root)
    try:
        start.wait(timeout=10)
        result = journal.claim(operation_id, worker, 101, 30)
        output.put(result)
    finally:
        journal.close()


def test_separate_processes_share_the_same_lease(tmp_path):
    journal = Journal(tmp_path)
    op = submit(journal)
    context = multiprocessing.get_context("spawn")
    start, output = context.Event(), context.Queue()
    workers = [context.Process(target=_claim_in_process, args=(tmp_path, op["id"], name, start, output))
               for name in ("process-a", "process-b")]
    try:
        for worker in workers:
            worker.start()
        start.set()
        results = [output.get(timeout=20), output.get(timeout=20)]
        assert sum(result is not None for result in results) == 1
        winner = next(result for result in results if result is not None)
        assert journal.get_operation("alice", op["id"])["leaseOwner"] == winner["leaseOwner"]
        for worker in workers:
            worker.join(timeout=10)
            assert worker.exitcode == 0
    finally:
        for worker in workers:
            if worker.is_alive():
                worker.terminate()
                worker.join(timeout=5)
        output.close()
        journal.close()


def test_new_recovery_does_not_inherit_expired_compensation_deadline(journal):
    op = journal.claim(submit(journal)["id"], "worker", 101, 30)
    op["checkpoint"] = {"compensationDeadline": 101, "adapterRef": {"id": "checkpoint", "revision": 4}}
    done = finish(journal, op, "recovery_required")
    recovery = journal.create_recovery("alice", done["id"], 103, 600)
    assert recovery["deadline"] == 600
    assert "compensationDeadline" not in recovery["checkpoint"]
    assert recovery["checkpoint"]["adapterRef"] == {"id": "checkpoint", "revision": 4}
    assert journal.get_operation("alice", done["id"])["checkpoint"]["compensationDeadline"] == 101


def test_old_degraded_operation_cannot_recover_over_new_deployment(journal):
    op = journal.claim(submit(journal)["id"], "worker", 101, 30)
    op.update(commitStatus="committed", committedGeneration=1)
    original = finish(journal, op, "failed_degraded", environment={"generation": 1}, receipt_id="original")
    recovery = journal.create_recovery("alice", original["id"], 103, 600)
    recovery = journal.claim(recovery["id"], "worker", 104, 30)
    finish(journal, recovery, now=105, environment={"health": "healthy"}, receipt_id="recovered")
    next_op = journal.claim(submit(journal, key="next", generation=1)["id"], "worker", 106, 30)
    next_op.update(commitStatus="committed", committedGeneration=2)
    latest = finish(journal, next_op, "failed_degraded", now=107,
                    environment={"generation": 2}, receipt_id="latest")
    with pytest.raises(StudioError, match="RECOVERY_STALE"):
        journal.create_recovery("alice", original["id"], 108, 600)
    assert journal.get_environment(TARGET)["activeOperationId"] is None
    assert journal.get_environment(TARGET)["generation"] == 2
    assert journal.create_recovery("alice", latest["id"], 108, 600)["recoveryOf"] == latest["id"]


def test_failed_recovery_can_have_a_new_linked_recovery(journal):
    op = journal.claim(submit(journal)["id"], "worker", 101, 30)
    original = finish(journal, op, "recovery_required", receipt_id="original")
    recovery = journal.create_recovery("alice", original["id"], 103, 600)
    recovery = journal.claim(recovery["id"], "worker", 104, 30)
    failed = finish(journal, recovery, "recovery_required", now=105, receipt_id="failed-recovery")
    # Even unchanged generation cannot make the older terminal checkpoint current.
    assert failed["previousGeneration"] == original["previousGeneration"]
    with pytest.raises(StudioError, match="RECOVERY_STALE"):
        journal.create_recovery("alice", original["id"], 106, 600)
    retry = journal.create_recovery("alice", failed["id"], 106, 600)
    assert retry["recoveryOf"] == failed["id"]
    assert retry["request"]["recoveryOf"] == failed["id"]
    assert retry["id"] not in {original["id"], failed["id"]}
    assert journal.get_operation("alice", failed["id"]) == failed


def test_outbox_filters_owner_and_operation_before_limit(journal):
    first = journal.claim(submit(journal)["id"], "worker", 101, 30)
    first = finish(journal, first, receipt_id="aaa")
    second = journal.claim(submit(journal, target=dict(TARGET, boxId="other"), owner="bob")["id"], "worker", 101, 30)
    second = finish(journal, second, receipt_id="zzz")
    assert journal.outbox_pending(102, limit=1)[0]["operationId"] == first["id"]
    assert journal.outbox_pending(102, limit=1, owner="bob")[0]["operationId"] == second["id"]
    assert journal.outbox_pending(102, limit=1, operation_id=second["id"])[0]["owner"] == "bob"
    assert journal.outbox_pending(102, limit=1, owner="alice", operation_id=second["id"]) == []
    assert journal.outbox_pending(102, owner="bob", operation_id=second["id"])[0]["receiptId"] == "zzz"


def test_pending_rotates_waiting_operations_beyond_batch_limit(journal):
    all_ids = {
        submit(journal, target=dict(TARGET, boxId=f"box-{index}"))["id"]
        for index in range(51)
    }
    batch = journal.pending(101, limit=50)
    selected = {operation["id"] for operation in batch}
    untouched = all_ids - selected
    assert len(untouched) == 1
    for operation in batch:
        claimed = journal.claim(operation["id"], "worker", 101, 30)
        claimed["state"] = "waiting_box"
        claimed = journal.save(claimed, "worker", claimed["fence"], 102)
        journal.release_claim(claimed["id"], "worker", claimed["fence"], 103, delay=2)
    # All 51 are eligible again, but the never-attempted operation precedes retries.
    next_batch = journal.pending(105, limit=50)
    assert next_batch[0]["id"] in untouched
    assert selected | {operation["id"] for operation in next_batch} == all_ids
