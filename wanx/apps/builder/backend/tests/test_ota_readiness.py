from __future__ import annotations

import json
from pathlib import Path
import sqlite3
import subprocess
import sys

import pytest

from wanx_studio.ota_readiness import report
from wanx_studio.store import Store
from wanx_studio.deployment.journal import Journal
from wanx_studio.deployment.contracts import bundle_digest


def populated(root):
    for folder in (".wanx-app-studio", ".wanx-workshop"):
        store = Store(root / folder)
        store.db.execute("CREATE TABLE deployment_profile_objects(kind TEXT,key TEXT,body TEXT NOT NULL,PRIMARY KEY(kind,key))")
        store.db.execute("CREATE TABLE deployment_expert_runs(id TEXT PRIMARY KEY,owner TEXT NOT NULL,scope TEXT NOT NULL,operation_id TEXT NOT NULL,input_digest TEXT NOT NULL,body TEXT NOT NULL,UNIQUE(owner,scope,operation_id))")
        store.close()
        journal = Journal(root / folder / "deployment")
        journal.close()
    return root


def snapshot(root):
    return {str(path.relative_to(root)): path.read_bytes() for path in root.rglob("*") if path.is_file()}


def test_empty_does_not_create_state(tmp_path):
    before = snapshot(tmp_path)
    value = report(tmp_path)
    assert value["stateCompatible"] is True
    assert value["statePresent"] is False
    assert "applicationReady" not in value
    assert snapshot(tmp_path) == before


def test_real_stores_and_journals_non_ascii_root_are_read_only(tmp_path):
    root = populated(tmp_path / "盒子 空间")
    before = snapshot(root)
    value = report(root)
    assert value["schemaVersion"] == value["protocol"] == 1
    assert value["statePresent"] is True
    assert value["stateCompatible"] is True
    assert value["counts"]["databases"] == 4
    assert snapshot(root) == before


@pytest.mark.parametrize("folder", [".wanx-app-studio", ".wanx-workshop"])
def test_corrupt_existing_store_is_not_reported_as_empty(tmp_path, folder):
    parent = tmp_path / folder
    parent.mkdir()
    (parent / "studio.sqlite").write_bytes(b"not sqlite")
    value = report(tmp_path)
    assert value["statePresent"] is True
    assert value["stateCompatible"] is False
    assert value["code"] == "BUILDER_OTA_STATE_INVALID"


def test_symlink_is_rejected(tmp_path):
    outside = tmp_path / "outside"
    outside.mkdir()
    (tmp_path / ".wanx-workshop").symlink_to(outside, target_is_directory=True)
    assert report(tmp_path)["stateCompatible"] is False


def test_future_schema_and_unknown_table_are_rejected(tmp_path):
    root = populated(tmp_path)
    path = root / ".wanx-workshop" / "studio.sqlite"
    with sqlite3.connect(path) as db:
        db.execute("PRAGMA user_version=2")
    assert report(root)["code"] == "BUILDER_OTA_STATE_INCOMPATIBLE"
    with sqlite3.connect(path) as db:
        db.execute("PRAGMA user_version=0")
        db.execute("CREATE TABLE future_state(body TEXT)")
    assert report(root)["stateCompatible"] is False


def test_malformed_profile_json_and_future_expert_state_are_rejected(tmp_path):
    root = populated(tmp_path)
    path = root / ".wanx-workshop" / "studio.sqlite"
    with sqlite3.connect(path) as db:
        db.execute("INSERT INTO deployment_profile_objects VALUES('binding','s','not json')")
    assert report(root)["stateCompatible"] is False
    with sqlite3.connect(path) as db:
        db.execute("DELETE FROM deployment_profile_objects")
        db.execute("INSERT INTO deployment_expert_runs VALUES('r','secret-owner','s','op','digest',?)", (json.dumps({"state": "future-state"}),))
    value = report(root)
    assert value["stateCompatible"] is False
    assert "secret-owner" not in json.dumps(value)


def test_unsupported_runtime_in_saved_release_is_rejected(tmp_path):
    root = populated(tmp_path)
    fixture = Path(__file__).parent / "fixtures/deployment/packaged-app.bundle.json"
    bundle = json.loads(fixture.read_text())
    bundle["runtimeRequirements"]["runtimeRef"] = {"id": "future-runtime", "revision": 1}
    bundle["bundleDigest"] = bundle_digest(bundle)
    path = root / ".wanx-app-studio/deployment/deployment.sqlite"
    with sqlite3.connect(path) as db:
        db.execute("INSERT INTO deployment_releases VALUES(?,?,?,?,?)", ("secret", bundle["applicationId"], bundle["releaseId"], bundle["bundleDigest"], json.dumps(bundle)))
    assert report(root)["code"] == "BUILDER_OTA_STATE_INCOMPATIBLE"


def test_registry_conflict_is_rejected(tmp_path):
    root = populated(tmp_path)
    with sqlite3.connect(root / ".wanx-deployment-sources.sqlite") as db:
        db.execute("CREATE TABLE deployment_sources(slot TEXT PRIMARY KEY,owner TEXT NOT NULL,target TEXT NOT NULL,source TEXT NOT NULL)")
        db.execute("INSERT INTO deployment_sources VALUES('s','secret','{}','conflict')")
    assert report(root)["stateCompatible"] is False


def test_pending_expert_run_is_not_application_readiness(tmp_path):
    root = populated(tmp_path)
    with sqlite3.connect(root / ".wanx-app-studio/studio.sqlite") as db:
        db.execute("INSERT INTO deployment_expert_runs VALUES('r','owner','s','op','digest',?)", (json.dumps({"state": "running"}),))
    value = report(root)
    assert value["stateCompatible"] is True
    assert value["counts"]["activeExpertRuns"] == 1
    assert "applicationReady" not in value


def test_cli_modes_and_self_test_are_bounded(tmp_path):
    for args in (["--root", str(tmp_path), "--mode", "compatibility"], ["--root", str(tmp_path), "--mode", "inventory"], ["--self-test"]):
        proc = subprocess.run([sys.executable, "-m", "wanx_studio.ota_readiness", *args], capture_output=True, text=True)
        assert proc.returncode == 0, proc.stderr
        assert len(proc.stdout) < 4096
        assert json.loads(proc.stdout)["protocol"] == 1


def test_snapshot_budget_is_explicit_and_never_truncates_original_state(tmp_path, monkeypatch):
    from wanx_studio import ota_readiness
    root = populated(tmp_path)
    before = snapshot(root)
    monkeypatch.setattr(ota_readiness, "SNAPSHOT_BUDGET", 1)
    value = report(root)
    assert value["stateCompatible"] is False
    assert value["code"] == "KAIWU_STATE_SNAPSHOT_BUDGET_EXCEEDED"
    assert snapshot(root) == before


def test_live_wal_rows_are_read_without_mutating_original_sidecars(tmp_path):
    root = populated(tmp_path)
    store = Store(root / ".wanx-workshop")
    store.db.execute("INSERT INTO deployment_expert_runs VALUES('r','owner','s','op','d',?)", (json.dumps({"state": "running"}),))
    before = snapshot(root)
    try:
        value = report(root)
        assert value["stateCompatible"] is True
        assert value["counts"]["activeExpertRuns"] == 1
        assert snapshot(root) == before
    finally:
        store.close()


@pytest.mark.parametrize("profile", ["wanx-miniapp-v1", "wanx-expert-app-v1"])
def test_current_runtime_releases_remain_compatible(tmp_path, profile):
    root = populated(tmp_path)
    bundle = json.loads((Path(__file__).parent / "fixtures/deployment/packaged-app.bundle.json").read_text())
    bundle["runtimeRequirements"]["runtimeRef"] = {"id": profile, "revision": 1}
    bundle["runtimeRequirements"]["dataCompatibilityRef"] = {"id": "miniapp-schema-additive-v1" if profile == "wanx-miniapp-v1" else "expert-app-additive-v1", "revision": 1}
    bundle["runtimeRequirements"]["healthContractRef"] = {"id": profile if profile == "wanx-miniapp-v1" else profile + "-health", "revision": 1}
    bundle["bundleDigest"] = bundle_digest(bundle)
    path = root / ".wanx-workshop/deployment/deployment.sqlite"
    with sqlite3.connect(path) as db:
        db.execute("INSERT INTO deployment_releases VALUES(?,?,?,?,?)", ("owner", bundle["applicationId"], bundle["releaseId"], bundle["bundleDigest"], json.dumps(bundle)))
    value = report(root)
    assert value["stateCompatible"] is True
    assert value["counts"]["releases"] == 1


def test_binding_source_claims_must_match_registry(tmp_path):
    from wanx_studio.deployment.source_registry import SourceRegistry
    root = populated(tmp_path)
    target = {"organizationId": "organization", "boxId": "box", "applicationId": "app", "environment": "prod"}
    owner = "wanx:1"
    slot, encoded = SourceRegistry._identity("studio", owner, target)
    with sqlite3.connect(root / ".wanx-app-studio/studio.sqlite") as db:
        db.execute("INSERT INTO deployment_profile_objects VALUES('binding','slot',?)", (json.dumps({"owner": owner, "target": target, "generation": 1, "state": "active"}),))
    assert report(root)["stateCompatible"] is False
    with sqlite3.connect(root / ".wanx-deployment-sources.sqlite") as db:
        db.execute("CREATE TABLE deployment_sources(slot TEXT PRIMARY KEY,owner TEXT NOT NULL,target TEXT NOT NULL,source TEXT NOT NULL)")
        db.execute("INSERT INTO deployment_sources VALUES(?,?,?,?)", (slot, owner, encoded, "studio"))
    assert report(root)["stateCompatible"] is True
    with sqlite3.connect(root / ".wanx-deployment-sources.sqlite") as db:
        db.execute("UPDATE deployment_sources SET source='workshop'")
    assert report(root)["stateCompatible"] is False


def recovery_journal(root):
    from wanx_studio.deployment.coordinator import Coordinator
    from wanx_studio.deployment.contracts import request_digest
    populated(root)
    coordinator = Coordinator(root / ".wanx-app-studio/deployment", clock=lambda: 100.0)
    request = json.loads((Path(__file__).parent / "fixtures/deployment/dev.request.json").read_text())
    op = coordinator.journal.submit("owner", request, request_digest(request), 100, 200)
    claimed = coordinator.journal.claim(op["id"], coordinator.worker_id, 100, 45)
    claimed["errorCode"] = "ADAPTER_UNCERTAIN"
    coordinator._finish(claimed, "recovery_required")
    recovery = coordinator.journal.create_recovery("owner", op["id"], 100, 200)
    return coordinator, op, recovery


def test_real_journal_recovery_request_is_readable_and_preserves_bytes(tmp_path):
    coordinator, original, recovery = recovery_journal(tmp_path)
    assert recovery["request"]["kind"] == "recover"
    assert recovery["recoveryOf"] == original["id"]
    coordinator.journal.close()
    before = snapshot(tmp_path)
    value = report(tmp_path)
    assert value["stateCompatible"] is True, value
    assert value["counts"]["operations"] == 2
    assert value["counts"]["pendingDeployments"] == 1
    assert snapshot(tmp_path) == before


@pytest.mark.parametrize("problem", ["missing-original", "cycle", "extra-request-field", "wrong-recovery-of", "changed-reference"])
def test_recovery_requests_cannot_bypass_public_contract_or_original_chain(tmp_path, problem):
    coordinator, original, recovery = recovery_journal(tmp_path)
    coordinator.journal.close()
    path = tmp_path / ".wanx-app-studio/deployment/deployment.sqlite"
    if problem == "cycle":
        recovery["recoveryOf"] = recovery["request"]["recoveryOf"] = recovery["id"]
    elif problem == "extra-request-field":
        recovery["request"]["futurePermission"] = True
    elif problem == "wrong-recovery-of":
        recovery["request"]["recoveryOf"] = "different-original"
    elif problem == "changed-reference":
        recovery["request"]["decisionRef"] = {"id": "replacement-decision", "revision": 1}
    with sqlite3.connect(path) as db:
        db.execute("UPDATE deployment_operations SET body=? WHERE id=?", (json.dumps(recovery), recovery["id"]))
        if problem == "missing-original":
            db.execute("DELETE FROM deployment_operations WHERE id=?", (original["id"],))
    assert report(tmp_path)["stateCompatible"] is False


def test_recovery_of_a_failed_recovery_keeps_its_public_kind(tmp_path):
    coordinator, original, recovery = recovery_journal(tmp_path)
    claimed = coordinator.journal.claim(recovery["id"], coordinator.worker_id, 100, 45)
    coordinator._finish(claimed, "recovery_required")
    again = coordinator.journal.create_recovery("owner", recovery["id"], 100, 200)
    assert again["recoveryOf"] == recovery["id"]
    coordinator.journal.close()
    assert report(tmp_path)["stateCompatible"] is True


@pytest.mark.parametrize("field", ["dataCompatibilityRef", "healthContractRef"])
def test_profile_release_rejects_unknown_data_or_health_contract_revision(tmp_path, field):
    root = populated(tmp_path)
    bundle = json.loads((Path(__file__).parent / "fixtures/deployment/packaged-app.bundle.json").read_text())
    bundle["runtimeRequirements"].update(runtimeRef={"id": "wanx-miniapp-v1", "revision": 1},
        dataCompatibilityRef={"id": "miniapp-schema-additive-v1", "revision": 1},
        healthContractRef={"id": "wanx-miniapp-v1", "revision": 1})
    bundle["bundleDigest"] = bundle_digest(bundle)
    path = root / ".wanx-workshop/studio.sqlite"
    with sqlite3.connect(path) as db:
        db.execute("INSERT INTO deployment_profile_objects VALUES('release','r',?)", (json.dumps({"bundle": bundle}),))
    assert report(root)["stateCompatible"] is True
    bundle["runtimeRequirements"][field]["revision"] = 2
    bundle["bundleDigest"] = bundle_digest(bundle)
    with sqlite3.connect(path) as db:
        db.execute("UPDATE deployment_profile_objects SET body=?", (json.dumps({"bundle": bundle}),))
    assert report(root)["stateCompatible"] is False


@pytest.mark.parametrize("health", ["stopped", "uninstalled"])
def test_known_management_terminal_environment_health_is_supported(tmp_path, health):
    root = populated(tmp_path)
    value = {"target": {"organizationId": "org", "boxId": "box", "applicationId": "app", "environment": "dev"},
             "health": health, "generation": 1}
    with sqlite3.connect(root / ".wanx-app-studio/deployment/deployment.sqlite") as db:
        db.execute("INSERT INTO deployment_environments VALUES('environment',?)", (json.dumps(value),))
    assert report(root)["stateCompatible"] is True
