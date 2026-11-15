import json
from copy import deepcopy

import pytest
from test_studio import ROOT, op
from test_workshop import source
from wanx_studio.contracts import StudioError
from wanx_studio.service import StudioService
from wanx_studio.versions import next_version, state
from wanx_studio.workshop import PersonalWorkshop
from wanx_studio.workshop_management import catalog, manage, protections

async def test_project_trash_preserves_files_until_purge_reclaims_disk_bytes(sample):
    svc, p = sample
    task_dir = svc.store.root / "tasks" / p["tasks"][0]["id"]
    task_dir.mkdir(parents=True, exist_ok=True)
    (task_dir / "synthetic-build-cache.bin").write_bytes(b"t" * (2 * 1024 * 1024))
    edit_id = "synthetic-purge-space"
    edit_dir = svc.store.root / "edits" / edit_id
    edit_dir.mkdir(parents=True)
    (edit_dir / "synthetic-edit-cache.bin").write_bytes(b"e" * (2 * 1024 * 1024))
    p.setdefault("_edits", {}).setdefault("items", []).append(
        {"id": edit_id, "state": "completed"}
    )
    p["_synthetic_purge_blob"] = "x" * (2 * 1024 * 1024)
    svc.store.save(p)
    archived = manage(svc, "alice", p["id"], request(p, "delete"))["project"]
    assert archived["deletedAt"]
    assert task_dir.exists() and edit_dir.exists()
    svc.store.db.execute("PRAGMA wal_checkpoint(TRUNCATE)")

    def disk_bytes():
        return sum(f.stat().st_size for f in svc.store.root.rglob("*") if f.is_file())

    before = disk_bytes()
    p = svc.store.get("alice", p["id"])
    body = request(p, "purge")
    result = manage(svc, "alice", p["id"], body)
    after = disk_bytes()
    assert result["purged"]
    assert not task_dir.exists() and not edit_dir.exists()
    assert before - after > 5 * 1024 * 1024
    assert catalog(svc, "alice")["projects"] == []
    assert manage(svc, "alice", p["id"], body)["purged"]



@pytest.fixture
async def sample(tmp_path):
    original = StudioService(tmp_path / "original", ROOT)
    from wanx_studio.runner import Runner

    original.runner = Runner(original)
    service = PersonalWorkshop(tmp_path / "workshop", ROOT)
    p = await service.copy_source(
        "alice", {"operationId": op(), "name": "管理验证", "source": await source(original)}
    )
    # Restore creates genuine immutable compiled copies, without model/network use.
    for _ in range(3):
        p = service.store.get("alice", p["id"])
        check = service.versions.restore_check("alice", p["id"], p["artifacts"][-1]["hash"])
        service.versions.restore(
            "alice", p["id"], {**check, "operationId": op(), "confirmedByUser": True}, trial=True
        )
    yield service, service.store.get("alice", p["id"])
    await service.close()
    await original.close()


def request(p, action, **extra):
    return {
        "operationId": op(),
        "expectedRevision": state(p)["revision"],
        "action": action,
        "confirmedByUser": True,
        **extra,
    }


async def test_prune_disk_sources_retries_monotonic_and_data_preserved(sample):
    svc, p = sample
    a = p["artifacts"][1]
    folder = svc.store.root / "tasks" / a["taskId"]
    folder.mkdir(parents=True)
    (folder / "sources.json").write_text("large source")
    svc.store.db.execute(
        "INSERT INTO records VALUES(?,?,?,?,?,?,?)",
        ("alice", p["appId"], "production", "items", "r", 1, '{"title":"keep"}'),
    )
    token = svc.open_runtime("alice", p["id"], a["hash"], "preview")["session"]
    body = request(p, "clean-version", artifactHash=a["hash"])
    result = manage(svc, "alice", p["id"], body)
    assert result["cleanedBytes"] > 0 and len(result["project"]["artifacts"]) == 3
    assert not folder.exists() and token not in svc.runtime_sessions
    assert manage(svc, "alice", p["id"], body)["cleanedBytes"] == result["cleanedBytes"]
    after = svc.store.get("alice", p["id"])
    assert next_version(after) == "0.1.4"
    assert svc.store.db.execute("SELECT count(*) FROM records").fetchone()[0] == 1
    assert a["files"]["src/app.js"] not in json.dumps(after["_cleanedVersions"])
    assert svc.versions.read("alice", p["id"], p["artifacts"][2]["hash"])["changes"][
        "baselineCleaned"
    ]
    cached = svc.store.db.execute(
        "SELECT result FROM operations WHERE owner=?", ("alice",)
    ).fetchall()
    assert all(
        a["hash"] not in [x["hash"] for x in json.loads(row[0]).get("artifacts", [])]
        for row in cached
    )
    with pytest.raises(StudioError, match="OPERATION_CONFLICT"):
        manage(svc, "alice", p["id"], {**body, "artifactHash": p["artifacts"][0]["hash"]})


async def test_protect_latest_adopted_installed_retry_and_active(sample):
    svc, p = sample
    p["installed"] = {"artifactHash": p["artifacts"][0]["hash"], "version": "0.1.0"}
    p["versioning"]["adoptedHash"] = p["artifacts"][1]["hash"]
    p["_edits"]["items"] = [
        {"id": op(), "state": "interrupted", "baseHash": p["artifacts"][2]["hash"]}
    ]
    svc.store.save(p)
    assert len(protections(p)) == 4
    for a in p["artifacts"]:
        with pytest.raises(StudioError, match="WORKSHOP_VERSION_PROTECTED"):
            manage(svc, "alice", p["id"], request(p, "clean-version", artifactHash=a["hash"]))
    p["_edits"]["items"][0]["state"] = "queued"
    svc.store.save(p)
    with pytest.raises(StudioError, match="BUILD_ACTIVE"):
        manage(svc, "alice", p["id"], request(p, "delete"))


async def test_archive_restore_and_purge_are_owner_scoped_and_preserve_records(sample):
    svc, p = sample
    baseline = deepcopy(p["artifacts"])
    with pytest.raises(StudioError, match="PROJECT_NOT_FOUND"):
        manage(svc, "bob", p["id"], request(p, "delete"))
    with pytest.raises(StudioError, match="WORKSHOP_ARCHIVE_REQUIRED"):
        manage(svc, "alice", p["id"], request(p, "purge"))
    archived = manage(svc, "alice", p["id"], request(p, "delete"))["project"]
    assert archived["deletedAt"] and catalog(svc, "alice")["projects"][0]["deletedAt"]
    # Archiving doesn't break an already installed app's runtime or data.
    p = svc.store.get("alice", p["id"])
    p["installed"] = {"artifactHash": baseline[0]["hash"], "version": "0.1.0"}
    svc.store.save(p)
    token = svc.open_installed_runtime("alice", p["appId"], baseline[0]["hash"], "production")[
        "session"
    ]
    await svc.invoke(
        "alice", token, "data.put", {"collection": "items", "value": {"title": "保留"}}
    )
    with pytest.raises(StudioError, match="WORKSHOP_INSTALLED_PROJECT"):
        manage(svc, "alice", p["id"], request(p, "purge"))
    restored = manage(svc, "alice", p["id"], request(p, "restore"))["project"]
    assert not restored["deletedAt"]
    p = svc.store.get("alice", p["id"])
    assert p["artifacts"] == baseline
    p["installed"] = None
    svc.store.save(p)
    manage(svc, "alice", p["id"], request(p, "delete"))
    p = svc.store.get("alice", p["id"])
    body = request(p, "purge")
    assert manage(svc, "alice", p["id"], body)["purged"]
    assert manage(svc, "alice", p["id"], body)["purged"]
    assert svc.store.list("alice") == []
    assert svc.store.db.execute("SELECT count(*) FROM records").fetchone()[0] == 1
    assert not svc.runtime_sessions
    # A delayed source-copy retry is a tombstone, never a new duplicate project.
    assert all(
        json.loads(r[0]).get("purged")
        for r in svc.store.db.execute("SELECT result FROM operations")
    )


async def test_stale_revision_and_confirmation_and_schema_audit(sample):
    svc, p = sample
    a = p["artifacts"][0]
    with pytest.raises(StudioError, match="VERSION_CHANGED"):
        manage(svc, "alice", p["id"], {**request(p, "delete"), "expectedRevision": 999})
    with pytest.raises(StudioError, match="USER_CLEANUP_REQUIRED"):
        manage(
            svc,
            "alice",
            p["id"],
            {**request(p, "clean-version", artifactHash=a["hash"]), "confirmedByUser": False},
        )
    p["versioning"]["adoptions"].append(
        {"artifactHash": a["hash"], "at": 1, "source": "user-adoption"}
    )
    svc.store.save(p)
    manage(svc, "alice", p["id"], request(p, "clean-version", artifactHash=a["hash"]))
    from wanx_studio.versions import compatible_restore

    after = svc.store.get("alice", p["id"])
    bad = deepcopy(after["artifacts"][-1]["manifest"])
    bad["collections"]["items"]["title"] = "number"
    assert not compatible_restore(after, bad)
