"""Bind a personal Space to an attached filesystem using its own object directory."""

from __future__ import annotations

import re
import sqlite3
import time
import uuid
from pathlib import Path
from typing import Any

from .service import PersonalSpace, SpaceError, validate_name
from .storage import destination, info, safe_directory

_VOLUME = re.compile(r"[A-Za-z0-9_.:-]{1,128}")
_PRIVATE = ".wanx-personal-space"


def mounted_directory(path: str) -> Path:
    selected = Path(path)
    roots = (Path("/run/media"), Path("/media"), Path("/mnt"))
    if not selected.is_absolute() or not any(
        selected != root and selected.is_relative_to(root) for root in roots
    ):
        raise SpaceError("SPACE_STORAGE_PATH_INVALID")
    safe_directory(selected)
    if selected != selected.resolve():
        raise SpaceError("SPACE_STORAGE_PATH_INVALID")
    if not selected.is_mount():
        raise SpaceError("SPACE_VOLUME_OFFLINE", 409)
    return selected


def mounted_space(service: PersonalSpace, volume: str, name: str, mount: str) -> dict[str, Any]:
    if service.root.name == "company" or not _VOLUME.fullmatch(volume):
        raise SpaceError("SPACE_INVALID_VOLUME")
    selected = mounted_directory(mount)
    name = validate_name(name)
    with service._db() as db:
        binding = db.execute(
            "SELECT space_id FROM space_mounted_volumes WHERE volume=?", (volume,)
        ).fetchone()
        if binding:
            space_id = binding["space_id"]
            row = db.execute(
                "SELECT * FROM spaces WHERE id=? AND trashed IS NULL", (space_id,)
            ).fetchone()
            if row is None:
                raise SpaceError("SPACE_NOT_FOUND", 404)
            current = db.execute(
                "SELECT directory FROM space_storage WHERE space_id=?", (space_id,)
            ).fetchone()
            if current is None:
                raise SpaceError("SPACE_VOLUME_OFFLINE", 409)
            namespace = db.execute(
                "SELECT value FROM space_storage_meta WHERE key='namespace'"
            ).fetchone()[0]
            directory = selected / _PRIVATE / namespace / space_id
            # A remount can give the same volume a different path. Verify the
            # private directory already exists before rebinding any objects.
            safe_directory(directory)
            if directory.stat().st_dev != selected.stat().st_dev:
                raise SpaceError("SPACE_VOLUME_OFFLINE", 409)
            if str(directory) != current["directory"]:
                db.execute(
                    "UPDATE object_locations SET directory=? WHERE directory=?",
                    (str(directory), current["directory"]),
                )
                update_storage(db, space_id, selected, directory)
            root = row["root"]
            if name != row["name"]:
                db.execute("UPDATE spaces SET name=? WHERE id=?", (name, space_id))
                db.execute(
                    "UPDATE entries SET name=? WHERE id=?",
                    (service._name(db, "", name, root), root),
                )
        else:
            space_id, root = uuid.uuid4().hex, uuid.uuid4().hex
            now = time.time()
            directory = destination(
                service, db, space_id, str(selected), private_directory=_PRIVATE
            )
            if not selected.is_mount() or directory.stat().st_dev != selected.stat().st_dev:
                raise SpaceError("SPACE_VOLUME_OFFLINE", 409)
            db.execute("INSERT INTO spaces VALUES(?,?,?,?,NULL)", (space_id, name, root, now))
            db.execute(
                "INSERT INTO entries(id,parent,name,kind,modified,space_id) VALUES(?,'',?,'folder',?,?)",
                (root, service._name(db, "", name), now, space_id),
            )
            db.execute("INSERT INTO space_mounted_volumes VALUES(?,?)", (volume, space_id))
            update_storage(db, space_id, selected, directory)
        return {
            "id": space_id,
            "root": root,
            "name": name,
            "volume": volume,
            "kind": "volume-space",
            "domain": "personal",
            "writable": True,
            "storage": info(service, db, space_id),
        }


def update_storage(db: sqlite3.Connection, space_id: str, mount: Path, directory: Path) -> None:
    db.execute(
        "INSERT OR REPLACE INTO space_storage VALUES(?,?,?)",
        (space_id, str(mount), str(directory)),
    )
