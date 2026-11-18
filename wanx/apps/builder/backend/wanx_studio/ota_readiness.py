"""Bounded, read-only compatibility inspection of existing Builder state.

This reports state readability, never application health or model availability.
The caller must fence both editor stores while taking a cross-database snapshot.
"""
from __future__ import annotations

import argparse
from contextlib import contextmanager
import errno
import json
import os
from pathlib import Path
import re
import sqlite3
import stat
import tempfile

PROTOCOL = 1
MAX_ROWS = 100000
# Resource limits of this inspector, not limits on what Store may persist.
# Callers must provision scratch for DB/WAL copies plus SQLite sidecars.
MAX_BODY = 64 * 1024 * 1024
MAX_OPERATION_BYTES = 64 * 1024 * 1024
SNAPSHOT_BUDGET = 2 * 1024 * 1024 * 1024
PROFILES = {"wanx-miniapp-v1", "wanx-expert-app-v1"}
TERMINAL_RUNS = {"succeeded", "failed", "cancelled", "interrupted"}
RUN_STATES = TERMINAL_RUNS | {"queued", "running", "cancel_requested"}
OP_STATES = {"queued", "preflight", "preparing", "committing", "verifying", "blocked", "waiting_box", "waiting_client", "reconciling", "compensating", "succeeded", "rejected", "failed_recovered", "failed_degraded", "recovery_required"}
PHASES = {"validating", "preflight", "prepare_backend", "prepare_client", "prepare_channels", "prepare_data", "verify_candidate", "commit", "activate", "verify_active", "manage", "recover", "compensate"}
STORE = {
    "projects": "id owner body", "operations": "owner key hash result",
    "records": "owner app environment collection id revision body",
    "usage": "owner id task state created", "task_events": "owner project task seq body",
    "studio_preferences": "owner engine", "team_publications": "app owner project artifact policy payload published",
    "haowen_turns": "owner app environment session id question response created",
    "workshop_cleanup_operations": "owner key signature result",
    "deployment_profile_objects": "kind key body",
    "deployment_expert_runs": "id owner scope operation_id input_digest body",
    "directory_releases": "owner release_id directory_digest snapshot body created",
    "directory_release_artifacts": "owner source_id release_id artifact_id digest",
    "studio_release_exports": "owner operation_id request_hash body",
}
JOURNAL = {
    "deployment_releases": "owner application_id release_id digest body",
    "deployment_environments": "key body",
    "deployment_operations": "id owner environment_key idempotency_key request_hash state lease_until created_at body",
    "deployment_events": "operation_id sequence body",
    "deployment_outbox": "receipt_id owner operation_id body delivery_status attempts next_attempt_at",
}
REGISTRY = {"deployment_sources": "slot owner target source"}
KINDS = {"binding", "preparation", "release", "candidate", "ticket", "effect", "data", "receipt"}
KINDS |= {"expert-" + kind for kind in KINDS} | {"expert-prepare-error", "expert-probe"}
KINDS.add("expert-standard-launch")


class StateError(Exception):
    def __init__(self, code="BUILDER_OTA_STATE_INCOMPATIBLE"):
        self.code = code


def _require(value):
    if not value:
        raise StateError()


def _json(raw):
    if not isinstance(raw, str):
        raise StateError("BUILDER_OTA_STATE_INVALID")
    if len(raw.encode("utf-8")) > MAX_BODY:
        raise StateError("KAIWU_STATE_RECORD_BUDGET_EXCEEDED")
    value = json.loads(raw, parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
    if not isinstance(value, dict):
        raise StateError("BUILDER_OTA_STATE_INVALID")
    return value


def _safe(path, *, directory=False):
    if not path.exists() and not path.is_symlink():
        return False
    info = path.lstat()
    _require(stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode))
    return True


def _signature(info):
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def _copy_readonly(source, target, budget):
    # SQLite opens can create WAL/SHM even with mode=ro. Inspect a private byte
    # copy instead; the original is opened only through O_RDONLY/O_NOFOLLOW.
    fd = os.open(source, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    with os.fdopen(fd, "rb") as stream:
        before = os.fstat(stream.fileno())
        _require(stat.S_ISREG(before.st_mode))
        if before.st_size > budget[0]:
            raise StateError("KAIWU_STATE_SNAPSHOT_BUDGET_EXCEEDED")
        budget[0] -= before.st_size
        remaining = before.st_size
        with target.open("wb") as output:
            while remaining:
                chunk = stream.read(min(1024 * 1024, remaining))
                _require(bool(chunk))
                output.write(chunk)
                remaining -= len(chunk)
            _require(not stream.read(1))
        after = os.fstat(stream.fileno())
        _require(_signature(before) == _signature(after) == _signature(source.lstat()))
        return _signature(after)


@contextmanager
def _database(path, schema, required, budget):
    for suffix in ("-wal", "-shm", "-journal"):
        _safe(path.with_name(path.name + suffix))
    with tempfile.TemporaryDirectory(prefix="wanx-ota-state-") as temp:
        copied = Path(temp) / "state.sqlite"
        signatures = {path: _copy_readonly(path, copied, budget)}
        sidecars = {suffix: path.with_name(path.name + suffix).exists() for suffix in ("-wal", "-journal")}
        # Never use immutable=1: an existing WAL is part of the database state.
        for suffix, present in sidecars.items():
            sidecar = path.with_name(path.name + suffix)
            if present:
                signatures[sidecar] = _copy_readonly(sidecar, copied.with_name(copied.name + suffix), budget)
        _require(all(path.with_name(path.name + suffix).exists() == present for suffix, present in sidecars.items()))
        _require(all(_signature(source.lstat()) == signature for source, signature in signatures.items()))
        db = sqlite3.connect(copied.as_uri() + "?mode=ro", uri=True, timeout=5)
        try:
            db.execute("PRAGMA query_only=ON")
            db.execute("BEGIN")
            _require(db.execute("PRAGMA user_version").fetchone()[0] == 0)
            if db.execute("PRAGMA quick_check(1)").fetchone()[0] != "ok":
                raise StateError("BUILDER_OTA_STATE_INVALID")
            tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")}
            _require(set(required) <= tables <= set(schema))
            for table in tables:
                columns = [row[1] for row in db.execute('PRAGMA table_info("' + table + '")')]
                _require(columns == schema[table].split())
            yield db, tables
        finally:
            db.close()


def _rows(db, table, columns="body"):
    # Check resource limits in SQLite before materializing strings in Python.
    # Table/column names below are inspector-owned constants, never user input.
    if db.execute("SELECT count(*) FROM " + table).fetchone()[0] > MAX_ROWS:
        raise StateError("KAIWU_STATE_ROW_BUDGET_EXCEEDED")
    body = "target" if table == "deployment_sources" else "body"
    if db.execute("SELECT 1 FROM " + table + " WHERE length(CAST(" + body + " AS BLOB)) > ? LIMIT 1", (MAX_BODY,)).fetchone():
        raise StateError("KAIWU_STATE_RECORD_BUDGET_EXCEEDED")
    cursor = db.execute("SELECT " + columns + " FROM " + table)
    for row in cursor:
        yield row


def _target(value):
    _require(isinstance(value, dict) and set(value) == {"organizationId", "boxId", "applicationId", "environment"})
    _require(all(isinstance(v, str) and v for v in value.values()) and value["environment"] in {"dev", "prod"})


def _bundle(value):
    from .deployment.contracts import validate_bundle
    validate_bundle(value)
    requirements = value["runtimeRequirements"]
    runtime = requirements["runtimeRef"]
    _require(runtime.get("id") in PROFILES and type(runtime.get("revision")) is int and runtime["revision"] == 1)
    miniapp = runtime["id"] == "wanx-miniapp-v1"
    data = {"id": "miniapp-schema-additive-v1" if miniapp else "expert-app-additive-v1", "revision": 1}
    health = {"id": runtime["id"] if miniapp else runtime["id"] + "-health", "revision": 1}
    _require(requirements.get("dataCompatibilityRef") == data and requirements.get("healthContractRef") == health)


def _expert(value):
    _require(isinstance(value, dict) and type(value.get("schemaVersion")) is int and value["schemaVersion"] == 1 and value.get("profile") == "wanx-expert-app-v1")
    _target(value["target"])


def _profile(kind, value, counts, claims, source):
    _require(kind in KINDS)
    if "schemaVersion" in value:
        _require(type(value["schemaVersion"]) is int and value["schemaVersion"] == 1)
    base = kind.removeprefix("expert-")
    if base == "standard-launch":
        # StandardRuntime.pin persists launch fingerprints across generations.
        # Historical pins need not match the current active binding.
        _require(set(value) == {"generation", "artifactHash", "operationId", "packageSha256"})
        _require(type(value["generation"]) is int and value["generation"] >= 1)
        for field, size in (("artifactHash", 64), ("operationId", 32), ("packageSha256", 64)):
            _require(isinstance(value[field], str) and re.fullmatch("[a-f0-9]{" + str(size) + "}", value[field]))
    if base in {"release", "preparation"}:
        _bundle(value["bundle"])
    if base in {"binding", "preparation"}:
        from .deployment.source_registry import SourceRegistry
        target = value["target"] if base == "binding" else value["request"]["target"]
        slot, encoded = SourceRegistry._identity(source, value.get("owner"), target)
        claims.add((slot, value["owner"], encoded, source))
    if base == "binding":
        _target(value["target"])
        _require(value.get("state") in {"active", "activating"} and type(value.get("generation")) is int and value["generation"] >= 1)
        counts["bindings"] += 1
    if base == "ticket":
        _require(value.get("profile") in PROFILES and value.get("state") in {"pending", "prepared", "active", "cancelled", "failed"})
    if "expertBinding" in value:
        _expert(value["expertBinding"])
    if base == "receipt":
        from .deployment.contracts import validate_receipt
        validate_receipt(value)
    counts["profileObjects"] += 1


def _store(path, counts, budget, claims, source):
    with _database(path, STORE, ("projects", "operations", "records", "usage", "task_events"), budget) as (db, tables):
        for table in ("projects", "task_events"):
            for (body,) in _rows(db, table):
                _json(body)
        if "deployment_profile_objects" in tables:
            for kind, body in _rows(db, "deployment_profile_objects", "kind,body"):
                _profile(kind, _json(body), counts, claims, source)
        if "deployment_expert_runs" in tables:
            for (body,) in _rows(db, "deployment_expert_runs"):
                run = _json(body)
                _require(run.get("state") in RUN_STATES)
                if "binding" in run:
                    _expert(run["binding"])
                counts["expertRuns"] += 1
                counts["activeExpertRuns"] += run["state"] not in TERMINAL_RUNS
        for table in {"directory_releases", "studio_release_exports"} & tables:
            for (body,) in _rows(db, table):
                value = _json(body)
                if "schemaVersion" in value:
                    _require(value["schemaVersion"] in (1, "1"))
                if table == "directory_releases":
                    _bundle(value["bundle"])
                    manifest = value["manifest"]
                    _require(manifest.get("format") == "kaiwu-release-directory-v1" and type(manifest.get("schemaVersion")) is int and manifest["schemaVersion"] == 1)
                    backend = manifest["backend"]
                    _require(backend.get("kind") == "expert" and backend.get("profileRef") == {"id": "wanx-expert-app-v1", "revision": 1})
        counts["databases"] += 1


def _operation_request(operation, operations, validated, chain=()):
    """Normalize only the journal's linked, internal recovery request shape."""
    from .deployment.contracts import validate_request
    key = operation["id"]
    if key in validated:
        return validated[key]
    _require(key not in chain and len(chain) < 256)
    request = operation["request"]
    _require(isinstance(request, dict) and request.get("target") == operation.get("target"))
    if request.get("kind") != "recover":
        _require("recoveryOf" not in operation)
        validate_request(request)
        kind = request["kind"]
    else:
        original_id = request.get("recoveryOf")
        _require(isinstance(original_id, str) and operation.get("recoveryOf") == original_id and original_id in operations)
        original = operations[original_id]
        _require(original.get("state") in {"failed_degraded", "recovery_required"})
        _require(original.get("owner") == operation.get("owner") and original.get("target") == operation.get("target"))
        kind = _operation_request(original, operations, validated, (*chain, key))
        # create_recovery copies the original request, changing exactly these
        # fields. No new reference, permission, or arbitrary field is admitted.
        changing = {"kind", "recoveryOf", "expectedGeneration", "idempotencyKey"}
        _require({k: v for k, v in request.items() if k not in changing} ==
                 {k: v for k, v in original["request"].items() if k not in changing})
        expected = original.get("committedGeneration") if original.get("commitStatus") == "committed" else original.get("previousGeneration")
        _require(type(expected) is int and request.get("expectedGeneration") == expected)
        normalized = {k: v for k, v in request.items() if k != "recoveryOf"}
        normalized["kind"] = kind
        validate_request(normalized)
    validated[key] = kind
    return kind


def _journal(path, counts, budget):
    with _database(path, JOURNAL, JOURNAL, budget) as (db, _):
        for (body,) in _rows(db, "deployment_releases"):
            _bundle(_json(body))
            counts["releases"] += 1
        for (body,) in _rows(db, "deployment_environments"):
            value = _json(body)
            _target(value["target"])
            _require(value.get("health") in {"empty", "healthy", "maintenance", "degraded", "recovery_required", "stopped", "uninstalled"})
            _require(type(value.get("generation")) is int and value["generation"] >= 0)
            counts["environments"] += 1
        # Recovery chains need an index. Bound the aggregate retained input,
        # independently of per-record/file limits, before building that index.
        operation_bytes = db.execute("SELECT coalesce(sum(length(CAST(body AS BLOB))),0) FROM deployment_operations").fetchone()[0]
        if operation_bytes > MAX_OPERATION_BYTES:
            raise StateError("KAIWU_STATE_OPERATION_BUDGET_EXCEEDED")
        operations = {}
        for key, owner, state, body in _rows(db, "deployment_operations", "id,owner,state,body"):
            value = _json(body)
            _require(value.get("id") == key and value.get("owner") == owner)
            _require(value.get("state") == state and state in OP_STATES and value.get("phase") in PHASES)
            operations[key] = value
            counts["operations"] += 1
            counts["pendingDeployments"] += state not in {"succeeded", "rejected", "failed_recovered", "failed_degraded", "recovery_required"}
        validated = {}
        for operation in operations.values():
            _operation_request(operation, operations, validated)
        for (body,) in _rows(db, "deployment_outbox"):
            from .deployment.contracts import validate_receipt
            validate_receipt(_json(body))
        for (body,) in _rows(db, "deployment_events"):
            _json(body)
        counts["databases"] += 1


def _registry(path, counts, budget, claims):
    with _database(path, REGISTRY, REGISTRY, budget) as (db, _):
        from .deployment.source_registry import SourceRegistry
        registered = set()
        for slot, owner, target, source in _rows(db, "deployment_sources", "slot,owner,target,source"):
            value = _json(target)
            expected, encoded = SourceRegistry._identity(source, owner, value)
            _require(slot == expected and target == encoded)
            registered.add((slot, owner, encoded, source))
            counts["sourceClaims"] += 1
        _require(claims <= registered)
        counts["databases"] += 1


def report(root: Path) -> dict:
    result = {"schemaVersion": 1, "protocol": PROTOCOL, "statePresent": False, "stateCompatible": False, "code": None,
              "counts": dict.fromkeys(("databases", "releases", "environments", "operations", "bindings", "profileObjects", "expertRuns", "activeExpertRuns", "pendingDeployments", "sourceClaims"), 0)}
    root = Path(root)
    budget = [SNAPSHOT_BUDGET]
    claims = set()
    try:
        if not _safe(root, directory=True):
            result["stateCompatible"] = True
            return result
        for source, folder in (("studio", ".wanx-app-studio"), ("workshop", ".wanx-workshop")):
            parent = root / folder
            if not _safe(parent, directory=True):
                continue
            for name in ("studio.sqlite", "deployment"):
                path = parent / name
                if name == "studio.sqlite" and _safe(path):
                    result["statePresent"] = True
                    _store(path, result["counts"], budget, claims, source)
                elif name == "deployment" and _safe(path, directory=True):
                    path = path / "deployment.sqlite"
                    if _safe(path):
                        result["statePresent"] = True
                        _journal(path, result["counts"], budget)
        path = root / ".wanx-deployment-sources.sqlite"
        if _safe(path):
            result["statePresent"] = True
            _registry(path, result["counts"], budget, claims)
        else:
            _require(not claims)
        result["stateCompatible"] = True
    except StateError as error:
        result["statePresent"] = True
        result["code"] = error.code
    except OSError as error:
        result["statePresent"] = True
        result["code"] = "KAIWU_STATE_SNAPSHOT_SPACE_EXHAUSTED" if error.errno in {errno.ENOSPC, errno.EDQUOT} else "BUILDER_OTA_STATE_INVALID"
    except sqlite3.Error as error:
        result["statePresent"] = True
        result["code"] = "KAIWU_STATE_SNAPSHOT_SPACE_EXHAUSTED" if getattr(error, "sqlite_errorcode", None) == sqlite3.SQLITE_FULL else "BUILDER_OTA_STATE_INVALID"
    except (ValueError, TypeError, KeyError, RecursionError):
        result["statePresent"] = True
        result["code"] = "BUILDER_OTA_STATE_INVALID"
    except Exception:
        # Strict schema validators expose only a bounded code, never raw state.
        result["statePresent"] = True
        result["code"] = "BUILDER_OTA_STATE_INCOMPATIBLE"
    return result


def self_test():
    from .deployment.coordinator import Coordinator
    from .deployment.expert_runtime import ExpertRuntime
    from jsonschema import Draft7Validator
    _require(callable(Coordinator) and callable(ExpertRuntime))
    directory = Path(__file__).parent / "deployment" / "schemas"
    for name in ("bundle", "client-payload", "common", "expert-backend", "receipt", "release-directory", "request"):
        Draft7Validator.check_schema(json.loads((directory / (name + ".schema.json")).read_text()))
    return {"schemaVersion": 1, "protocol": PROTOCOL, "stateCompatible": True, "code": None}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path)
    parser.add_argument("--mode", choices=("inventory", "compatibility"), default="compatibility")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args(argv)
    if not args.self_test and args.root is None:
        parser.error("--root is required")
    try:
        value = self_test() if args.self_test else report(args.root)
    except Exception:
        value = {"schemaVersion": 1, "protocol": PROTOCOL, "stateCompatible": False, "code": "BUILDER_OTA_RUNTIME_INVALID"}
    print(json.dumps(value, sort_keys=True, separators=(",", ":")))
    return 0 if value["stateCompatible"] else 78


if __name__ == "__main__":
    raise SystemExit(main())
