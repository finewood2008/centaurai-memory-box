"""Desktop-only preview adapter; every read rechecks the original file's scope."""

from __future__ import annotations

import hashlib
from collections.abc import Callable
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from fastapi import Path as Parameter

from octop.api.deps import current_user, get_server
from octop.api.routers.personal_space import call, space
from octop.infra.personal_space.mcp_access import SpaceMcp
from octop.infra.personal_space.previews import DocumentPreview
from octop.infra.personal_space.service import CHUNK_SIZE, PersonalSpace, SpaceError

router = APIRouter(include_in_schema=False)


async def source(
    item_id: str = Parameter(pattern=r"^[a-f0-9]{32}$"),
    version: int = Query(ge=1),
    drive: str = Query(default="", pattern=r"^([a-f0-9]{32})?$"),
    service: PersonalSpace = Depends(space),
    user: Any = Depends(current_user),
    server: Any = Depends(get_server),
) -> tuple[DocumentPreview, Callable[[int, int], bytes]]:
    if getattr(user, "application_id", "wanx") != "wanx":
        raise HTTPException(403, detail={"code": "SPACE_FORBIDDEN"})

    def bind() -> tuple[DocumentPreview, Callable[[int, int], bytes]]:
        root: Path = service.root
        if drive:

            def authority() -> SpaceMcp:
                return SpaceMcp(
                    server.paths.root,
                    user.id,
                    user.display_name or user.username,
                    admin=user.role == "admin",
                )

            hub = authority()
            entry = hub.drive_files(drive, "stat", {"id": item_id})
            with hub.db() as db:
                domain = hub.drive(db, drive)["domain"]
            root = hub.storage(domain).root

            def read(offset: int, length: int) -> bytes:
                import base64

                value = authority().drive_files(
                    drive, "read", {"id": item_id, "offset": offset, "length": length}
                )
                if value["info"]["version"] != version:
                    raise SpaceError("SPACE_REMOTE_FILE_CHANGED", 409)
                return base64.b64decode(value["data"])
        else:
            entry = service.metadata(item_id)

            def read(offset: int, length: int) -> bytes:
                raw, current = service.read_chunk(item_id, offset, length)
                if current["version"] != version:
                    raise SpaceError("SPACE_REMOTE_FILE_CHANGED", 409)
                return raw

        if entry["version"] != version:
            raise SpaceError("SPACE_REMOTE_FILE_CHANGED", 409)
        return DocumentPreview(root, entry), read

    return await call(bind)


@router.post("/{item_id}")
async def prepare(
    bound: tuple[DocumentPreview, Callable[[int, int], bytes]] = Depends(source),
) -> Any:
    preview, read = bound
    return await call(preview.prepare, read)


@router.get("/{item_id}")
async def status(
    bound: tuple[DocumentPreview, Callable[[int, int], bytes]] = Depends(source),
) -> Any:
    return await call(bound[0].status)


@router.get("/{item_id}/content")
async def content(
    offset: int = Query(default=0, ge=0),
    length: int = Query(default=CHUNK_SIZE, ge=1, le=CHUNK_SIZE),
    bound: tuple[DocumentPreview, Callable[[int, int], bytes]] = Depends(source),
) -> Response:
    raw = await call(bound[0].content, offset, length)
    return Response(
        raw,
        media_type="application/octet-stream",
        headers={
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
            "X-Content-SHA256": hashlib.sha256(raw).hexdigest(),
        },
    )
