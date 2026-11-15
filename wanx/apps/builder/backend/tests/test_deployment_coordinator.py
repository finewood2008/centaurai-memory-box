"""Coordinator integration against real SQLite and a test-only durable adapter.

The adapter below is deliberately confined to tests. It does not establish
platform support and never contacts devices or installs application artifacts.
"""

import asyncio
from collections import Counter
from copy import deepcopy
import json
from pathlib import Path

import pytest

from wanx_studio.contracts import StudioError
from wanx_studio.deployment.adapters import Blocked, Observation, Plan
from wanx_studio.deployment.contracts import validate_receipt
from wanx_studio.deployment.coordinator import Coordinator, TERMINAL


FIXTURES = Path(__file__).parent / "fixtures" / "deployment"
OWNER = "test-owner"


def sample(name):
    return json.loads((FIXTURES / name).read_text())


class Clock:
    def __init__(self):
        self.now = 1800000000

    def __call__(self):
        return self.now

    def advance(self, seconds=1):
        self.now += seconds


class DurableAdapter:
    available = True

    def __init__(self):
        self.channels = ("channel-demo",)
        self.effects = {}
        self.responses = {}
        self.calls = []
        self.executions = Counter()
        self.checks = []
        self.cancel_after = None
        self.denied_check = None
        self.acknowledge = True
        self.deliveries = []
        self.journal = None

    async def authorize(self, owner, target, action):
        assert owner == OWNER

    async def verify_release(self, owner, bundle):
        assert owner == OWNER

    async def check(self, operation, bundle, phase):
        self.checks.append((operation["id"], phase))
        if phase == self.denied_check:
            raise Blocked("REGRESSION_EVIDENCE_MISMATCH")
        return Plan(self.channels)

    def observation(self, step, operation, bundle):
        if step in self.responses:
            return self.responses[step]
        if step in {"verify_active", "recover"}:
            components = sample("success.receipt.json")["componentResults"]
            for component in components:
                component["actualReleaseRef"] = deepcopy(operation["request"].get("releaseRef") or {
                    "releaseId": bundle["releaseId"], "bundleDigest": bundle["bundleDigest"],
                })
            return Observation("done", tuple(components), {"id": "test-checkpoint", "revision": 1})
        return Observation("done", checkpoint_ref={"id": "test-checkpoint", "revision": 1})

    async def inspect(self, step, operation, bundle):
        self.calls.append(("inspect", operation["id"], step, operation["fence"]))
        return deepcopy(self.effects.get((operation["id"], step), Observation("not_started")))

    async def execute(self, step, operation, bundle):
        key = (operation["id"], step)
        self.calls.append(("execute", operation["id"], step, operation["fence"]))
        # Verify side effects can only occur after a durable intent and fence.
        persisted = self.journal.get_operation(OWNER, operation["id"])
        assert persisted["checkpoint"]["intent"]["step"] == step
        assert persisted["fence"] == operation["fence"]
        assert persisted["leaseOwner"] is not None
        assert key not in self.effects, "a proven existing effect must not execute twice"
        self.executions[key] += 1
        result = self.observation(step, operation, bundle)
        self.effects[key] = deepcopy(result)
        if self.cancel_after == step:
            self.cancel_after = None
            raise asyncio.CancelledError
        return result

    async def deliver(self, receipt):
        self.deliveries.append(deepcopy(receipt))
        if isinstance(self.acknowledge, Exception):
            raise self.acknowledge
        return receipt["receiptId"] if self.acknowledge else "wrong-receipt"


@pytest.fixture
async def setup(tmp_path, monkeypatch):
    monkeypatch.setattr(Coordinator, "start", lambda self: None)
    clock, adapter = Clock(), DurableAdapter()
    instances = []

    def create(**kwargs):
        coordinator = Coordinator(tmp_path, adapter, clock=clock, timeout=100,
                                  recovery_timeout=10, step_timeout=0.1,
                                  lease_seconds=10, retry_delay=0, **kwargs)
        adapter.journal = coordinator.journal
        instances.append(coordinator)
        return coordinator

    yield create, clock, adapter
    for coordinator in instances:
        await coordinator.close()


async def submit(coordinator, request_name="dev.request.json"):
    await coordinator.register_release(OWNER, sample("managed-spec.bundle.json"))
    return await coordinator.submit(OWNER, sample(request_name))


async def until(coordinator, clock, operation_id, predicate, limit=50):
    for _ in range(limit):
        operation = coordinator.operation(OWNER, operation_id)
        if predicate(operation):
            return operation
        await coordinator.process_once(operation_id)
        clock.advance()
    operation = coordinator.operation(OWNER, operation_id)
    assert predicate(operation), operation
    return operation


async def terminal(coordinator, clock, operation_id):
    return await until(coordinator, clock, operation_id, lambda operation: operation["state"] in TERMINAL)


async def test_success_requires_real_both_end_and_channel_observations(setup):
    create, clock, adapter = setup
    coordinator = create()
    operation = await submit(coordinator)
    assert operation["state"] == "queued"
    assert coordinator.journal.receipt(OWNER, operation["id"]) is None
    done = await terminal(coordinator, clock, operation["id"])
    assert done["state"] == "succeeded"
    assert done["committedGeneration"] == 1
    receipt = coordinator.journal.receipt(OWNER, operation["id"])["receipt"]
    assert validate_receipt(receipt) == receipt
    assert {c["role"] for c in receipt["componentResults"] if c["required"]} == {"backend", "client", "channel"}
    assert all(count == 1 for count in adapter.executions.values())
    assert [phase for _, phase in adapter.checks] == ["validating", "preflight", "commit"]
    environment = await coordinator.environment(OWNER, done["target"])
    assert environment["generation"] == 1
    assert environment["health"] == "healthy"
    assert environment["activeOperationId"] is None
    assert environment["activeReleaseRef"] == receipt["requestedReleaseRef"]
    assert not {"owner", "requestHash", "checkpoint", "leaseOwner", "fence"} & set(done)
    events = coordinator.journal.events(OWNER, operation["id"])["items"]
    assert events[-1]["type"] == "completed"
    assert events[-1]["state"] == "succeeded"


@pytest.mark.parametrize("missing_role", ["client", "channel"])
async def test_incomplete_success_observation_never_becomes_success(setup, missing_role):
    create, clock, adapter = setup
    components = sample("success.receipt.json")["componentResults"]
    adapter.responses["verify_active"] = Observation("done", tuple(c for c in components if c["role"] != missing_role))
    coordinator = create()
    operation = await submit(coordinator)
    blocked = await until(coordinator, clock, operation["id"], lambda op: op["phase"] == "verify_active" and op["state"] == "reconciling")
    assert blocked["errorCode"] == "ADAPTER_RESULT_INVALID"
    assert coordinator.journal.receipt(OWNER, operation["id"]) is None
    clock.now = blocked["deadline"] + 1
    done = await terminal(coordinator, clock, operation["id"])
    assert done["state"] == "failed_degraded"


async def test_idempotency_conflicts_and_completed_retry_do_not_redeploy(setup):
    create, clock, adapter = setup
    coordinator = create()
    first = await submit(coordinator)
    assert (await coordinator.submit(OWNER, sample("dev.request.json")))["id"] == first["id"]
    changed = sample("dev.request.json")
    changed["dataPlanRef"]["revision"] += 1
    with pytest.raises(StudioError, match="IDEMPOTENCY_CONFLICT"):
        await coordinator.submit(OWNER, changed)
    done = await terminal(coordinator, clock, first["id"])
    effects = deepcopy(adapter.executions)
    assert await coordinator.submit(OWNER, sample("dev.request.json")) == done
    await coordinator.process_once(first["id"])
    assert adapter.executions == effects
    with pytest.raises(StudioError) as denied:
        coordinator.operation("different-owner", first["id"])
    assert denied.value.status == 404


async def test_restart_inspects_saved_intent_and_does_not_reexecute_effect(setup):
    create, clock, adapter = setup
    coordinator = create()
    adapter.cancel_after = "prepare_backend"
    operation = await submit(coordinator)
    await until(coordinator, clock, operation["id"], lambda op: op["phase"] == "prepare_backend")
    with pytest.raises(asyncio.CancelledError):
        await coordinator.process_once(operation["id"])
    pending = coordinator.journal.get_operation(OWNER, operation["id"])
    assert pending["checkpoint"]["intent"]["step"] == "prepare_backend"
    assert adapter.executions[(operation["id"], "prepare_backend")] == 1
    await coordinator.close()
    restarted = create()
    count = len(adapter.calls)
    clock.advance()
    done = await terminal(restarted, clock, operation["id"])
    assert done["state"] == "succeeded"
    first_after_restart = adapter.calls[count]
    assert first_after_restart[:3] == ("inspect", operation["id"], "prepare_backend")
    assert first_after_restart[3] > pending["fence"]
    assert adapter.executions[(operation["id"], "prepare_backend")] == 1


async def test_bounded_precommit_wait_compensates_without_activating(setup):
    create, clock, adapter = setup
    adapter.responses["prepare_client"] = Observation("waiting_client", code="CLIENT_UNAVAILABLE")
    coordinator = create()
    operation = await submit(coordinator)
    waiting = await until(coordinator, clock, operation["id"], lambda op: op["state"] == "waiting_client")
    clock.now = waiting["deadline"] + 1
    done = await terminal(coordinator, clock, operation["id"])
    assert done["state"] == "failed_recovered"
    assert done["commitStatus"] == "not_committed"
    assert done["deadline"] == waiting["deadline"]
    assert adapter.executions[(operation["id"], "compensate")] == 1
    assert adapter.executions[(operation["id"], "activate")] == 0
    environment = await coordinator.environment(OWNER, operation["target"])
    assert environment["generation"] == 0
    assert environment["activeReleaseRef"] is None
    receipt = coordinator.journal.receipt(OWNER, operation["id"])["receipt"]
    assert receipt["error"]["code"] == "DEPLOYMENT_WAIT_EXPIRED"


async def test_unconfirmed_compensation_has_its_own_bounded_recovery_window(setup):
    create, clock, adapter = setup
    adapter.responses["prepare_client"] = Observation("waiting_client", code="CLIENT_UNAVAILABLE")
    adapter.responses["compensate"] = Observation("unknown")
    coordinator = create()
    operation = await submit(coordinator)
    waiting = await until(coordinator, clock, operation["id"], lambda op: op["state"] == "waiting_client")
    clock.now = waiting["deadline"] + 1
    await until(coordinator, clock, operation["id"], lambda op: op["phase"] == "compensate" and op["state"] == "reconciling")
    assert coordinator.journal.receipt(OWNER, operation["id"]) is None
    clock.advance(20)
    done = await terminal(coordinator, clock, operation["id"])
    assert done["state"] == "recovery_required"
    assert adapter.executions[(operation["id"], "compensate")] == 1
    receipt = coordinator.journal.receipt(OWNER, operation["id"])["receipt"]
    assert receipt["recoveryRef"]
    assert receipt["committedGeneration"] is None


async def test_postcommit_failure_degrades_then_links_new_recovery_without_rewriting_terminal(setup):
    create, clock, adapter = setup
    adapter.responses["activate"] = Observation("failed", code="CHANNEL_NOT_READY")
    coordinator = create()
    operation = await submit(coordinator)
    pending = await until(coordinator, clock, operation["id"], lambda op: op["phase"] == "activate" and op["state"] == "reconciling")
    assert pending["commitStatus"] == "committed"
    clock.now = pending["deadline"] + 1
    degraded = await terminal(coordinator, clock, operation["id"])
    assert degraded["state"] == "failed_degraded"
    original_receipt = deepcopy(coordinator.journal.receipt(OWNER, operation["id"])["receipt"])
    assert adapter.executions[(operation["id"], "compensate")] == 0
    recovery = await coordinator.recover(OWNER, operation["id"])
    assert recovery["id"] != operation["id"]
    done = await terminal(coordinator, clock, recovery["id"])
    assert done["state"] == "succeeded"
    assert done["kind"] == "recover"
    recovered_receipt = coordinator.journal.receipt(OWNER, recovery["id"])["receipt"]
    assert recovered_receipt["recoveryOf"] == operation["id"]
    assert recovered_receipt["checkpointRef"]["id"] == operation["id"]
    assert recovered_receipt["committedGeneration"] == 1
    assert coordinator.journal.receipt(OWNER, operation["id"])["receipt"] == original_receipt
    assert coordinator.operation(OWNER, operation["id"]) == degraded
    environment = await coordinator.environment(OWNER, operation["target"])
    assert environment["generation"] == 1
    assert environment["health"] == "healthy"


async def test_receipt_delivery_retries_durable_receipt_without_redeployment(setup):
    create, clock, adapter = setup
    coordinator = create()
    operation = await submit(coordinator)
    await terminal(coordinator, clock, operation["id"])
    before = coordinator.journal.get_operation(OWNER, operation["id"])
    effects = deepcopy(adapter.executions)
    adapter.acknowledge = OSError("SECRET_ADAPTER_DETAIL")
    await coordinator.deliver_pending()
    first = coordinator.journal.receipt(OWNER, operation["id"])
    assert first["deliveryStatus"] == "pending"
    assert first["attempts"] == 1
    await coordinator.close()
    coordinator = create()
    coordinator.journal.retry_delivery(OWNER, operation["id"], clock())
    adapter.acknowledge = False
    await coordinator.deliver_pending()
    assert coordinator.journal.receipt(OWNER, operation["id"])["deliveryStatus"] == "pending"
    coordinator.journal.retry_delivery(OWNER, operation["id"], clock())
    adapter.acknowledge = True
    await coordinator.deliver_pending()
    delivered = coordinator.journal.receipt(OWNER, operation["id"])
    assert delivered["deliveryStatus"] == "delivered"
    assert delivered["attempts"] == 3
    assert delivered["receipt"] == first["receipt"]
    assert coordinator.journal.get_operation(OWNER, operation["id"]) == before
    assert adapter.executions == effects
    assert len({item["receiptId"] for item in adapter.deliveries}) == 1
    assert coordinator.journal.outbox_pending(clock() + 10000) == []


async def test_commit_rechecks_upstream_evidence_before_activation(setup):
    create, clock, adapter = setup
    adapter.denied_check = "commit"
    coordinator = create()
    operation = await submit(coordinator, "prod.request.json")
    done = await terminal(coordinator, clock, operation["id"])
    assert done["state"] == "failed_recovered"
    assert done["commitStatus"] == "not_committed"
    assert adapter.executions[(operation["id"], "activate")] == 0
    assert adapter.executions[(operation["id"], "compensate")] == 1
    assert [phase for _, phase in adapter.checks] == ["validating", "preflight", "commit"]


async def test_default_adapter_fails_closed_without_accepting_operations(tmp_path, monkeypatch):
    monkeypatch.setattr(Coordinator, "start", lambda self: None)
    coordinator = Coordinator(tmp_path)
    try:
        assert coordinator.capabilities()["available"] is False
        assert coordinator.capabilities()["reason"] == "DEPLOYMENT_ADAPTER_UNAVAILABLE"
        with pytest.raises(StudioError) as registration:
            await coordinator.register_release(OWNER, sample("managed-spec.bundle.json"))
        assert registration.value.code == "DEPLOYMENT_ADAPTER_UNAVAILABLE"
        assert registration.value.status == 503
        with pytest.raises(StudioError) as submission:
            await coordinator.submit(OWNER, sample("dev.request.json"))
        assert submission.value.status == 503
        assert coordinator.operations(OWNER) == []
        assert coordinator.journal.outbox_pending(10**10) == []
    finally:
        await coordinator.close()


async def test_new_precommit_recovery_gets_a_fresh_deadline(setup):
    create, clock, adapter = setup
    adapter.responses["prepare_client"] = Observation("waiting_client", code="CLIENT_UNAVAILABLE")
    adapter.responses["compensate"] = Observation("unknown")
    coordinator = create()
    operation = await submit(coordinator)
    waiting = await until(coordinator, clock, operation["id"], lambda op: op["state"] == "waiting_client")
    clock.now = waiting["deadline"] + 1
    await until(coordinator, clock, operation["id"], lambda op: op["phase"] == "compensate" and op["state"] == "reconciling")
    clock.advance(20)
    assert (await terminal(coordinator, clock, operation["id"]))["state"] == "recovery_required"
    recovery = await coordinator.recover(OWNER, operation["id"])
    done = await terminal(coordinator, clock, recovery["id"])
    assert done["state"] == "failed_recovered"
    assert adapter.executions[(recovery["id"], "recover")] == 1
    assert done["commitStatus"] == "not_committed"
    assert coordinator.operation(OWNER, operation["id"])["state"] == "recovery_required"


async def test_unknown_effect_is_inspected_without_blind_replay(setup):
    create, clock, adapter = setup
    coordinator = create()
    operation = await submit(coordinator)
    await until(coordinator, clock, operation["id"], lambda op: op["phase"] == "prepare_backend")
    adapter.effects[(operation["id"], "prepare_backend")] = Observation("unknown")
    await coordinator.process_once(operation["id"])
    assert coordinator.operation(OWNER, operation["id"])["state"] == "reconciling"
    await coordinator.close()
    restarted = create()
    await restarted.process_once(operation["id"])
    assert adapter.executions[(operation["id"], "prepare_backend")] == 0
    assert restarted.operation(OWNER, operation["id"])["state"] == "reconciling"


async def test_each_claim_executes_one_phase_before_releasing_lease(setup):
    create, clock, adapter = setup
    coordinator = create()
    operation = await submit(coordinator)
    await coordinator.process_once(operation["id"])
    assert coordinator.operation(OWNER, operation["id"])["phase"] == "preflight"
    assert adapter.executions == {}
    assert len(adapter.checks) == 1
    await terminal(coordinator, clock, operation["id"])
    fences = [fence for action, _, _, fence in adapter.calls if action == "execute"]
    assert len(set(fences)) == len(fences)


@pytest.mark.parametrize("invalid_kind", ["duplicate_id", "duplicate_required_role", "full_without_endpoints", "unknown_secret"])
async def test_invalid_adapter_components_cannot_poison_terminal_receipt(setup, invalid_kind):
    create, clock, adapter = setup
    components = sample("success.receipt.json")["componentResults"]
    if invalid_kind == "duplicate_id":
        components.append(deepcopy(components[0]))
    elif invalid_kind == "duplicate_required_role":
        duplicate = deepcopy(components[0])
        duplicate["componentId"] = "second-backend"
        components.append(duplicate)
    elif invalid_kind == "full_without_endpoints":
        components = [{**deepcopy(components[2]), "componentId": f"channel-{index}"} for index in range(128)]
    else:
        components[0]["SECRET_TOKEN"] = "SECRET_TOKEN"
    adapter.responses["verify_active"] = Observation("done", tuple(components))
    coordinator = create()
    operation = await submit(coordinator)
    pending = await until(coordinator, clock, operation["id"], lambda op: op["phase"] == "verify_active" and op["state"] == "reconciling")
    assert pending["errorCode"] == "ADAPTER_RESULT_INVALID"
    clock.now = pending["deadline"] + 1
    done = await terminal(coordinator, clock, operation["id"])
    assert done["state"] == "failed_degraded"
    receipt = coordinator.journal.receipt(OWNER, operation["id"])["receipt"]
    assert validate_receipt(receipt) == receipt
    assert len(receipt["componentResults"]) <= 128
    assert "SECRET_TOKEN" not in json.dumps(coordinator.journal.get_operation(OWNER, operation["id"]))


async def test_restart_observes_action_status_without_advancing_release_generation(setup):
    create, clock, adapter = setup
    coordinator = create()
    deployment = await submit(coordinator, "prod.request.json")
    assert (await terminal(coordinator, clock, deployment["id"]))["state"] == "succeeded"
    adapter.responses["verify_active"] = Observation("done", tuple(sample("restart.receipt.json")["componentResults"]))
    operation = await coordinator.submit(OWNER, sample("restart.request.json"))
    done = await terminal(coordinator, clock, operation["id"])
    assert done["state"] == "succeeded"
    assert done["committedGeneration"] == 1
    assert done["previousGeneration"] == 1
    environment = await coordinator.environment(OWNER, operation["target"])
    assert environment["health"] == "healthy"
    assert environment["generation"] == 1
    assert environment["activeReleaseRef"] is not None
    assert adapter.executions[(operation["id"], "manage")] == 1
    assert adapter.executions[(operation["id"], "prepare_backend")] == 0
    receipt = coordinator.journal.receipt(OWNER, operation["id"])["receipt"]
    assert validate_receipt(receipt) == receipt


@pytest.mark.parametrize("kind", ["stop", "uninstall", "purge"])
async def test_management_without_supported_recovery_contract_fails_closed(setup, kind):
    create, clock, adapter = setup
    coordinator = create()
    assert kind not in coordinator.capabilities()["operations"]
    with pytest.raises(StudioError) as rejected:
        await coordinator.submit(OWNER, sample(f"{kind}.request.json"))
    assert rejected.value.code == "DEPLOYMENT_ACTION_UNAVAILABLE"
    assert rejected.value.status == 503
    assert coordinator.operations(OWNER) == []
    assert adapter.executions == {}


async def test_failed_committed_restart_has_a_linked_recovery_path(setup):
    create, clock, adapter = setup
    coordinator = create()
    deployment = await submit(coordinator, "prod.request.json")
    assert (await terminal(coordinator, clock, deployment["id"]))["state"] == "succeeded"
    adapter.responses["manage"] = Observation("failed", code="CLIENT_UNAVAILABLE")
    operation = await coordinator.submit(OWNER, sample("restart.request.json"))
    pending = await until(coordinator, clock, operation["id"], lambda op: op["phase"] == "manage" and op["state"] == "reconciling")
    clock.now = pending["deadline"] + 1
    assert (await terminal(coordinator, clock, operation["id"]))["state"] == "failed_degraded"
    original = deepcopy(coordinator.journal.receipt(OWNER, operation["id"])["receipt"])
    recovery = await coordinator.recover(OWNER, operation["id"])
    done = await terminal(coordinator, clock, recovery["id"])
    assert done["state"] == "succeeded"
    assert done["previousGeneration"] == done["committedGeneration"] == 1
    receipt = coordinator.journal.receipt(OWNER, recovery["id"])["receipt"]
    assert receipt["recoveryOf"] == operation["id"]
    assert validate_receipt(receipt) == receipt
    assert coordinator.journal.receipt(OWNER, operation["id"])["receipt"] == original


@pytest.mark.parametrize("final_phase", ["verify_active", "recover"])
async def test_empty_final_observation_does_not_reuse_earlier_candidate_readiness(setup, final_phase):
    create, clock, adapter = setup
    candidate = tuple(sample("success.receipt.json")["componentResults"])
    adapter.responses["prepare_backend"] = Observation("done", candidate)
    if final_phase == "recover":
        adapter.responses["activate"] = Observation("failed", code="CLIENT_UNAVAILABLE")
    else:
        adapter.responses["verify_active"] = Observation("done")
    coordinator = create()
    operation = await submit(coordinator)
    if final_phase == "recover":
        pending = await until(coordinator, clock, operation["id"], lambda op: op["phase"] == "activate" and op["state"] == "reconciling")
        clock.now = pending["deadline"] + 1
        assert (await terminal(coordinator, clock, operation["id"]))["state"] == "failed_degraded"
        adapter.responses["recover"] = Observation("done")
        operation = await coordinator.recover(OWNER, operation["id"])
    pending = await until(coordinator, clock, operation["id"], lambda op: op["phase"] == final_phase and op["state"] == "reconciling")
    assert coordinator.journal.receipt(OWNER, operation["id"]) is None
    clock.now = pending["deadline"] + 1
    assert (await terminal(coordinator, clock, operation["id"]))["state"] == "failed_degraded"


@pytest.mark.parametrize("channel_problem", ["missing", "extra", "waiting"])
async def test_recovery_cannot_claim_success_with_invalid_required_channels(setup, channel_problem):
    create, clock, adapter = setup
    adapter.responses["activate"] = Observation("failed", code="CHANNEL_NOT_READY")
    coordinator = create()
    operation = await submit(coordinator)
    pending = await until(coordinator, clock, operation["id"], lambda op: op["phase"] == "activate" and op["state"] == "reconciling")
    clock.now = pending["deadline"] + 1
    assert (await terminal(coordinator, clock, operation["id"]))["state"] == "failed_degraded"
    components = sample("success.receipt.json")["componentResults"]
    if channel_problem == "missing":
        components.pop()
    elif channel_problem == "extra":
        components.append({**deepcopy(components[-1]), "componentId": "undeclared-channel"})
    else:
        components[-1]["status"] = "waiting"
    adapter.responses["recover"] = Observation("done", tuple(components))
    recovery = await coordinator.recover(OWNER, operation["id"])
    await coordinator.process_once(recovery["id"])
    pending = coordinator.operation(OWNER, recovery["id"])
    assert pending["state"] == "reconciling"
    assert coordinator.journal.receipt(OWNER, recovery["id"]) is None
    clock.now = pending["deadline"] + 1
    assert (await terminal(coordinator, clock, recovery["id"]))["state"] == "failed_degraded"

@pytest.mark.parametrize('method', ['authorize', 'verify_release'])
async def test_adapter_studio_errors_are_redacted(setup, monkeypatch, method):
    create, clock, adapter = setup
    coordinator = create()

    async def invalid(*args):
        raise StudioError('private-adapter-credential', 403)

    monkeypatch.setattr(adapter, method, invalid)
    with pytest.raises(StudioError) as error:
        if method == 'verify_release':
            await coordinator.register_release(OWNER, sample('managed-spec.bundle.json'))
        else:
            await coordinator.submit(OWNER, sample('dev.request.json'))
    assert error.value.code == 'DEPLOYMENT_AUTHORITY_UNAVAILABLE'
