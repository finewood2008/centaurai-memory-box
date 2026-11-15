"""Owner-scoped Workshop archive and irreversible development-artifact cleanup.

Business records and installed applications are never deleted here. Cleanup is
serialized with edits by the store transaction; operation receipts survive purge.
"""

import json
import re
import shutil
import time
from copy import deepcopy

from fastapi import Depends
from pydantic import Field

from .contracts import Operation, StudioError, digest
from .local_authority import to_thread
from .store import public
from .versions import ensure, idle, state


class Manage(Operation):
    action: str = Field(pattern=r"^(rename|delete|restore|purge|clean-version)$")
    expectedRevision: int = Field(ge=0)
    artifactHash: str | None = Field(default=None, pattern=r"^[a-f0-9]{64}$")
    name: str | None = Field(default=None, min_length=1, max_length=128)
    confirmedByUser: bool = False


def protections(p):
    result = {}
    if p["artifacts"]:
        result[p["artifacts"][-1]["hash"]] = "最新成果"
    for h, reason in [
        (state(p)["adoptedHash"], "当前采用"),
        ((p.get("installed") or {}).get("artifactHash"), "已安装"),
    ]:
        if h:
            result[h] = reason
    # Failed/interrupted requests retain their retry baseline as well.
    for edit in p.get("_edits", {}).get("items", []):
        if edit["state"] not in {"completed", "no_change", "discussed", "cancelled"}:
            for key in ("baseHash", "requestedBaseHash"):
                if edit.get(key):
                    result[edit[key]] = "修改或重试所需"
    return result


def describe(p):
    result = public(p)
    result["deletedAt"] = p.get("_workshopArchivedAt")
    protected = protections(p)
    result["management"] = {
        "revision": state(p)["revision"],
        "bytes": len(json.dumps(p, ensure_ascii=False).encode()),
        "purgeBlocked": "已安装应用仍依赖此项目" if p.get("installed") else None,
        "versions": {
            a["hash"]: {
                "bytes": len(json.dumps(a, ensure_ascii=False).encode()),
                "protected": protected.get(a["hash"]),
            }
            for a in p["artifacts"]
        },
    }
    return result


def catalog(svc, owner):
    svc.authorize_management(owner)
    with svc.store.lock:
        return {"projects": [describe(p) for p in svc.store.list(owner, True)]}


def compact(svc, paths):
    # Only server-generated direct children may be removed; never follow symlinks.
    for area, identifier in paths:
        if area not in {"tasks", "edits"} or not re.fullmatch(r"[A-Za-z0-9_-]{1,80}", identifier):
            raise StudioError("WORKSHOP_CLEANUP_PATH_INVALID", 409)
        parent = svc.store.root / area
        if parent.is_symlink():
            raise StudioError("WORKSHOP_CLEANUP_PATH_INVALID", 409)
        path = parent / identifier
        if path.is_symlink():
            path.unlink()
        elif path.exists():
            shutil.rmtree(path)
    # Reclaim freed SQLite pages rather than merely hiding the rows.
    svc.store.db.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    svc.store.db.execute("VACUUM")
    svc.store.db.execute("PRAGMA wal_checkpoint(TRUNCATE)")


def manage(svc, owner, pid, body):
    svc.authorize_management(owner)
    signature = digest({"project": pid, **body})
    db = svc.store.db
    with svc.store.lock:
        db.execute(
            "CREATE TABLE IF NOT EXISTS workshop_cleanup_operations(owner TEXT,key TEXT,signature TEXT,result TEXT,PRIMARY KEY(owner,key))"
        )
        old = db.execute(
            "SELECT signature,result FROM workshop_cleanup_operations WHERE owner=? AND key=?",
            (owner, body["operationId"]),
        ).fetchone()
        if old:
            if old[0] != signature:
                raise StudioError("OPERATION_CONFLICT", 409)
            receipt = json.loads(old[1])
        else:
            with svc.store.transaction():
                p = svc.store.get(owner, pid, allow_deleted=True)
                idle(p)
                if state(p)["revision"] != body["expectedRevision"]:
                    raise StudioError("VERSION_CHANGED", 409)
                action, paths, cleaned = body["action"], [], 0
                if action == "rename":
                    name = (body.get("name") or "").strip()
                    if not name:
                        raise StudioError("PROJECT_NAME_REQUIRED", 422)
                    from .contracts import has_credentials

                    if has_credentials(name):
                        raise StudioError("INPUT_CREDENTIAL_DETECTED", 422)
                    p.update(name=name, nameMode="manual")
                elif action in {"delete", "restore"}:
                    p["_workshopArchivedAt"] = time.time() if action == "delete" else None
                else:
                    if not body.get("confirmedByUser"):
                        raise StudioError("USER_CLEANUP_REQUIRED", 409)
                    if action == "purge":
                        if not p.get("_workshopArchivedAt"):
                            raise StudioError("WORKSHOP_ARCHIVE_REQUIRED", 409)
                        if p.get("installed"):
                            raise StudioError("WORKSHOP_INSTALLED_PROJECT", 409)
                        paths = [("tasks", t["id"]) for t in p["tasks"]] + [
                            ("edits", e["id"]) for e in p.get("_edits", {}).get("items", [])
                        ]
                        cleaned = len(json.dumps(p, ensure_ascii=False).encode())
                        db.execute(
                            "DELETE FROM task_events WHERE owner=? AND project=?", (owner, pid)
                        )
                        db.execute("DELETE FROM usage WHERE owner=? AND task=?", (owner, pid))
                        db.execute("DELETE FROM projects WHERE owner=? AND id=?", (owner, pid))
                    else:
                        h = body.get("artifactHash")
                        a = next((a for a in p["artifacts"] if a["hash"] == h), None)
                        if a is None:
                            raise StudioError("ARTIFACT_NOT_FOUND", 404)
                        if h in protections(p):
                            raise StudioError("WORKSHOP_VERSION_PROTECTED", 409)
                        # Keep small schema/audit records, never historical source or PRD blobs.
                        p.setdefault("_cleanedVersions", []).append(
                            {
                                k: deepcopy(a.get(k))
                                for k in ("hash", "version", "manifest", "baseHash")
                            }
                        )
                        p["_versionSequence"] = max(
                            int(a["version"].split(".")[-1])
                            for a in p["artifacts"] + p["_cleanedVersions"]
                        )
                        cleaned = len(json.dumps(a, ensure_ascii=False).encode())
                        p["artifacts"] = [v for v in p["artifacts"] if v["hash"] != h]
                        paths = [("tasks", a["taskId"])]
                        for task in p["tasks"]:
                            if task["id"] == a["taskId"]:
                                task.pop("change", None)
                                task["events"] = []
                                task["cleanedAt"] = time.time()
                        for edit in p.get("_edits", {}).get("items", []):
                            if edit.get("artifactHash") == h:
                                paths.append(("edits", edit["id"]))
                                for key in (
                                    "visualReview",
                                    "draft",
                                    "change",
                                    "snapshot",
                                    "stream",
                                ):
                                    edit.pop(key, None)
                        db.execute(
                            "DELETE FROM task_events WHERE owner=? AND project=? AND task=?",
                            (owner, pid, a["taskId"]),
                        )
                    for token, session in list(svc.runtime_sessions.items()):
                        if (
                            session["owner"] == owner
                            and session["project"] == pid
                            and (
                                action == "purge" or session["artifact"] == body.get("artifactHash")
                            )
                        ):
                            del svc.runtime_sessions[token]
                if action == "clean-version":
                    used = {a["solutionHash"] for a in p["artifacts"]} | {digest(p["solution"])}
                    p["revisions"] = [r for r in p["revisions"] if r["hash"] in used]
                    for iteration in ensure(p)["iterations"]:
                        if (
                            iteration.get("artifactHash") == body["artifactHash"]
                            or iteration.get("latestHash") == body["artifactHash"]
                        ):
                            iteration.pop("draft", None)
                if action != "purge":
                    ensure(p)["revision"] += 1
                    svc.store.save(p)
                # Erase duplicate historical response snapshots but keep operation fingerprints,
                # so a delayed copy/edit retry cannot recreate a purged project or old version.
                replacement = {"id": pid, "purged": True} if action == "purge" else public(p)
                if action in {"clean-version", "purge"}:
                    db.execute(
                        "UPDATE operations SET result=? WHERE owner=? AND json_extract(result,'$.id')=?",
                        (json.dumps(replacement, ensure_ascii=False), owner, pid),
                    )
                receipt = {"purged": action == "purge", "cleanedBytes": cleaned, "paths": paths}
                db.execute(
                    "INSERT INTO workshop_cleanup_operations VALUES(?,?,?,?)",
                    (
                        owner,
                        body["operationId"],
                        signature,
                        json.dumps(receipt, ensure_ascii=False),
                    ),
                )
        if receipt["paths"] or body["action"] in {"clean-version", "purge"}:
            compact(svc, receipt["paths"])
        # Return current state on retry, never revive an outdated artifact list.
        project = None if receipt["purged"] else describe(svc.store.get(owner, pid, True))
        return {
            "project": project,
            "purged": receipt["purged"],
            "cleanedBytes": receipt["cleanedBytes"],
        }


def mount(router, svc, identity):
    auth = Depends(identity)

    @router.get("/_management/projects", include_in_schema=False)
    async def listing(owner=auth):
        return await to_thread(catalog, svc, owner)

    @router.post("/_management/projects/{project_id}", include_in_schema=False)
    async def change(project_id: str, body: Manage, owner=auth):
        async with svc.edits.lock(owner, project_id):
            return await to_thread(manage, svc, owner, project_id, body.model_dump())
