"""Authenticated WANX transport for a user's independent knowledge space."""

from __future__ import annotations

import json
from typing import Any

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse

from wanx_bridge.semantica.client import SemanticaClient, SemanticaError


def create_host_routers(
    *, current_user, get_server, require_permission, application_id, model_host
):
    """Register the shared adapter using the host's authoritative dependencies."""
    from .models import configure_host

    configure_host(model_host)
    router = APIRouter(prefix="/semantica", tags=["semantica"])
    from .host_modeling import register_host_modeling

    register_host_modeling(
        router,
        current_user=current_user,
        get_server=get_server,
        require_permission=require_permission,
        application_id=application_id,
    )

    internal_router = APIRouter(prefix="/internal/starklink", tags=["semantica"])

    @internal_router.post("/models", include_in_schema=False)
    async def model_internal(request: Request, server: Any = Depends(get_server)) -> JSONResponse:
        if not request.client or request.client.host not in {"127.0.0.1", "::1"}:
            return JSONResponse({"code": "MODEL_AUTH_REQUIRED"}, status_code=403)
        from wanx_bridge.semantica.models import internal

        try:
            data = await internal(
                await request.body(),
                request.headers,
                server.services,
                request.is_disconnected,
            )
            return JSONResponse(data, headers={"Cache-Control": "no-store"})
        except SemanticaError as exc:
            from .output_diagnostics import sanitize_diagnostic

            detail = sanitize_diagnostic(getattr(exc, "output_diagnostic", None))
            return JSONResponse(
                {"code": exc.code, "message": exc.message or exc.code,
                 **({"output_diagnostic": detail} if exc.code == "MODEL_INVALID_OUTPUT"
                    and exc.status == 502 and detail else {})},
                status_code=exc.status,
                headers={"Cache-Control": "no-store"},
            )

    @router.get("/mcp/connection-info")
    async def mcp_connection_info(request: Request, user: Any = Depends(require_permission("knowledge_bases"))):
        from .mcp_connection import connection_info
        try:
            if application_id(user) not in {"wanx", "semantica", "centaurai.wanx.semantica"}:
                raise SemanticaError("SEMANTICA_RESOURCE_FORBIDDEN", 403)
            if request.query_params or await request.body():
                raise SemanticaError("SEMANTICA_INVALID_REQUEST", 422)
            return JSONResponse(connection_info(request), headers={"Cache-Control": "no-store"})
        except SemanticaError as exc:
            return JSONResponse({"code": exc.code, "message": None}, status_code=exc.status,
                headers={"Cache-Control": "no-store"})

    @router.get("/open/v1/{path:path}", operation_id="xingtu_open_read")
    @router.post("/open/v1/{path:path}", operation_id="xingtu_open_search")
    async def xingtu_open_request(
        path: str,
        request: Request,
        user: Any = Depends(current_user),
        server: Any = Depends(get_server),
    ) -> JSONResponse:
        try:
            service = SemanticaClient.from_file(
                server.services.paths.root / "semantica.json", user.id, application_id(user)
            )
            payload = None
            if request.method == "POST":
                data = await request.body()
                if len(data) > 128 * 1024:
                    raise SemanticaError("SEMANTICA_REQUEST_TOO_LARGE", 413)
                try:
                    payload = json.loads(data)
                    if not isinstance(payload, dict):
                        raise ValueError("invalid payload")
                except ValueError:
                    raise SemanticaError("SEMANTICA_INVALID_REQUEST", 422) from None
            result = await service.public_read(
                request.method,
                "/" + path,
                request.headers.get("x-xingtu-key", ""),
                payload=payload,
                query=dict(request.query_params),
            )
            return JSONResponse(result, headers={"Cache-Control": "no-store"})
        except SemanticaError as exc:
            return JSONResponse(
                {"code": exc.code, "message": exc.message},
                status_code=exc.status,
                headers={"Cache-Control": "no-store"},
            )

    from . import warehouse_contract

    def warehouse_endpoint(route):
        async def handle(
            request: Request,
            user: Any = Depends(require_permission("knowledge_bases")),
            server: Any = Depends(get_server),
        ):
            path = route.format_map(request.path_params).removeprefix("/")
            return await semantica_request(path, request, user, server)
        return handle

    for method, route, summary, model in warehouse_contract.ROUTES:
        router.add_api_route(
            route, warehouse_endpoint(route), methods=[method], summary=summary,
            openapi_extra=warehouse_contract.schema_extra(route, model),
        )

    @router.get(
        "/{path:path}",
        operation_id="semantica_read",
        summary="Read Semantica materials, jobs, knowledge or evidence",
    )
    @router.post(
        "/{path:path}",
        operation_id="semantica_create_or_search",
        summary="Import materials or retrieve evidence in your knowledge space",
    )
    @router.put(
        "/{path:path}",
        operation_id="semantica_update",
        summary="Update your Semantica protection settings",
    )
    @router.patch(
        "/{path:path}",
        operation_id="semantica_patch",
        summary="Apply an allowed Semantica workspace operation",
    )
    @router.delete(
        "/{path:path}",
        operation_id="semantica_delete_document",
        summary="Delete a document in the selected knowledge warehouse",
    )
    async def semantica_request(
        path: str,
        request: Request,
        user: Any = Depends(require_permission("knowledge_bases")),
        server: Any = Depends(get_server),
    ) -> JSONResponse:
        try:
            scope_mode = request.headers.get("x-wanx-data-context", "personal")
            if scope_mode not in {"personal", "team"}:
                raise SemanticaError("SEMANTICA_SCOPE_NOT_SELECTABLE", 403)
            team = scope_mode == "team"
            if team and (user.role != "admin" or application_id(user) != "wanx"):
                raise SemanticaError("SEMANTICA_ADMIN_REQUIRED", 403)
            if application_id(user) not in {
                "wanx",
                "semantica",
                "centaurai.wanx.semantica",
            }:
                raise SemanticaError("SEMANTICA_RESOURCE_FORBIDDEN", 403)
            service = SemanticaClient.from_file(
                server.services.paths.root / "semantica.json",
                user.id,
                application_id(user),
                team=team,
            )
            payload = None
            if request.method != "GET":
                data = await request.body()
                if len(data) > (
                    6 * 1024 * 1024 if path.endswith("/skills/import") else 2 * 1024 * 1024
                ):
                    raise SemanticaError("SEMANTICA_REQUEST_TOO_LARGE", 413)
                try:
                    payload = json.loads(data)
                    if not isinstance(payload, dict):
                        raise ValueError("invalid payload")
                except ValueError:
                    raise SemanticaError("SEMANTICA_INVALID_REQUEST", 422) from None
            if path == "search" and request.method == "POST":
                result = await service.search(payload or {})
            else:
                result = await service.request(
                    request.method,
                    "/" + path,
                    payload=payload,
                    query=dict(request.query_params),
                )
            if (
                team
                and request.method == "POST"
                and __import__("re").fullmatch(r"warehouses/[a-f0-9-]{36}/keys", path)
                and result.get("token")
            ):
                # Capture a newly issued Key inside WANX; deployment inputs contain only its id.
                record = {
                    "token": result["token"],
                    "warehouse": path.split("/")[1],
                    "box": service.config["box_id"],
                }
                server.services.secret_repo.get_or_create(
                    "studio-team-data/key/" + result["key"]["id"],
                    lambda: json.dumps(record).encode(),
                )
            return JSONResponse(result, headers={"Cache-Control": "no-store"})
        except SemanticaError as exc:
            return JSONResponse(
                {"code": exc.code, "message": exc.message},
                status_code=exc.status,
                headers={"Cache-Control": "no-store"},
            )

    # The hosting application mounts this extension at root. Keep memory's
    # public API alongside the existing private callback without changing the
    # Octop core or the callback's loopback authorization boundary.
    from ..memory_models import create_memory_model_router

    root_router = APIRouter()
    root_router.include_router(internal_router)
    root_router.include_router(create_memory_model_router(
        current_user=current_user,
        get_server=get_server,
        application_id=application_id,
        model_host=model_host,
    ))
    return router, root_router
