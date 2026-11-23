import hashlib
import json
import os
from pathlib import Path
import shutil

import pytest

from test_standard_expert_deployment import write_standard_source
from wanx_studio.contracts import StudioError
from wanx_studio.deployment import intake as module
from wanx_studio.deployment.contracts import canonicalize_json, validate_bundle
from wanx_studio.deployment.intake import PROFILE, ReleaseIntake
from wanx_studio.deployment.expert_runtime import validate_backend
from wanx_studio.store import Store


OWNER = "wanx:7"
OTHER = "wanx:8"
RELEASE = "expert-demo-0.1.0-r1"
ROOT = Path(__file__).resolve().parents[4]


def encode(value):
    return canonicalize_json(value).encode()


def backend_validator(value):
    return validate_backend(value)


def write_source(path, *, version="0.1.0", release_id=RELEASE):
    path.mkdir(parents=True, mode=0o700)
    template = {"resourceId": "synthetic-expert", "version": "0.0.0+sha." + "a" * 12, "digest": "sha256:" + "a" * 64}
    base = {"applicationId": "demo.expert.application", "name": "Synthetic expert", "version": version,
            "manifest": {"schemaVersion": 1, "name": "Synthetic expert", "entry": "src/app.js", "capabilities": ["foundation", "data"], "collections": {"results": {"text": "string"}}},
            "bundle": "var WanxMiniapp={mount(root,api){root.textContent='Synthetic';return ()=>{}}};", "css": "body{color:#111}", "runtimeNamespace": "workshop"}
    base["artifactHash"] = hashlib.sha256(encode(base)).hexdigest()
    values = {
        "backend/expert.json": {"schemaVersion": 1, "format": "wanx-expert-backend-v1", "template": template, "mode": "ask"},
        "client/payload.json": base,
        "support/config.schema.json": {"type": "object", "properties": {}, "additionalProperties": False},
        "support/dependencies.lock.json": {"schemaVersion": 1, "dependencies": [{"kind": "expert-template", **template}]},
        "support/verification.json": {"schemaVersion": 1, "checks": [{"id": "text-roundtrip", "input": {"text": "Reply synthetic proof"}, "expected": {"contains": "synthetic"}}]},
    }
    ids = ["backend-app", "client-app", "config-schema", "dependencies", "verification"]
    artifacts = []
    for i, ((name, value), artifact_id) in enumerate(zip(values.items(), ids)):
        raw = encode(value)
        file = path / name
        file.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        file.write_bytes(raw)
        artifacts.append({"artifactId": artifact_id, "role": "backend" if i == 0 else "client" if i == 1 else "support", "path": name,
                          "mediaType": "application/json", "digest": "sha256:" + hashlib.sha256(raw).hexdigest(), "sizeBytes": len(raw),
                          "platforms": [{"os": "darwin" if i == 1 else "linux", "arch": "arm64" if i == 1 else "x64"}]})
    manifest = {"schemaVersion": 1, "format": "kaiwu-release-directory-v1", "applicationId": base["applicationId"], "version": version, "releaseId": release_id,
                "backend": {"kind": "expert", "profileRef": {"id": PROFILE, "revision": 1}, "artifactId": "backend-app", "template": template},
                "client": {"mode": "install", "artifactId": "client-app"}, "artifacts": artifacts,
                "resources": [{"key": "primaryModel", "kind": "model", "required": True}],
                "configurationArtifactId": "config-schema", "dependencyLockArtifactId": "dependencies", "verificationArtifactId": "verification",
                "data": {"schemaVersion": "1", "upgradePolicy": "compatible", "taskPolicy": "none", "persistentPaths": []}}
    (path / "release.json").write_bytes(encode(manifest))
    return manifest, base


def replace_artifact(path, manifest, name, value):
    raw = encode(value)
    (path / name).write_bytes(raw)
    entry = next(a for a in manifest["artifacts"] if a["path"] == name)
    entry.update(digest="sha256:" + hashlib.sha256(raw).hexdigest(), sizeBytes=len(raw))
    (path / "release.json").write_bytes(encode(manifest))


@pytest.fixture
def setup(tmp_path):
    store = Store(tmp_path / "store")
    intake = ReleaseIntake(store, tmp_path / "inbox", tmp_path / "snapshots", backend_validator=backend_validator, runtime_namespace="studio")
    source = intake.inbox / intake.owner_scope(OWNER) / RELEASE
    manifest, _ = write_standard_source(source, RELEASE)
    base = json.loads((source / "client/payload.json").read_bytes())
    yield store, intake, source, manifest, base
    store.close()


def test_real_directory_freezes_original_identity_and_registers_resolvable_contracts(setup):
    store, intake, source, manifest, base = setup
    frozen = intake.ingest(OWNER, RELEASE)
    assert frozen["owner"] == OWNER
    assert frozen["manifest"] == manifest
    assert frozen["base"] == base
    assert frozen["verification"] == json.loads((source / "support/verification.json").read_text())
    assert frozen["bundle"]["applicationId"] == base["applicationId"]
    assert frozen["bundle"]["releaseId"] == RELEASE
    assert validate_bundle(frozen["bundle"]) == frozen["bundle"]
    assert {a["role"] for a in frozen["bundle"]["artifactDescriptors"]} == {"backend", "client", "assets"}
    assert frozen["bundle"]["provenanceRef"]["digest"] == frozen["directoryDigest"]
    for descriptor in frozen["bundle"]["artifactDescriptors"]:
        incoming = next(a for a in manifest["artifacts"] if a["artifactId"] == descriptor["artifactId"])
        assert intake.resolve_artifact(OWNER, descriptor["sourceRef"]) == (source / incoming["path"]).read_bytes()
        with pytest.raises(StudioError, match="DIRECTORY_ARTIFACT_NOT_FOUND"):
            intake.resolve_artifact(OTHER, descriptor["sourceRef"])
    assert intake.ingest(OWNER, RELEASE) == frozen
    assert store.db.execute("SELECT count(*) FROM projects").fetchone()[0] == 0
    assert intake.list(OTHER) == {"items": []}
    listing = intake.list(OWNER)
    assert listing == {"items": [{"releaseId": RELEASE, "applicationId": manifest["applicationId"], "version": "0.1.0", "profile": PROFILE, "directoryDigest": frozen["directoryDigest"]}]}
    assert str(source) not in json.dumps(listing)


def test_source_removal_and_store_reopen_use_verified_snapshot_not_development_files(setup):
    store, intake, source, _, _ = setup
    frozen = intake.ingest(OWNER, RELEASE)
    root, inbox, snapshots = store.root, intake.inbox, intake.snapshots
    shutil.rmtree(source)
    assert intake.get(OWNER, RELEASE) == frozen
    assert intake.ingest(OWNER, RELEASE) == frozen
    store.close()
    reopened = Store(root)
    try:
        restored = ReleaseIntake(reopened, inbox, snapshots, backend_validator=backend_validator, runtime_namespace="studio")
        assert restored.get(OWNER, RELEASE) == frozen
        descriptor = frozen["bundle"]["artifactDescriptors"][0]
        assert json.loads(restored.resolve_artifact(OWNER, descriptor["sourceRef"])) == frozen["backend"]
    finally:
        reopened.close()


def test_same_release_id_cannot_change_contents_or_cross_owner(setup):
    _, intake, source, manifest, _ = setup
    original = intake.ingest(OWNER, RELEASE)
    changed = {"schemaVersion": 1, "checks": [{"id": "text-roundtrip", "input": {"text": "Changed"}, "expected": {"contains": "changed"}}]}
    replace_artifact(source, manifest, "support/verification.json", changed)
    with pytest.raises(StudioError, match="DIRECTORY_RELEASE_CONFLICT"):
        intake.ingest(OWNER, RELEASE)
    assert intake.get(OWNER, RELEASE) == original
    with pytest.raises(StudioError, match="DIRECTORY_RELEASE_NOT_FOUND"):
        intake.get(OTHER, RELEASE)
    with pytest.raises(StudioError, match="DIRECTORY_RELEASE_NOT_FOUND"):
        intake.ingest(OTHER, RELEASE)


@pytest.mark.parametrize("release_id", ["../outside", "/tmp/source", "a/b", "a\\b", "", "a" * 129, None])
def test_renderer_cannot_select_arbitrary_filesystem_path(setup, release_id):
    _, intake, _, _, _ = setup
    with pytest.raises(StudioError, match="DIRECTORY_RELEASE_INVALID"):
        intake.ingest(OWNER, release_id)


@pytest.mark.parametrize("kind", ["owner", "release", "directory", "file", "hardlink"])
def test_symlinks_and_hardlinks_are_never_followed(setup, tmp_path, kind):
    _, intake, source, _, _ = setup
    if kind == "owner":
        original = source.parent
    elif kind == "release":
        original = source
    elif kind == "directory":
        original = source / "backend"
    else:
        original = source / "backend/expert.json"
    moved = tmp_path / "outside"
    original.rename(moved)
    if kind == "hardlink":
        os.link(moved, original)
    else:
        original.symlink_to(moved, target_is_directory=moved.is_dir())
    with pytest.raises(StudioError, match="DIRECTORY_SOURCE_UNSAFE"):
        intake.ingest(OWNER, RELEASE)
    assert intake.list(OWNER) == {"items": []}


@pytest.mark.parametrize("mutation,code", [
    ("hash", "DIRECTORY_ARTIFACT_CHANGED"), ("size", "DIRECTORY_ARTIFACT_CHANGED"),
    ("duplicate-id", "DIRECTORY_ARTIFACT_INVALID"), ("duplicate-path", "DIRECTORY_ARTIFACT_INVALID"),
    ("relative-path", "DIRECTORY_MANIFEST_INVALID"), ("extra-file", "DIRECTORY_UNDECLARED_FILE"),
    ("extra-field", "DIRECTORY_MANIFEST_INVALID"), ("unpublished-profile", "DIRECTORY_PROFILE_UNSUPPORTED"),
    ("tool-resource", "DIRECTORY_RESOURCE_UNSUPPORTED"), ("task-replay", "DIRECTORY_DATA_UNSUPPORTED"),
    ("client-zip", "DIRECTORY_ARTIFACT_UNSUPPORTED"),
])
def test_incomplete_or_unsupported_directory_fails_before_registration(setup, mutation, code):
    _, intake, source, manifest, _ = setup
    if mutation == "hash":
        manifest["artifacts"][0]["digest"] = "sha256:" + "0" * 64
    elif mutation == "size":
        manifest["artifacts"][0]["sizeBytes"] += 1
    elif mutation == "duplicate-id":
        manifest["artifacts"][1]["artifactId"] = manifest["artifacts"][0]["artifactId"]
    elif mutation == "duplicate-path":
        manifest["artifacts"][1]["path"] = manifest["artifacts"][0]["path"]
    elif mutation == "relative-path":
        manifest["artifacts"][0]["path"] = "../outside"
    elif mutation == "extra-file":
        (source / "unlisted.txt").write_text("not frozen")
    elif mutation == "extra-field":
        manifest["command"] = "run anything"
    elif mutation == "unpublished-profile":
        manifest["backend"]["profileRef"]["id"] = "unknown-runtime"
    elif mutation == "tool-resource":
        manifest["resources"].append({"key": "files", "kind": "files", "required": False})
    elif mutation == "task-replay":
        manifest["data"]["taskPolicy"] = "checkpoint-required"
        manifest["data"]["checkpointArtifactId"] = "verification"
    elif mutation == "client-zip":
        manifest["artifacts"][1]["mediaType"] = "application/zip"
    (source / "release.json").write_bytes(encode(manifest))
    with pytest.raises(StudioError, match=code):
        intake.ingest(OWNER, RELEASE)
    assert intake.list(OWNER) == {"items": []}


@pytest.mark.parametrize("mutation,code", [
    ("identity", "DIRECTORY_CLIENT_IDENTITY_MISMATCH"),
    ("hash", "STANDARD_PACKAGE_INVALID"),
    ("namespace", "STANDARD_EXPERT_CLIENT_INVALID"),
    ("capability", "EXPERT_CLIENT_CAPABILITY_UNSUPPORTED"),
    ("locator", "STANDARD_EXPERT_CLIENT_INVALID"),
    ("contract", "STANDARD_EXPERT_CLIENT_INVALID"),
])
def test_standard_payload_validates_identity_package_and_host_contract(setup, mutation, code):
    _, intake, source, manifest, base = setup
    if mutation == "identity":
        manifest["applicationId"] = "different.app"
    elif mutation == "hash":
        base["packageSha256"] = "0" * 64
    elif mutation == "namespace":
        base["runtimeNamespace"] = "workshop"
    elif mutation == "capability":
        base["manifest"]["capabilities"].append("files")
    elif mutation == "contract":
        base["runtimeContract"]["collections"] = {"results": {"text": "string"}}
    elif mutation == "locator":
        base["sourceDir"] = "/private/synthetic"
    replace_artifact(source, manifest, "client/payload.json", base)
    with pytest.raises(StudioError, match=code):
        intake.ingest(OWNER, RELEASE)
    assert intake.list(OWNER) == {"items": []}


@pytest.mark.parametrize("mutation,code", [("template", "DIRECTORY_BACKEND_INVALID"), ("mode", "DIRECTORY_BACKEND_INVALID"), ("lock", "DIRECTORY_DEPENDENCY_INVALID"), ("config", "DIRECTORY_CONFIGURATION_UNSUPPORTED"), ("verification", "DIRECTORY_VERIFICATION_INVALID")])
def test_backend_and_support_contracts_cannot_hide_unpinned_or_arbitrary_behavior(setup, mutation, code):
    _, intake, source, manifest, _ = setup
    path = "backend/expert.json"
    value = json.loads((source / path).read_text())
    if mutation == "template":
        value["template"]["resourceId"] = "different-template"
    elif mutation == "mode":
        value["mode"] = "act"
    elif mutation == "lock":
        path = "support/dependencies.lock.json"
        value = {"schemaVersion": 1, "dependencies": []}
    elif mutation == "config":
        path = "support/config.schema.json"
        value = {"type": "object"}
    elif mutation == "verification":
        path = "support/verification.json"
        value = {"schemaVersion": 1, "checks": []}
    replace_artifact(source, manifest, path, value)
    with pytest.raises(StudioError, match=code):
        intake.ingest(OWNER, RELEASE)


def test_snapshot_tampering_and_reference_digest_mismatch_fail_closed(setup):
    store, intake, _, _, _ = setup
    frozen = intake.ingest(OWNER, RELEASE)
    descriptor = frozen["bundle"]["artifactDescriptors"][0]
    with pytest.raises(StudioError, match="DIRECTORY_ARTIFACT_NOT_FOUND"):
        intake.resolve_artifact(OWNER, {**descriptor["sourceRef"], "digest": "sha256:" + "0" * 64})
    snapshot = store.db.execute("SELECT snapshot FROM directory_releases").fetchone()[0]
    file = intake.snapshots / intake.owner_scope(OWNER) / snapshot / "backend/expert.json"
    file.chmod(0o600)
    file.write_text("changed")
    with pytest.raises(StudioError, match="DIRECTORY_ARTIFACT_CHANGED"):
        intake.get(OWNER, RELEASE)
    with pytest.raises(StudioError, match="DIRECTORY_ARTIFACT_CHANGED"):
        intake.resolve_artifact(OWNER, descriptor["sourceRef"])


def test_frozen_verification_is_recovered_from_snapshot_and_registered_body_tampering_is_rejected(setup):
    store, intake, source, _, _ = setup
    frozen = intake.ingest(OWNER, RELEASE)
    expected = json.loads((source / "support/verification.json").read_text())
    assert frozen["verification"] == expected
    shutil.rmtree(source)
    assert intake.get(OWNER, RELEASE)["verification"] == expected
    body = json.loads(store.db.execute("SELECT body FROM directory_releases WHERE owner=? AND release_id=?", (OWNER, RELEASE)).fetchone()[0])
    body["verification"]["checks"][0]["expected"]["contains"] = "forged-success"
    with store.transaction():
        store.db.execute("UPDATE directory_releases SET body=? WHERE owner=? AND release_id=?", (json.dumps(body), OWNER, RELEASE))
    with pytest.raises(StudioError, match="DIRECTORY_SNAPSHOT_CHANGED"):
        intake.get(OWNER, RELEASE)


def test_a_file_mutated_during_read_never_enters_the_snapshot(setup, monkeypatch):
    _, intake, source, _, _ = setup
    target = source / "client/payload.json"
    target_inode = target.stat().st_ino
    original = module.os.read
    changed = False
    def read(fd, size):
        nonlocal changed
        result = original(fd, size)
        if not changed and os.fstat(fd).st_ino == target_inode:
            changed = True
            with target.open("ab") as file:
                file.write(b" ")
        return result
    monkeypatch.setattr(module.os, "read", read)
    with pytest.raises(StudioError, match="DIRECTORY_SOURCE_CHANGED"):
        intake.ingest(OWNER, RELEASE)
    assert changed and intake.list(OWNER) == {"items": []}


def test_file_swapped_for_fifo_after_directory_walk_fails_without_blocking(setup, monkeypatch):
    _, intake, source, _, _ = setup
    original = intake._tree
    swapped = False
    def tree(*args, **kwargs):
        nonlocal swapped
        result = original(*args, **kwargs)
        if not swapped:
            swapped = True
            file = source / "client/payload.json"
            file.unlink()
            os.mkfifo(file, 0o600)
        return result
    monkeypatch.setattr(intake, "_tree", tree)
    with pytest.raises(StudioError, match="DIRECTORY_SOURCE_UNSAFE"):
        intake.ingest(OWNER, RELEASE)


def test_empty_directory_flood_is_bounded_before_registration(setup):
    _, intake, source, _, _ = setup
    for i in range(260):
        (source / ("empty-" + str(i))).mkdir()
    with pytest.raises(StudioError, match="DIRECTORY_SIZE_INVALID"):
        intake.ingest(OWNER, RELEASE)


def test_recovery_adopts_only_a_matching_snapshot_left_before_sqlite_commit(setup):
    store, intake, _, _, _ = setup
    original = store.db
    class Crash:
        failed = False
        def execute(self, sql, *args):
            if sql.startswith("INSERT INTO directory_releases") and not self.failed:
                self.failed = True
                raise OSError("injected before directory registration commit")
            return original.execute(sql, *args)
        def __getattr__(self, key):
            return getattr(original, key)
    store.db = Crash()
    try:
        with pytest.raises(OSError):
            intake.ingest(OWNER, RELEASE)
        assert intake.list(OWNER) == {"items": []}
        frozen = intake.ingest(OWNER, RELEASE)
        assert intake.get(OWNER, RELEASE) == frozen
        assert original.execute("SELECT count(*) FROM directory_releases").fetchone()[0] == 1
        assert len([p for p in (intake.snapshots / intake.owner_scope(OWNER)).iterdir()]) == 1
    finally:
        store.db = original


def test_duplicate_json_keys_are_rejected_before_schema_or_digest_interpretation(setup):
    _, intake, source, _, _ = setup
    raw = (source / "release.json").read_text()
    (source / "release.json").write_text(raw.replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1', 1))
    with pytest.raises(StudioError, match="DIRECTORY_JSON_INVALID"):
        intake.ingest(OWNER, RELEASE)


def test_credentials_hidden_in_release_metadata_are_not_frozen_or_listed(setup):
    _, intake, source, manifest, _ = setup
    manifest["resources"][0]["key"] = "sk-" + "x" * 32 # Synthetic secret-shaped input.
    (source / "release.json").write_bytes(encode(manifest))
    with pytest.raises(StudioError, match="INPUT_CREDENTIAL_DETECTED"):
        intake.ingest(OWNER, RELEASE)
    assert intake.list(OWNER) == {"items": []}


@pytest.mark.parametrize("path,key,value,code", [
    ("backend/expert.json", "schemaVersion", True, "DIRECTORY_BACKEND_INVALID"),
    ("support/dependencies.lock.json", "schemaVersion", True, "DIRECTORY_DEPENDENCY_INVALID"),
    ("support/config.schema.json", "additionalProperties", 0, "DIRECTORY_CONFIGURATION_UNSUPPORTED"),
    ("support/verification.json", "schemaVersion", True, "DIRECTORY_VERIFICATION_INVALID"),
])
def test_json_boolean_integer_aliases_do_not_bypass_internal_contracts(setup, path, key, value, code):
    _, intake, source, manifest, _ = setup
    body = json.loads((source / path).read_text())
    body[key] = value
    replace_artifact(source, manifest, path, body)
    with pytest.raises(StudioError, match=code):
        intake.ingest(OWNER, RELEASE)


def test_vendored_directory_contract_and_documented_client_contract_match():
    docs = ROOT / "docs/applications/kaiwu-deployment-delivery"
    packaged = Path(module.__file__).parent / "schemas"
    source = json.loads((docs / "release-directory.schema.json").read_text())
    target = json.loads((packaged / "release-directory.schema.json").read_text())
    target.pop("$comment")
    assert source == target
    assert json.loads((packaged / "client-payload.schema.json").read_text()) == json.loads((docs / "expert-profile/client-payload.schema.json").read_text())
    backend = json.loads((packaged / "expert-backend.schema.json").read_text())
    assert backend == json.loads((docs / "expert-profile/backend.schema.json").read_text())
    lock = json.loads((docs / "expert-profile/dependency-lock.schema.json").read_text())
    for field, contract in backend["properties"]["template"]["properties"].items():
        assert lock["properties"]["dependencies"]["items"]["properties"][field] == contract
