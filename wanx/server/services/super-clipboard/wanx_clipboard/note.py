"""Owner/box notes; manifests use existing WANX file APIs."""

import hashlib
import json
import time

from .upstream import CHUNK_SIZE, PREFIX, BusinessError, valid_id

NOTE_LIMIT = 1024 * 1024
MAX_NOTES = 100


def initialize(db):
    db.executescript("""
        CREATE TABLE IF NOT EXISTS clipboard_note (
            singleton INTEGER PRIMARY KEY CHECK(singleton=1), revision INTEGER NOT NULL,
            current TEXT NOT NULL, backup TEXT NOT NULL, updated REAL NOT NULL
        );
        INSERT OR IGNORE INTO clipboard_note VALUES(1,0,'{}','{}',0);
        CREATE TABLE IF NOT EXISTS clipboard_note_receipts (
            operation TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, revision INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS clipboard_note_assets (id TEXT PRIMARY KEY);
        CREATE TABLE IF NOT EXISTS clipboard_note_gc (id TEXT PRIMARY KEY, size INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS clipboard_extra_notes (
            id TEXT PRIMARY KEY, revision INTEGER NOT NULL, current TEXT NOT NULL,
            backup TEXT NOT NULL, updated REAL NOT NULL, title TEXT NOT NULL DEFAULT '',
            deleted INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS clipboard_extra_note_assets (
            note_id TEXT NOT NULL, id TEXT NOT NULL, PRIMARY KEY (note_id,id)
        );
        CREATE INDEX IF NOT EXISTS clipboard_extra_note_asset_ids
          ON clipboard_extra_note_assets(id);
    """)


def validate(blocks):
    if not isinstance(blocks, list) or len(blocks) > 2000:
        raise BusinessError("CLIPBOARD_NOTE_LIMIT", 413)
    result = []
    for b in blocks:
        if not isinstance(b, dict):
            raise BusinessError("CLIPBOARD_INVALID")
        if b.get("type") == "text" and set(b) == {"type", "text"} and isinstance(b["text"], str):
            if b["text"]:
                if result and result[-1]["type"] == "text":
                    result[-1]["text"] += b["text"]
                else:
                    result.append(dict(b))
        elif b.get("type") == "image" and set(b) == {"type", "item"}:
            result.append({"type": "image", "item": valid_id(b["item"])})
        else:
            raise BusinessError("CLIPBOARD_INVALID")
    if len(encode(result)) > NOTE_LIMIT:
        raise BusinessError("CLIPBOARD_NOTE_LIMIT", 413)
    return result


def encode(blocks):
    return json.dumps(blocks, ensure_ascii=False, separators=(",", ":")).encode()


def usage(db):
    rows = db.execute(
        "SELECT current,backup FROM clipboard_note UNION ALL "
        "SELECT current,backup FROM clipboard_extra_notes WHERE deleted=0"
    )
    return (
        sum(json.loads(row[k]).get("size", 0) for row in rows for k in ("current", "backup"))
        + db.execute("SELECT COALESCE(SUM(size),0) FROM clipboard_note_gc").fetchone()[0]
    )


class SharedNote:
    def __init__(self, clipboard, note_id=None):
        self.clip = clipboard
        self.api = clipboard.api
        self.note_id = None if note_id is None else valid_id(note_id)

    def _row(self, db):
        if self.note_id is None:
            return db.execute("SELECT * FROM clipboard_note WHERE singleton=1").fetchone()
        return db.execute(
            "SELECT * FROM clipboard_extra_notes WHERE id=?", (self.note_id,)
        ).fetchone()

    def list(self):
        with self.clip._db() as db:
            rows = db.execute(
                "SELECT id, title, revision, updated FROM clipboard_extra_notes "
                "WHERE deleted=0 ORDER BY updated DESC, id"
            )
            return {"items": [dict(row) for row in rows]}

    def _blocks(self, ref):
        if not ref:
            return []
        meta = self.api.metadata(ref["id"])
        if any(meta[k] != ref[k] for k in ("size", "digest")) or meta["space_id"] != "personal":
            raise BusinessError("CLIPBOARD_CONTENT_CHANGED", 409)
        data = b"".join(
            self.api.read(ref["id"], n, min(CHUNK_SIZE, ref["size"] - n))
            for n in range(0, ref["size"], CHUNK_SIZE)
        )
        if hashlib.sha256(data).hexdigest() != ref["digest"]:
            raise BusinessError("SPACE_CHUNK_INVALID", 409)
        return validate(json.loads(data))

    def _get(self, db, since=None):
        row = self._row(db)
        if row is None:
            return {"revision": 0, "updated": 0, "has_backup": False, "blocks": []}
        result = {
            "revision": row["revision"],
            "updated": row["updated"],
            "has_backup": bool(json.loads(row["backup"])),
        }
        if self.note_id is not None:
            result["title"] = row["title"]
            if row["deleted"]:
                result["deleted"] = True
        if since == row["revision"]:
            return result | {"unchanged": True}
        return result | {"blocks": self._blocks(json.loads(row["current"]))}

    def get(self, since=None):
        with self.clip._db() as db:
            return self._get(db, since)

    def _publish(self, operation, data):
        digest = hashlib.sha256(data).hexdigest()
        try:
            meta = self.api.metadata(operation)
        except BusinessError as exc:
            if exc.status != 404:
                raise
            status = self.api.upload(operation, self.api.folder(), "共享便笺.json", len(data))
            offset = status["offset"]
            while offset < len(data):
                piece = data[offset : offset + CHUNK_SIZE]
                status = self.api.request(
                    PREFIX + f"/uploads/{operation}?offset={offset}", "PUT", data=piece
                )
                if status["offset"] != offset + len(piece):
                    raise BusinessError("SPACE_UPLOAD_OFFSET_INVALID", 409) from None
                offset = status["offset"]
            meta = self.api.request(
                PREFIX + f"/uploads/{operation}/complete", "POST", body={"digest": digest}
            )
        if meta["digest"] != digest or meta["size"] != len(data) or meta["space_id"] != "personal":
            raise BusinessError("CLIPBOARD_BATCH_CONFLICT", 409)
        return {"id": operation, "size": len(data), "digest": digest}

    def _gc(self, db):
        for row in db.execute("SELECT id FROM clipboard_note_gc").fetchall():
            try:
                self.clip._clip_recycle_file(row["id"])
                self.api.request(PREFIX + f"/trash/{row['id']}", "DELETE")
            except BusinessError as exc:
                if exc.status != 404:
                    continue
            db.execute("DELETE FROM clipboard_note_gc WHERE id=?", (row["id"],))

    def _set_assets(self, db, images):
        if self.note_id is None:
            previous = {row["id"] for row in db.execute("SELECT id FROM clipboard_note_assets")}
            db.execute("DELETE FROM clipboard_note_assets")
            db.executemany("INSERT INTO clipboard_note_assets VALUES(?)", [(i,) for i in images])
        else:
            previous = {
                row["id"] for row in db.execute(
                    "SELECT id FROM clipboard_extra_note_assets WHERE note_id=?", (self.note_id,)
                )
            }
            db.execute("DELETE FROM clipboard_extra_note_assets WHERE note_id=?", (self.note_id,))
            db.executemany(
                "INSERT INTO clipboard_extra_note_assets VALUES(?,?)",
                [(self.note_id, i) for i in images],
            )
        from .service import RETENTION

        db.executemany(
            "UPDATE clipboard_items SET expires=? WHERE id=? AND pinned=0 "
            "AND id NOT IN (SELECT id FROM clipboard_note_assets) "
            "AND id NOT IN (SELECT id FROM clipboard_extra_note_assets)",
            [(time.time() + RETENTION, i) for i in previous - images],
        )
        db.executemany("UPDATE clipboard_items SET expires=NULL WHERE id=?", [(i,) for i in images])

    def save(self, expected, operation, blocks, action="save"):
        valid_id(operation)
        blocks = validate(blocks)
        fields = {"expected": expected, "blocks": blocks, "action": action}
        if self.note_id is not None:
            fields["note_id"] = self.note_id
        fingerprint = hashlib.sha256(
            encode(fields)
        ).hexdigest()
        with self.clip._db() as db:
            receipt = db.execute(
                "SELECT * FROM clipboard_note_receipts WHERE operation=?", (operation,)
            ).fetchone()
            if receipt:
                if receipt["fingerprint"] != fingerprint:
                    raise BusinessError("CLIPBOARD_BATCH_CONFLICT", 409)
                return self._get(db) | {"accepted_revision": receipt["revision"]}
            row = self._row(db)
            if row is None and self.note_id is not None and expected == 0 and action == "save":
                count = db.execute(
                    "SELECT count(*) FROM clipboard_extra_notes WHERE deleted=0"
                ).fetchone()[0]
                if count >= MAX_NOTES:
                    raise BusinessError("CLIPBOARD_NOTE_COUNT_LIMIT", 413)
                db.execute(
                    "INSERT INTO clipboard_extra_notes (id,revision,current,backup,updated) "
                    "VALUES(?,0,'{}','{}',0)", (self.note_id,),
                )
                row = self._row(db)
            if row is None or (self.note_id is not None and row["deleted"]):
                raise BusinessError("CLIPBOARD_NOTE_DELETED", 409)
            if row["revision"] != expected:
                raise BusinessError("CLIPBOARD_NOTE_CONFLICT", 409)
            current, backup = json.loads(row["current"]), json.loads(row["backup"])
            if action == "restore":
                if not backup:
                    raise BusinessError("CLIPBOARD_NOT_FOUND", 404)
                blocks = self._blocks(backup)
            elif action == "clear" or (action == "delete" and self.note_id is not None):
                blocks = []
            elif action != "save":
                raise BusinessError("CLIPBOARD_INVALID")
            images = {b["item"] for b in blocks if b["type"] == "image"}
            for item_id in images:
                item = self.clip._clip_item(db, item_id)
                if item["kind"] != "image" or item["state"] != "ready":
                    raise BusinessError("CLIPBOARD_NOT_READY", 409)
            data = encode(blocks)
            self._gc(db)
            from .service import CLIPBOARD_LIMIT

            if action != "delete" and self.clip.clipboard_usage(db)["reserved"] + len(data) > CLIPBOARD_LIMIT:
                raise BusinessError("CLIPBOARD_QUOTA", 413)
            ref = {} if action == "delete" else self._publish(operation, data)
            next_backup = {} if action == "delete" else current if action in {"clear", "restore"} else backup
            for old in (current, backup):
                if old and old != next_backup:
                    db.execute(
                        "INSERT OR IGNORE INTO clipboard_note_gc VALUES(?,?)",
                        (old["id"], old["size"]),
                    )
            revision = row["revision"] + 1
            updated = time.time()
            values = (revision, json.dumps(ref), json.dumps(next_backup), updated)
            title = next(
                (line.strip()[:70] for b in blocks if b["type"] == "text"
                 for line in b["text"].splitlines() if line.strip()), ""
            )
            if self.note_id is None:
                db.execute(
                    "UPDATE clipboard_note SET revision=?,current=?,backup=?,updated=? WHERE singleton=1",
                    values,
                )
            else:
                db.execute(
                    "UPDATE clipboard_extra_notes SET revision=?,current=?,backup=?,updated=?,"
                    "title=?,deleted=? WHERE id=?", (*values, title, int(action == "delete"), self.note_id),
                )
            db.execute(
                "INSERT INTO clipboard_note_receipts VALUES(?,?,?)",
                (operation, fingerprint, revision),
            )
            if next_backup:
                images.update(b["item"] for b in self._blocks(next_backup) if b["type"] == "image")
            self._set_assets(db, images)
            self.clip._clip_changed(db)
            result = {
                "revision": revision,
                "blocks": blocks,
                "updated": updated,
                "has_backup": bool(next_backup),
                "accepted_revision": revision,
            }
            if self.note_id is not None:
                result["title"] = title
                if action == "delete":
                    result["deleted"] = True
        # Publication is durable before old internal manifests are collected.
        with self.clip._db() as db:
            self._gc(db)
        return result
