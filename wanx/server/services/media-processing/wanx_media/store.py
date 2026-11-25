"""Serialized SQLite transactions keep upload bytes, offsets and job receipts together."""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
import hashlib
import json
from pathlib import Path
import re
import secrets
import shutil
import sqlite3
import time
import uuid

CHUNK = 1024 * 1024
MAX_INPUT = 256 * 1024 * 1024
RETENTION = 86400
MAX_ATTEMPTS = 3


class Problem(Exception):
    def __init__(self, code: str, status: int = 400):
        self.code = code
        self.status = status
        super().__init__(code)


class Store:
    def __init__(self, directory: Path):
        from .summary_templates import initialize

        directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.directory = directory
        self.path = directory / "media.sqlite3"
        with self.db() as conn:
            conn.executescript("""
            CREATE TABLE IF NOT EXISTS grants(
              id TEXT PRIMARY KEY, digest TEXT UNIQUE NOT NULL, box TEXT NOT NULL,
              user TEXT NOT NULL, space TEXT NOT NULL, instance TEXT NOT NULL,
              caps TEXT NOT NULL, expires REAL NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
            CREATE TABLE IF NOT EXISTS jobs(
              id TEXT PRIMARY KEY, grant_id TEXT NOT NULL REFERENCES grants(id), request TEXT NOT NULL,
              cap TEXT NOT NULL, size INTEGER NOT NULL, digest TEXT NOT NULL, options TEXT NOT NULL,
              offset INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL, created REAL NOT NULL,
              expires REAL NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, result TEXT,
              error TEXT, UNIQUE(grant_id,request));
            CREATE TABLE IF NOT EXISTS chunks(
              job TEXT NOT NULL REFERENCES jobs(id), start INTEGER NOT NULL, data BLOB NOT NULL,
              PRIMARY KEY(job,start));
            CREATE INDEX IF NOT EXISTS jobs_queue ON jobs(state,created);
            """)

        # Old stores contain only interactive grants. Migrate under the writer lock.
        with self.db() as db:
            if "parent_id" not in {
                r["name"] for r in db.execute("PRAGMA table_info(grants)")
            }:
                db.execute(
                    "ALTER TABLE grants ADD COLUMN parent_id TEXT REFERENCES grants(id)"
                )
            if "until_revoked" not in {
                r["name"] for r in db.execute("PRAGMA table_info(grants)")
            }:
                db.execute("ALTER TABLE grants ADD COLUMN until_revoked INTEGER NOT NULL DEFAULT 0")
            db.execute("CREATE INDEX IF NOT EXISTS grants_parent ON grants(parent_id)")

        with self.db() as db:
            cols = {r["name"] for r in db.execute("PRAGMA table_info(jobs)")}
            if "model_stamp" not in cols:
                db.execute("ALTER TABLE jobs ADD COLUMN model_stamp TEXT")
            if "cache_hit" not in cols:
                db.execute(
                    "ALTER TABLE jobs ADD COLUMN cache_hit INTEGER NOT NULL DEFAULT 0"
                )
            if "execution_options" not in cols:
                db.execute("ALTER TABLE jobs ADD COLUMN execution_options TEXT")
            db.execute("""CREATE INDEX IF NOT EXISTS jobs_query_reuse
                       ON jobs(grant_id,cap,digest,model_stamp,expires)
                       WHERE state='done' AND cache_hit=0""")
            initialize(db)

    @contextmanager
    def db(self):
        conn = sqlite3.connect(self.path, timeout=10, isolation_level=None)
        conn.row_factory = sqlite3.Row
        try:
            conn.execute("PRAGMA foreign_keys=ON")
            conn.execute("PRAGMA secure_delete=ON")
            conn.execute("BEGIN IMMEDIATE")
            yield conn
            conn.commit()
        except BaseException:
            conn.rollback()
            raise
        finally:
            conn.close()

    def grant(
        self,
        box: str,
        user: str,
        space: str,
        instance: str,
        capabilities: list[str],
        ttl: int,
    ):
        token = secrets.token_urlsafe(32)
        grant_id = uuid.uuid4().hex
        with self.db() as db:
            db.execute(
                "INSERT INTO grants(id,digest,box,user,space,instance,caps,expires,revoked) VALUES(?,?,?,?,?,?,?,?,0)",
                (
                    grant_id,
                    hashlib.sha256(token.encode()).hexdigest(),
                    box,
                    user,
                    space,
                    instance,
                    json.dumps(sorted(set(capabilities))),
                    time.time() + ttl,
                ),
            )
        return grant_id, token

    def retain_recording_grant(self, grant_id, box, user, space, instance):
        """Retain an existing, currently valid recording installation grant."""
        if not re.fullmatch(r"memobox-recording-[0-9a-f]{32}", instance):
            raise Problem("RECORDING_INSTANCE_REQUIRED", 403)
        with self.db() as db:
            row = db.execute(
                """SELECT * FROM grants WHERE id=? AND box=? AND user=? AND space=? AND instance=?
                   AND parent_id IS NULL AND revoked=0 AND (until_revoked=1 OR expires>?)""",
                (grant_id, box, user, space, instance, time.time()),
            ).fetchone()
            if row is None or set(json.loads(row["caps"])) != {
                "audio.transcribe", "audio.transcribe.streaming"
            }:
                raise Problem("ACTIVE_RECORDING_GRANT_REQUIRED", 403)
            db.execute("UPDATE grants SET until_revoked=1 WHERE id=?", (grant_id,))
            return self.context(db.execute("SELECT * FROM grants WHERE id=?", (grant_id,)).fetchone())

    def enable_recording_summary(self, grant_id, box, user, space, instance):
        """Opt the bound recording installation into cloud text summaries."""
        audio = {"audio.transcribe", "audio.transcribe.streaming"}
        if not re.fullmatch(r"memobox-recording-[0-9a-f]{32}", instance):
            raise Problem("RECORDING_INSTANCE_REQUIRED", 403)
        with self.db() as db:
            row = db.execute(
                """SELECT * FROM grants WHERE id=? AND box=? AND user=? AND space=? AND instance=?
                   AND parent_id IS NULL AND revoked=0 AND (until_revoked=1 OR expires>?)""",
                (grant_id, box, user, space, instance, time.time()),
            ).fetchone()
            approved = audio | {"text.summarize"}
            if row is None or set(json.loads(row["caps"])) not in (audio, approved):
                raise Problem("ACTIVE_RECORDING_GRANT_REQUIRED", 403)
            db.execute("UPDATE grants SET caps=? WHERE id=?", (json.dumps(sorted(approved)), grant_id))
            return self.context(db.execute("SELECT * FROM grants WHERE id=?", (grant_id,)).fetchone())

    @staticmethod
    def expires_at(grant):
        return None if grant["until_revoked"] else grant["expires"]

    def delegate(self, db, parent, caps, ttl):
        allowed = {
            "audio.transcribe",
            "image.ocr",
            "image.labels",
            "image.embedding",
            "image.fingerprint",
        }
        if not caps or not set(caps) <= allowed.intersection(
            json.loads(parent["caps"])
        ):
            raise Problem("CAPABILITY_DENIED", 403)
        now = time.time()
        if (
            db.execute(
                "SELECT count(*) FROM grants WHERE parent_id=? AND revoked=0 AND expires>?",
                (parent["id"], now),
            ).fetchone()[0]
            >= 16
        ):
            raise Problem("DELEGATION_LIMIT", 429)
        secret = "media_worker_" + secrets.token_urlsafe(32)
        gid = uuid.uuid4().hex
        expires = now + ttl
        if not parent["until_revoked"]:
            expires = min(parent["expires"], expires)
        db.execute(
            """INSERT INTO grants(id,digest,box,user,space,instance,caps,expires,parent_id)
                      VALUES(?,?,?,?,?,?,?,?,?)""",
            (
                gid,
                hashlib.sha256(secret.encode()).hexdigest(),
                parent["box"],
                parent["user"],
                parent["space"],
                parent["instance"],
                json.dumps(sorted(set(caps))),
                expires,
                parent["id"],
            ),
        )
        row = db.execute("SELECT * FROM grants WHERE id=?", (gid,)).fetchone()
        return {**self.context(row), "token": secret}

    @staticmethod
    def context(grant):
        return {
            "id": grant["id"],
            "instance": grant["instance"],
            "boxId": grant["box"],
            "userId": grant["user"],
            "spaceId": grant["space"],
            "expiresAt": Store.expires_at(grant),
            "audience": "wanx.homeai",
            "capabilities": json.loads(grant["caps"]),
        }

    @staticmethod
    def authorize_delegate(db, secret):
        now = time.time()
        row = db.execute(
            """SELECT child.* FROM grants child JOIN grants parent ON child.parent_id=parent.id
                       WHERE child.digest=? AND child.revoked=0 AND child.expires>?
                       AND parent.revoked=0 AND (parent.until_revoked=1 OR parent.expires>?)""",
            (hashlib.sha256(secret.encode()).hexdigest(), now, now),
        ).fetchone()
        if row is None:
            raise Problem("DELEGATION_INVALID", 403)
        return row

    def revoke(self, grant_id: str):
        with self.db() as db:
            if not db.execute(
                "UPDATE grants SET revoked=1 WHERE id=?", (grant_id,)
            ).rowcount:
                raise Problem("GRANT_NOT_FOUND", 404)
            self.sweep(db)

    @staticmethod
    def sweep(db):
        now = time.time()
        db.execute(
            """UPDATE grants SET revoked=1 WHERE revoked=0 AND parent_id IN
                      (SELECT id FROM grants WHERE revoked=1 OR (until_revoked=0 AND expires<=?))""",
            (now,),
        )
        db.execute(
            """UPDATE jobs SET state='revoked',result=NULL,error=NULL,execution_options=NULL
                   WHERE state NOT IN ('revoked','expired') AND grant_id IN
                   (SELECT id FROM grants WHERE revoked=1 OR (until_revoked=0 AND expires<=?))""",
            (now,),
        )
        db.execute(
            """UPDATE jobs SET state='expired',result=NULL,error=NULL,execution_options=NULL
                   WHERE expires<=? AND state NOT IN ('expired','revoked')""",
            (now,),
        )
        db.execute("""DELETE FROM chunks WHERE job IN
                   (SELECT id FROM jobs WHERE state IN ('expired','cancelled','revoked','done'))""")
        # Keep only short-lived opaque tombstones to answer late retries.
        db.execute(
            "DELETE FROM jobs WHERE state IN ('expired','revoked','cancelled') AND expires<?",
            (now - RETENTION,),
        )

    def authorize(self, db, claims: dict, secret: str):
        row = db.execute(
            """SELECT * FROM grants WHERE parent_id IS NULL AND digest=? AND box=? AND user=? AND space=?
                          AND revoked=0 AND (until_revoked=1 OR expires>?)""",
            (
                hashlib.sha256(secret.encode()).hexdigest(),
                claims["boxId"],
                claims["userId"],
                claims["spaceId"],
                time.time(),
            ),
        ).fetchone()
        if row is None:
            raise Problem("GRANT_REQUIRED", 403)
        return row

    @staticmethod
    def owned(db, grant, job_id):
        row = db.execute(
            "SELECT * FROM jobs WHERE id=? AND grant_id=?", (job_id, grant["id"])
        ).fetchone()
        if not row:
            raise Problem("JOB_NOT_FOUND", 404)
        if row["expires"] <= time.time() or row["state"] == "expired":
            raise Problem("JOB_EXPIRED", 410)
        return row

    @staticmethod
    def receipt(row):
        fields = {
            external: row[key]
            for external, key in {
                "id": "id",
                "state": "state",
                "capability": "cap",
                "offset": "offset",
                "size": "size",
                "expiresAt": "expires",
                "attempts": "attempts",
                "error": "error",
            }.items()
        }

        return {**fields, "cacheHit": bool(row["cache_hit"])}

    def create(self, db, grant, request, cap, size, digest, options, *, snapshot=None):
        args = (
            cap,
            size,
            digest,
            json.dumps(options, sort_keys=True, ensure_ascii=False),
        )
        old = db.execute(
            "SELECT * FROM jobs WHERE grant_id=? AND request=?", (grant["id"], request)
        ).fetchone()
        if old:
            if tuple(old[k] for k in ("cap", "size", "digest", "options")) != args:
                raise Problem("REQUEST_CONFLICT", 409)
            return self.receipt(self.owned(db, grant, old["id"]))
        self.sweep(db)
        active = "('uploading','queued','running','failed')"
        total, count, outstanding, largest = db.execute(
            f"SELECT coalesce(sum(size),0),count(*),coalesce(sum(size-offset),0),coalesce(max(size),0) FROM jobs WHERE state IN {active}"
        ).fetchone()
        if count >= 128 or total + size > 2 * 1024**3:
            raise Problem("QUEUE_CAPACITY", 429)
        # Account for bytes promised to active uploads and one spooled worker input.
        if (
            shutil.disk_usage(self.directory).free
            < outstanding + size + max(largest, size) + 64 * 1024**2
        ):
            raise Problem("DISK_CAPACITY", 507)
        job = uuid.uuid4().hex
        now = time.time()
        execution_options = (
            json.dumps(snapshot(), ensure_ascii=False) if snapshot is not None else None
        )
        db.execute(
            """INSERT INTO jobs(id,grant_id,request,cap,size,digest,options,execution_options,state,created,expires)
                    VALUES(?,?,?,?,?,?,?,?,'uploading',?,?)""",
            (job, grant["id"], request, *args, execution_options, now, now + RETENTION),
        )
        return self.receipt(self.owned(db, grant, job))

    def append(self, db, row, offset, data):
        if row["state"] != "uploading":
            raise Problem("UPLOAD_CLOSED", 409)
        if offset < row["offset"]:
            existing = db.execute(
                "SELECT data FROM chunks WHERE job=? AND start=?", (row["id"], offset)
            ).fetchone()
            if existing and existing[0] == data:
                return row["offset"]
        if (
            not data
            or len(data) > CHUNK
            or offset != row["offset"]
            or offset + len(data) > row["size"]
        ):
            raise Problem("OFFSET_OR_SIZE_CONFLICT", 409)
        # Bound the number of SQLite rows per input.
        if len(data) != CHUNK and offset + len(data) != row["size"]:
            raise Problem("FULL_CHUNK_REQUIRED", 422)
        db.execute("INSERT INTO chunks VALUES(?,?,?)", (row["id"], offset, data))
        db.execute("UPDATE jobs SET offset=offset+? WHERE id=?", (len(data), row["id"]))
        return offset + len(data)

    def submit(self, db, row):
        if row["state"] in ("queued", "running", "done"):
            return
        if row["state"] != "uploading" or row["offset"] != row["size"]:
            raise Problem("UPLOAD_INCOMPLETE", 409)
        hasher = hashlib.sha256()
        for data in self.chunks(db, row["id"]):
            hasher.update(data)
        if hasher.hexdigest() != row["digest"]:
            raise Problem("DIGEST_MISMATCH", 422)
        db.execute("UPDATE jobs SET state='queued' WHERE id=?", (row["id"],))

    @staticmethod
    def chunks(db, job: str) -> Iterator[bytes]:
        for row in db.execute(
            "SELECT data FROM chunks WHERE job=? ORDER BY start", (job,)
        ):
            yield row[0]

    def cancel(self, db, row):
        db.execute(
            "UPDATE jobs SET state='cancelled',result=NULL,error=NULL,execution_options=NULL WHERE id=?",
            (row["id"],),
        )
        db.execute("DELETE FROM chunks WHERE job=?", (row["id"],))

    @staticmethod
    def retry(db, row):
        queued = row["state"] == "queued"
        if not queued and (row["state"] != "failed" or row["attempts"] >= MAX_ATTEMPTS):
            raise Problem("RETRY_NOT_ALLOWED", 409)
        if row["cap"] == "text.summarize":
            snapshot = json.loads(row["execution_options"] or "{}")
            if snapshot.get("processingLocation") != "cloud":
                raise Problem("SUMMARY_CLOUD_RESUBMIT_REQUIRED", 409)
        if queued:
            return
        db.execute("UPDATE jobs SET state='queued',error=NULL WHERE id=?", (row["id"],))

    def recover(self):
        with self.db() as db:
            self.sweep(db)
            db.execute(
                """UPDATE jobs SET state=CASE WHEN attempts>=? THEN 'failed' ELSE 'queued' END,
                       error='WORKER_INTERRUPTED' WHERE state='running'""",
                (MAX_ATTEMPTS,),
            )

    def claim(self):
        with self.db() as db:
            self.sweep(db)
            row = db.execute(
                "SELECT * FROM jobs WHERE state='queued' ORDER BY created LIMIT 1"
            ).fetchone()
            if row:
                db.execute(
                    "UPDATE jobs SET state='running',attempts=attempts+1,error=NULL WHERE id=?",
                    (row["id"],),
                )
                return dict(row)
        return None

    def live(self, job: str) -> bool:
        with self.db() as db:
            self.sweep(db)
            return (
                db.execute(
                    "SELECT 1 FROM jobs WHERE id=? AND state='running'", (job,)
                ).fetchone()
                is not None
            )

    def reuse_query(self, job, stamp):
        # Reuse an existing, unexpired original result without holding a separate
        # plaintext vector cache. Same grant, same bytes, same installed encoder.
        if not stamp:
            return False
        with self.db() as db:
            self.sweep(db)
            now = time.time()
            old = db.execute(
                """SELECT result FROM jobs WHERE grant_id=? AND cap='text.embedding'
                       AND digest=? AND model_stamp=? AND state='done' AND cache_hit=0
                       AND expires>? ORDER BY expires DESC LIMIT 1""",
                (job["grant_id"], job["digest"], stamp, now + RETENTION - 300),
            ).fetchone()
            if not old:
                return False
            updated = db.execute(
                """UPDATE jobs SET state='done',result=?,cache_hit=1,model_stamp=?,expires=?
                        WHERE id=? AND state='running'""",
                (old["result"], stamp, now + RETENTION, job["id"]),
            ).rowcount
            if updated:
                db.execute("DELETE FROM chunks WHERE job=?", (job["id"],))
            return bool(updated)

    def finish(self, job: str, *, result=None, error=None, model_stamp=None):
        with self.db() as db:
            self.sweep(db)
            state = "failed" if error else "done"
            db.execute(
                """UPDATE jobs SET state=?,result=?,error=?,expires=?,model_stamp=?,
                       execution_options=CASE WHEN ? THEN execution_options ELSE NULL END
                       WHERE id=? AND state='running'""",
                (
                    state,
                    None if error else json.dumps(result, ensure_ascii=False),
                    error,
                    time.time() + RETENTION,
                    model_stamp,
                    bool(error),
                    job,
                ),
            )
            if state == "done":
                db.execute("DELETE FROM chunks WHERE job=?", (job,))
