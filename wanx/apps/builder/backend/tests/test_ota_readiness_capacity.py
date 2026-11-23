"""Capacity failures are bounded refusal, not corrupt customer state."""
from __future__ import annotations

import errno
import hashlib
import json
from pathlib import Path
import sqlite3

import pytest

from wanx_studio import ota_readiness
from wanx_studio.store import Store


def store_at(root, folder=".wanx-app-studio"):
    return Store(root / folder)


def fingerprints(root):
    result = {}
    for path in root.rglob("*"):
        if path.is_file():
            digest = hashlib.sha256()
            with path.open("rb") as stream:
                for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                    digest.update(chunk)
            result[str(path.relative_to(root))] = (path.stat().st_size, digest.hexdigest())
    return result


def test_large_legal_cache_passes_and_late_malformed_event_is_still_checked(tmp_path):
    store = store_at(tmp_path)
    project = store.create("owner", "Capacity fixture", "synthetic", "create")
    cached = json.dumps({**project, "goal": "x" * (1024 * 1024)})
    with store.transaction():
        store.db.executemany("INSERT INTO operations VALUES(?,?,?,?)",
                             (("owner", f"cache-{i}", "digest", cached) for i in range(129)))
    store.append_event("owner", project["id"], "task", {"type": "completed"})
    store.close()
    assert (tmp_path / ".wanx-app-studio/studio.sqlite").stat().st_size > 128 * 1024 * 1024
    before = fingerprints(tmp_path)
    value = ota_readiness.report(tmp_path)
    assert value["stateCompatible"] is True, value
    assert fingerprints(tmp_path) == before
    with sqlite3.connect(tmp_path / ".wanx-app-studio/studio.sqlite") as db:
        db.execute("INSERT INTO task_events VALUES('owner','project','task',2,'not json')")
    before = fingerprints(tmp_path)
    value = ota_readiness.report(tmp_path)
    assert value["stateCompatible"] is False
    assert value["code"] == "BUILDER_OTA_STATE_INVALID"
    assert fingerprints(tmp_path) == before


def test_snapshot_budget_counts_both_stores_and_accepts_exact_boundary(tmp_path, monkeypatch):
    for folder in (".wanx-app-studio", ".wanx-workshop"):
        store_at(tmp_path, folder).close()
    before = fingerprints(tmp_path)
    total = sum(size for size, _ in before.values())
    monkeypatch.setattr(ota_readiness, "SNAPSHOT_BUDGET", total - 1)
    value = ota_readiness.report(tmp_path)
    assert value["code"] == "KAIWU_STATE_SNAPSHOT_BUDGET_EXCEEDED"
    assert value["stateCompatible"] is False
    monkeypatch.setattr(ota_readiness, "SNAPSHOT_BUDGET", total)
    value = ota_readiness.report(tmp_path)
    assert value["stateCompatible"] is True, value
    assert value["counts"]["databases"] == 2
    assert fingerprints(tmp_path) == before


def test_real_store_project_above_old_record_limit_remains_readable(tmp_path):
    store = store_at(tmp_path)
    project = store.create("owner", "Large project", "synthetic", "create")
    project = store.get("owner", project["id"])
    project["goal"] = "x" * (16 * 1024 * 1024 + 1)
    store.save(project)
    store.close()
    before = fingerprints(tmp_path)
    value = ota_readiness.report(tmp_path)
    assert value["stateCompatible"] is True, value
    assert fingerprints(tmp_path) == before


def test_record_byte_budget_is_explicit_and_exact_including_unicode(tmp_path, monkeypatch):
    store = store_at(tmp_path)
    body = json.dumps({"text": "界" * 32}, ensure_ascii=False)
    store.db.execute("INSERT INTO projects VALUES('p','owner',?)", (body,))
    store.close()
    before = fingerprints(tmp_path)
    size = len(body.encode("utf-8"))
    monkeypatch.setattr(ota_readiness, "MAX_BODY", size - 1)
    value = ota_readiness.report(tmp_path)
    assert value["stateCompatible"] is False
    assert value["code"] == "KAIWU_STATE_RECORD_BUDGET_EXCEEDED"
    monkeypatch.setattr(ota_readiness, "MAX_BODY", size)
    assert ota_readiness.report(tmp_path)["stateCompatible"] is True
    assert fingerprints(tmp_path) == before


def test_record_above_supported_64_mib_is_capacity_failure(tmp_path):
    store = store_at(tmp_path)
    # Build one oversized valid JSON record in SQLite, avoiding a giant Python fixture.
    store.db.execute("INSERT INTO projects VALUES('p','owner', '{\"text\":\"' || hex(zeroblob(?)) || '\"}')",
                     (32 * 1024 * 1024 + 1,))
    store.close()
    before = fingerprints(tmp_path)
    value = ota_readiness.report(tmp_path)
    assert value["stateCompatible"] is False
    assert value["code"] == "KAIWU_STATE_RECORD_BUDGET_EXCEEDED"
    assert fingerprints(tmp_path) == before


def test_row_budget_rejects_without_claiming_corruption(tmp_path, monkeypatch):
    store = store_at(tmp_path)
    store.db.executemany("INSERT INTO projects VALUES(?, 'owner', '{}')", [("one",), ("two",)])
    store.close()
    before = fingerprints(tmp_path)
    monkeypatch.setattr(ota_readiness, "MAX_ROWS", 1)
    value = ota_readiness.report(tmp_path)
    assert value["stateCompatible"] is False
    assert value["code"] == "KAIWU_STATE_ROW_BUDGET_EXCEEDED"
    monkeypatch.setattr(ota_readiness, "MAX_ROWS", 2)
    assert ota_readiness.report(tmp_path)["stateCompatible"] is True
    assert fingerprints(tmp_path) == before


def test_snapshot_enospc_cleans_partial_copy_and_keeps_source_unchanged(tmp_path, monkeypatch):
    store_at(tmp_path).close()
    before = fingerprints(tmp_path)
    directories = []
    temporary_directory = ota_readiness.tempfile.TemporaryDirectory
    open_path = Path.open

    def tracked_directory(*args, **kwargs):
        directory = temporary_directory(*args, **kwargs)
        directories.append(Path(directory.name))
        return directory

    class FullDisk:
        def __init__(self, stream):
            self.stream = stream

        def __enter__(self):
            self.stream.__enter__()
            return self

        def __exit__(self, *args):
            return self.stream.__exit__(*args)

        def write(self, chunk):
            self.stream.write(chunk[:16])
            raise OSError(errno.ENOSPC, "synthetic disk full; private text must not escape")

    def failing_open(path, mode="r", *args, **kwargs):
        stream = open_path(path, mode, *args, **kwargs)
        return FullDisk(stream) if path.name == "state.sqlite" and mode == "wb" else stream

    monkeypatch.setattr(ota_readiness.tempfile, "TemporaryDirectory", tracked_directory)
    monkeypatch.setattr(Path, "open", failing_open)
    value = ota_readiness.report(tmp_path)
    assert value["stateCompatible"] is False
    assert value["code"] == "KAIWU_STATE_SNAPSHOT_SPACE_EXHAUSTED"
    assert "private text" not in json.dumps(value)
    assert directories and all(not path.exists() for path in directories)
    assert fingerprints(tmp_path) == before


def test_operation_accumulation_has_its_own_exact_budget(tmp_path, monkeypatch):
    from wanx_studio.deployment.contracts import request_digest
    from wanx_studio.deployment.journal import Journal

    store_at(tmp_path).close()
    journal = Journal(tmp_path / ".wanx-app-studio/deployment")
    request = json.loads((Path(__file__).parent / "fixtures/deployment/dev.request.json").read_text())
    journal.submit("owner", request, request_digest(request), 100, 200)
    request["idempotencyKey"] = "second"
    request["target"]["applicationId"] = "app-demo-second"
    journal.submit("owner", request, request_digest(request), 100, 200)
    journal.close()
    with sqlite3.connect(tmp_path / ".wanx-app-studio/deployment/deployment.sqlite") as db:
        total = db.execute("SELECT sum(length(CAST(body AS BLOB))) FROM deployment_operations").fetchone()[0]
    before = fingerprints(tmp_path)
    monkeypatch.setattr(ota_readiness, "MAX_OPERATION_BYTES", total - 1, raising=False)
    value = ota_readiness.report(tmp_path)
    assert value["stateCompatible"] is False
    assert value["code"] == "KAIWU_STATE_OPERATION_BUDGET_EXCEEDED"
    monkeypatch.setattr(ota_readiness, "MAX_OPERATION_BYTES", total)
    value = ota_readiness.report(tmp_path)
    assert value["stateCompatible"] is True, value
    assert value["counts"]["operations"] == 2
    assert fingerprints(tmp_path) == before


def pin_with_real_writer(root):
    from wanx_studio.deployment.standard_runtime import StandardRuntime

    store = store_at(root)
    store.db.execute("CREATE TABLE deployment_profile_objects(kind TEXT,key TEXT,body TEXT NOT NULL,PRIMARY KEY(kind,key))")

    class Profile:
        @staticmethod
        def object_kind(kind):
            return "expert-" + kind

        def get(self, kind, key):
            row = store.db.execute("SELECT body FROM deployment_profile_objects WHERE kind=? AND key=?", (self.object_kind(kind), key)).fetchone()
            return json.loads(row[0]) if row else None

        def put(self, kind, key, value):
            store.db.execute("INSERT INTO deployment_profile_objects VALUES(?,?,?)", (self.object_kind(kind), key, json.dumps(value)))

    principal = {"owner": "owner", "applicationId": "application", "launchId": "launch"}
    binding = {"generation": 1, "artifactHash": "a" * 64, "operationId": "b" * 32, "base": {"packageSha256": "c" * 64}}
    StandardRuntime.pin(Profile(), principal, binding, create=True)
    store.close()


def test_standard_runtime_launch_pin_written_by_real_writer_is_readable(tmp_path):
    pin_with_real_writer(tmp_path)
    before = fingerprints(tmp_path)
    value = ota_readiness.report(tmp_path)
    assert value["stateCompatible"] is True, value
    assert value["counts"]["profileObjects"] == 1
    assert fingerprints(tmp_path) == before


@pytest.mark.parametrize("problem", ["extra-field", "generation-zero", "generation-bool", "artifact-hash", "operation-id", "package-hash", "plain-kind"])
def test_standard_launch_pin_does_not_allow_malformed_or_unprefixed_records(tmp_path, problem):
    pin_with_real_writer(tmp_path)
    path = tmp_path / ".wanx-app-studio/studio.sqlite"
    with sqlite3.connect(path) as db:
        value = json.loads(db.execute("SELECT body FROM deployment_profile_objects").fetchone()[0])
        if problem == "plain-kind":
            db.execute("UPDATE deployment_profile_objects SET kind='standard-launch'")
        else:
            field, replacement = {
                "extra-field": ("futurePermission", True), "generation-zero": ("generation", 0),
                "generation-bool": ("generation", True), "artifact-hash": ("artifactHash", "short"),
                "operation-id": ("operationId", "x" * 32), "package-hash": ("packageSha256", "z" * 64),
            }[problem]
            value[field] = replacement
            db.execute("UPDATE deployment_profile_objects SET body=?", (json.dumps(value),))
    before = fingerprints(tmp_path)
    assert ota_readiness.report(tmp_path)["stateCompatible"] is False
    assert fingerprints(tmp_path) == before
