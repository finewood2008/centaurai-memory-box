"""Durable deployment journal. External side effects belong to the coordinator.

All read/modify/write operations hold a process-local lock and a SQLite write
transaction. The environment key deliberately excludes the caller: authorization
is checked upstream, while the mutation lock covers the physical target.
"""
from __future__ import annotations

from contextlib import contextmanager
from copy import deepcopy
import hashlib
import json
from pathlib import Path
import sqlite3
import threading
from uuid import uuid4

from ..contracts import StudioError

TERMINAL = frozenset({"succeeded", "rejected", "failed_recovered", "failed_degraded", "recovery_required"})
TARGET_FIELDS = frozenset({"organizationId", "boxId", "applicationId", "environment"})
IMMUTABLE = frozenset({"id", "owner", "target", "request", "requestHash", "createdAt", "deadline", "previousGeneration", "recoveryOf"})


def _json(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def _target_key(target):
    if (not isinstance(target, dict) or set(target) != TARGET_FIELDS
            or any(not isinstance(v, str) or not v for v in target.values())
            or target["environment"] not in {"dev", "prod"}):
        raise StudioError("DEPLOYMENT_TARGET_INVALID", 422)
    return hashlib.sha256(_json(target).encode()).hexdigest()


def _limit(value, maximum=100):
    if type(value) is not int or not 1 <= value <= maximum:
        raise StudioError("DEPLOYMENT_PAGE_INVALID", 422)
    return value


class Journal:
    def __init__(self, root: Path):
        root.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._db = sqlite3.connect(root / "deployment.sqlite", isolation_level=None,
                                   check_same_thread=False, timeout=15)
        self._db.row_factory = sqlite3.Row
        self._db.execute("PRAGMA journal_mode=WAL")
        self._db.execute("PRAGMA synchronous=FULL")
        self._db.execute("PRAGMA foreign_keys=ON")
        self._db.executescript("""
            CREATE TABLE IF NOT EXISTS deployment_releases (
                owner TEXT NOT NULL, application_id TEXT NOT NULL, release_id TEXT NOT NULL,
                digest TEXT NOT NULL, body TEXT NOT NULL,
                PRIMARY KEY(owner,application_id,release_id));
            CREATE TABLE IF NOT EXISTS deployment_environments (
                key TEXT PRIMARY KEY, body TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS deployment_operations (
                id TEXT PRIMARY KEY, owner TEXT NOT NULL, environment_key TEXT NOT NULL,
                idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL,
                state TEXT NOT NULL, lease_until REAL NOT NULL DEFAULT 0,
                created_at REAL NOT NULL, body TEXT NOT NULL,
                UNIQUE(owner,environment_key,idempotency_key));
            CREATE INDEX IF NOT EXISTS deployment_pending
                ON deployment_operations(state,lease_until);
            CREATE INDEX IF NOT EXISTS deployment_owner
                ON deployment_operations(owner,created_at);
            CREATE TABLE IF NOT EXISTS deployment_events (
                operation_id TEXT NOT NULL REFERENCES deployment_operations(id),
                sequence INTEGER NOT NULL, body TEXT NOT NULL,
                PRIMARY KEY(operation_id,sequence));
            CREATE TABLE IF NOT EXISTS deployment_outbox (
                receipt_id TEXT PRIMARY KEY, owner TEXT NOT NULL,
                operation_id TEXT NOT NULL UNIQUE REFERENCES deployment_operations(id),
                body TEXT NOT NULL, delivery_status TEXT NOT NULL DEFAULT 'pending',
                attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at REAL NOT NULL);
        """)

    def close(self):
        with self._lock:
            self._db.close()

    @contextmanager
    def _transaction(self):
        with self._lock:
            self._db.execute("BEGIN IMMEDIATE")
            try:
                yield
                self._db.execute("COMMIT")
            except BaseException:
                self._db.execute("ROLLBACK")
                raise

    def _operation(self, operation_id, owner=None):
        row = self._db.execute("SELECT body FROM deployment_operations WHERE id=?", (operation_id,)).fetchone()
        op = json.loads(row["body"]) if row else None
        if not op or (owner is not None and op["owner"] != owner):
            raise StudioError("DEPLOYMENT_OPERATION_NOT_FOUND", 404)
        return op

    def _environment(self, target):
        key = _target_key(target)
        row = self._db.execute("SELECT body FROM deployment_environments WHERE key=?", (key,)).fetchone()
        return json.loads(row["body"]) if row else {
            "target": deepcopy(target), "generation": 0, "revision": 0,
            "activeReleaseRef": None, "health": "empty", "activeOperationId": None, "fence": 0,
        }

    def _put_environment(self, env):
        self._db.execute("INSERT INTO deployment_environments(key,body) VALUES (?,?) "
                         "ON CONFLICT(key) DO UPDATE SET body=excluded.body",
                         (_target_key(env["target"]), _json(env)))

    def _put_operation(self, op):
        self._db.execute("UPDATE deployment_operations SET state=?,lease_until=?,body=? WHERE id=?",
                         (op["state"], op["leaseUntil"], _json(op), op["id"]))

    def _event(self, op, event, now):
        seq = self._db.execute("SELECT COALESCE(MAX(sequence),0)+1 FROM deployment_events WHERE operation_id=?",
                               (op["id"],)).fetchone()[0]
        value = deepcopy(event)
        value.update(sequence=seq, operationId=op["id"], operationRevision=op["revision"], createdAt=now)
        self._db.execute("INSERT INTO deployment_events VALUES (?,?,?)", (op["id"], seq, _json(value)))

    def register_release(self, owner, bundle):
        with self._transaction():
            row = self._db.execute("SELECT digest,body FROM deployment_releases "
                                   "WHERE owner=? AND application_id=? AND release_id=?",
                                   (owner, bundle["applicationId"], bundle["releaseId"])).fetchone()
            if row:
                if row["digest"] != bundle["bundleDigest"]:
                    raise StudioError("DEPLOYMENT_RELEASE_CONFLICT", 409)
                return json.loads(row["body"])
            self._db.execute("INSERT INTO deployment_releases VALUES (?,?,?,?,?)",
                             (owner, bundle["applicationId"], bundle["releaseId"], bundle["bundleDigest"], _json(bundle)))
            return deepcopy(bundle)

    def release(self, owner, application_id, release_ref):
        with self._lock:
            row = self._db.execute("SELECT digest,body FROM deployment_releases "
                                   "WHERE owner=? AND application_id=? AND release_id=?",
                                   (owner, application_id, release_ref["releaseId"])).fetchone()
            if not row:
                raise StudioError("DEPLOYMENT_RELEASE_NOT_FOUND", 404)
            if row["digest"] != release_ref["bundleDigest"]:
                raise StudioError("DEPLOYMENT_RELEASE_CONFLICT", 409)
            return json.loads(row["body"])

    def _new_operation(self, owner, request, request_hash, now, deadline, env, recovery_of=None):
        op = {
            "id": uuid4().hex, "owner": owner, "target": deepcopy(request["target"]),
            "request": deepcopy(request), "requestHash": request_hash,
            "state": "queued", "phase": "recover" if recovery_of else "validating", "revision": 1,
            "createdAt": now, "updatedAt": now, "deadline": deadline,
            "fence": 0, "leaseOwner": None, "leaseUntil": 0,
            "commitStatus": "not_committed", "committedGeneration": None,
            "previousGeneration": env["generation"], "checkpoint": {}, "components": [],
        }
        if recovery_of:
            op["recoveryOf"] = recovery_of
        self._db.execute("INSERT INTO deployment_operations VALUES (?,?,?,?,?,?,?,?,?)",
                         (op["id"], owner, _target_key(op["target"]), request["idempotencyKey"],
                          request_hash, op["state"], 0, now, _json(op)))
        env["activeOperationId"] = op["id"]
        self._put_environment(env)
        self._event(op, {"type": "accepted", "state": "queued", "phase": op["phase"]}, now)
        return op

    def submit(self, owner, request, request_hash, now, deadline):
        key = _target_key(request["target"])
        with self._transaction():
            row = self._db.execute("SELECT body FROM deployment_operations WHERE "
                                   "owner=? AND environment_key=? AND idempotency_key=?",
                                   (owner, key, request["idempotencyKey"])).fetchone()
            if row:
                op = json.loads(row["body"])
                if op["requestHash"] != request_hash or op["request"] != request:
                    raise StudioError("DEPLOYMENT_IDEMPOTENCY_CONFLICT", 409)
                return op
            if request.get("kind") == "recover":
                raise StudioError("DEPLOYMENT_RECOVERY_INTERNAL_ONLY", 422)
            env = self._environment(request["target"])
            if env["health"] in {"degraded", "recovery_required"}:
                raise StudioError("DEPLOYMENT_RECOVERY_REQUIRED", 409)
            if env["activeOperationId"]:
                raise StudioError("DEPLOYMENT_ENVIRONMENT_BUSY", 409)
            if type(request.get("expectedGeneration")) is not int or request["expectedGeneration"] != env["generation"]:
                raise StudioError("DEPLOYMENT_GENERATION_CONFLICT", 409)
            return self._new_operation(owner, request, request_hash, now, deadline, env)

    def get_operation(self, owner, operation_id):
        with self._lock:
            return self._operation(operation_id, owner)

    def get_environment(self, target):
        with self._lock:
            return self._environment(target)

    def list_operations(self, owner, target=None, limit=50):
        params = [owner]
        where = "owner=?"
        if target is not None:
            where += " AND environment_key=?"
            params.append(_target_key(target))
        params.append(_limit(limit))
        with self._lock:
            return [json.loads(row[0]) for row in self._db.execute(
                "SELECT body FROM deployment_operations WHERE " + where + " ORDER BY created_at DESC,id DESC LIMIT ?", params)]

    def events(self, owner, operation_id, after=0, limit=100):
        _limit(limit)
        if type(after) is not int or after < 0:
            raise StudioError("DEPLOYMENT_CURSOR_INVALID", 422)
        with self._lock:
            self._operation(operation_id, owner)
            rows = self._db.execute("SELECT body FROM deployment_events WHERE operation_id=? "
                                    "AND sequence>? ORDER BY sequence LIMIT ?", (operation_id, after, limit + 1)).fetchall()
            items = [json.loads(row[0]) for row in rows[:limit]]
            return {"items": items, "nextCursor": items[-1]["sequence"] if items else after, "hasMore": len(rows) > limit}

    def pending(self, now, limit=50):
        with self._lock:
            rows = self._db.execute("SELECT body FROM deployment_operations WHERE state NOT IN (?,?,?,?,?) "
                                    "AND lease_until<=? ORDER BY lease_until,created_at,id LIMIT ?",
                                    (*sorted(TERMINAL), now, _limit(limit))).fetchall()
            return [json.loads(row[0]) for row in rows]

    def claim(self, operation_id, worker, now, lease_seconds):
        if not worker or lease_seconds <= 0:
            raise StudioError("DEPLOYMENT_LEASE_INVALID", 422)
        with self._transaction():
            op = self._operation(operation_id)
            if op["state"] in TERMINAL or op["leaseUntil"] > now:
                return None
            env = self._environment(op["target"])
            if env["activeOperationId"] != op["id"]:
                raise StudioError("DEPLOYMENT_ENVIRONMENT_CONFLICT", 409)
            env["fence"] += 1
            op.update(fence=env["fence"], leaseOwner=worker, leaseUntil=now + lease_seconds,
                      revision=op["revision"] + 1, updatedAt=now)
            self._put_environment(env)
            self._put_operation(op)
            return op

    def _leased(self, operation_id, worker, fence, now):
        current = self._operation(operation_id)
        if current["state"] in TERMINAL:
            raise StudioError("DEPLOYMENT_OPERATION_TERMINAL", 409)
        env = self._environment(current["target"])
        if (current["leaseOwner"] != worker or current["fence"] != fence
                or current["leaseUntil"] <= now or env["fence"] != fence
                or env["activeOperationId"] != operation_id):
            raise StudioError("DEPLOYMENT_LEASE_LOST", 409)
        return current, env

    def release_claim(self, operation_id, worker, fence, now, delay=0):
        if delay < 0:
            raise StudioError("DEPLOYMENT_LEASE_INVALID", 422)
        with self._transaction():
            op, _ = self._leased(operation_id, worker, fence, now)
            op.update(leaseOwner=None, leaseUntil=now + delay, updatedAt=now, revision=op["revision"] + 1)
            self._put_operation(op)
            return op

    def save(self, op, worker, fence, now, event=None, environment=None, receipt=None):
        with self._transaction():
            current, env = self._leased(op["id"], worker, fence, now)
            if op.get("revision") != current["revision"]:
                raise StudioError("DEPLOYMENT_REVISION_CONFLICT", 409)
            if any(op.get(key) != current.get(key) for key in IMMUTABLE):
                raise StudioError("DEPLOYMENT_OPERATION_IMMUTABLE", 409)
            if any(op.get(key) != current[key] for key in ("fence", "leaseOwner", "leaseUntil")):
                raise StudioError("DEPLOYMENT_LEASE_INVALID", 409)
            if op.get("commitStatus") not in {"not_committed", "committed", "unknown"}:
                raise StudioError("DEPLOYMENT_COMMIT_INVALID", 409)
            if current["commitStatus"] == "committed" and (
                op["commitStatus"] != "committed" or op["committedGeneration"] != current["committedGeneration"]
            ):
                raise StudioError("DEPLOYMENT_COMMIT_IMMUTABLE", 409)
            result = deepcopy(op)
            result.update(revision=current["revision"] + 1, updatedAt=now)
            if environment is not None:
                allowed = {"generation", "revision", "activeReleaseRef", "health"}
                if set(environment) - allowed:
                    raise StudioError("DEPLOYMENT_ENVIRONMENT_IMMUTABLE", 409)
                generation = environment.get("generation", env["generation"])
                if type(generation) is not int or generation not in {env["generation"], env["generation"] + 1}:
                    raise StudioError("DEPLOYMENT_GENERATION_CONFLICT", 409)
                revision = environment.get("revision", env["revision"] + 1)
                if type(revision) is not int or revision != env["revision"] + 1:
                    raise StudioError("DEPLOYMENT_ENVIRONMENT_REVISION_CONFLICT", 409)
                env.update(deepcopy(environment))
                env["revision"] = revision
            terminal = result["state"] in TERMINAL
            if terminal != (receipt is not None):
                raise StudioError("DEPLOYMENT_RECEIPT_REQUIRED" if terminal else "DEPLOYMENT_RECEIPT_PREMATURE", 409)
            if terminal:
                if result["state"] in {"failed_degraded", "recovery_required"}:
                    env["health"] = "degraded" if result["state"] == "failed_degraded" else "recovery_required"
                    if environment is None:
                        env["revision"] += 1
                result.update(leaseOwner=None, leaseUntil=0)
                env["activeOperationId"] = None
                expected = {"operationId": result["id"], "operationRevision": result["revision"],
                            "kind": result["request"]["kind"], "target": result["target"],
                            "outcome": result["state"], "commitStatus": result["commitStatus"],
                            "committedGeneration": result["committedGeneration"],
                            "previousGeneration": result["previousGeneration"], "environmentRevision": env["revision"]}
                if any(receipt.get(key) != value for key, value in expected.items()) or not receipt.get("receiptId"):
                    raise StudioError("DEPLOYMENT_RECEIPT_MISMATCH", 409)
                try:
                    self._db.execute("INSERT INTO deployment_outbox(receipt_id,owner,operation_id,body,next_attempt_at) "
                                     "VALUES (?,?,?,?,?)", (receipt["receiptId"], result["owner"], result["id"], _json(receipt), now))
                except sqlite3.IntegrityError:
                    raise StudioError("DEPLOYMENT_RECEIPT_CONFLICT", 409) from None
            self._put_environment(env)
            self._put_operation(result)
            if event is not None:
                self._event(result, event, now)
            elif terminal:
                self._event(result, {"type": "completed", "state": result["state"], "phase": result["phase"]}, now)
            return result

    def outbox_pending(self, now, limit=50, owner=None, operation_id=None):
        where, params = "delivery_status='pending' AND next_attempt_at<=?", [now]
        if owner is not None:
            where += " AND owner=?"
            params.append(owner)
        if operation_id is not None:
            where += " AND operation_id=?"
            params.append(operation_id)
        params.append(_limit(limit))
        with self._lock:
            return [{"receiptId": row["receipt_id"], "owner": row["owner"],
                     "operationId": row["operation_id"], "receipt": json.loads(row["body"]),
                     "attempts": row["attempts"]}
                    for row in self._db.execute("SELECT * FROM deployment_outbox WHERE " + where +
                                                " ORDER BY next_attempt_at,receipt_id LIMIT ?", params)]

    def record_delivery(self, receipt_id, success, now, retry_delay):
        if retry_delay < 0:
            raise StudioError("DEPLOYMENT_RETRY_INVALID", 422)
        with self._transaction():
            row = self._db.execute("SELECT delivery_status FROM deployment_outbox WHERE receipt_id=?", (receipt_id,)).fetchone()
            if not row:
                raise StudioError("DEPLOYMENT_RECEIPT_NOT_FOUND", 404)
            if row[0] == "delivered":
                return
            self._db.execute("UPDATE deployment_outbox SET delivery_status=?,attempts=attempts+1,next_attempt_at=? "
                             "WHERE receipt_id=?", ("delivered" if success else "pending", now + retry_delay, receipt_id))

    def receipt(self, owner, operation_id):
        with self._lock:
            self._operation(operation_id, owner)
            row = self._db.execute("SELECT body,delivery_status,attempts FROM deployment_outbox WHERE operation_id=?",
                                   (operation_id,)).fetchone()
            return {"receipt": json.loads(row[0]), "deliveryStatus": row[1], "attempts": row[2]} if row else None

    def retry_delivery(self, owner, operation_id, now):
        with self._transaction():
            self._operation(operation_id, owner)
            row = self._db.execute("SELECT body,delivery_status,attempts FROM deployment_outbox WHERE operation_id=?",
                                   (operation_id,)).fetchone()
            if not row:
                raise StudioError("DEPLOYMENT_RECEIPT_NOT_FOUND", 404)
            if row[1] == "pending":
                self._db.execute("UPDATE deployment_outbox SET next_attempt_at=? WHERE operation_id=?", (now, operation_id))
            return {"receipt": json.loads(row[0]), "deliveryStatus": row[1], "attempts": row[2]}

    def create_recovery(self, owner, original_id, now, deadline):
        with self._transaction():
            original = self._operation(original_id, owner)
            if original["state"] not in {"failed_degraded", "recovery_required"}:
                raise StudioError("DEPLOYMENT_RECOVERY_INVALID", 409)
            env = self._environment(original["target"])
            if env["activeOperationId"]:
                active = self._operation(env["activeOperationId"])
                if active.get("recoveryOf") == original_id and active["owner"] == owner:
                    return active
                raise StudioError("DEPLOYMENT_ENVIRONMENT_BUSY", 409)
            original_receipt = self.receipt(owner, original_id)
            if original_receipt is None:
                raise StudioError("RECOVERY_STALE", 409)
            original_receipt = original_receipt["receipt"]
            expected_generation = (original_receipt["committedGeneration"]
                                   if original_receipt["commitStatus"] == "committed"
                                   else original_receipt["previousGeneration"])
            if (env["revision"] != original_receipt["environmentRevision"]
                    or env["generation"] != expected_generation):
                raise StudioError("RECOVERY_STALE", 409)
            if env["health"] not in {"degraded", "recovery_required"}:
                raise StudioError("DEPLOYMENT_RECOVERY_INVALID", 409)
            request = deepcopy(original["request"])
            request.update(kind="recover", recoveryOf=original_id, expectedGeneration=env["generation"],
                           idempotencyKey="recovery_" + uuid4().hex)
            request_hash = hashlib.sha256(_json(request).encode()).hexdigest()
            op = self._new_operation(owner, request, request_hash, now, deadline, env, original_id)
            for key in ("checkpoint", "components", "committedGeneration", "previousGeneration", "commitStatus"):
                op[key] = deepcopy(original[key])
            op["checkpoint"].pop("compensationDeadline", None)
            op["phase"] = "recover"
            self._put_operation(op)
            return op
