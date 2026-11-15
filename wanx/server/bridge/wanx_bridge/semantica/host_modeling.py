"""Finite onboarding routes for the existing loopback Octop development Host.

Shares the Bridge desktop contract, while Octop remains the authentication and
permission authority. No platform session is fabricated and no owner API is
exposed directly to the renderer.
"""

from __future__ import annotations

import asyncio
from typing import Any

import httpx
from centuarai_local_data_gate import load_required_policy
from fastapi import Depends, Request
from fastapi.responses import JSONResponse, Response
from starlette.requests import ClientDisconnect

from . import modeling_contract
from .client import SemanticaClient, SemanticaError
from .desktop import APPS, DesktopError, request_json, resolve
from .desktop_routes import desktop_input, live_request
from .maintenance import MaintenanceError, request_guard
from .transport_contract import grant_ttl


def register_host_modeling(router, *, current_user, get_server, require_permission, application_id):
    permission = require_permission("knowledge_bases")

    def endpoint(route):
        async def handle(
            request: Request,
            user: Any = Depends(permission),
            server: Any = Depends(get_server),
        ):
            drained = asyncio.Event()

            async def check_identity():
                # current_user normally caches the initial identity on request.state.
                # Revalidate the original native token without that cache so account
                # disablement, expiry and permission changes cancel model work.
                scope = dict(request.scope)
                scope["state"] = {}
                fresh = await current_user(
                    Request(scope),
                    server=server,
                    authorization=request.headers.get("authorization"),
                    access_token=None,
                )
                await permission(fresh)
                if (fresh.id, application_id(fresh)) != (user.id, application_id(user)):
                    raise DesktopError("SEMANTICA_RESOURCE_FORBIDDEN", 403)

            async def watch():
                while True:
                    await asyncio.sleep(1)
                    await check_identity()

            async def execute():
                if not request.client or request.client.host not in {"127.0.0.1", "::1"}:
                    raise DesktopError("SEMANTICA_RESOURCE_FORBIDDEN", 403)
                if await asyncio.to_thread(load_required_policy) is not None:
                    raise DesktopError("LOCAL_DATA_REQUIRED", 503)
                if request.headers.get("x-wanx-data-context", "personal") != "personal":
                    raise DesktopError("MODELING_HOST_CREATION_REQUIRED", 403)
                if application_id(user) not in APPS:
                    raise DesktopError("SEMANTICA_RESOURCE_FORBIDDEN", 403)
                await check_identity()
                operation = resolve(request.method, route.format(**request.path_params))
                _, body, operation_id, query = await desktop_input(request, operation, drained)
                service = await asyncio.to_thread(
                    SemanticaClient.from_file,
                    server.services.paths.root / "semantica.json",
                    user.id,
                    application_id(user),
                )
                headers = service.headers(
                    operation_id,
                    operation.warehouse,
                    ttl=grant_ttl(operation.timeout),
                )
                target = modeling_contract.upstream_path(operation.path, headers)
                try:
                    with request_guard(
                        server.services.paths.root, request.method, "/api/integration" + target
                    ):
                        async with (
                            asyncio.timeout(operation.timeout),
                            httpx.AsyncClient(trust_env=False, follow_redirects=False) as client,
                        ):
                            status, value = await request_json(
                                client,
                                request.method,
                                service.base_url + "/api/integration" + target,
                                headers=headers,
                                payload=body,
                                query=query,
                                timeout=operation.timeout,
                                modeling=True,
                            )
                except MaintenanceError:
                    raise SemanticaError("SEMANTICA_MAINTENANCE") from None
                await check_identity()
                return JSONResponse(
                    value, status_code=status, headers={"Cache-Control": "no-store"}
                )

            try:
                return await live_request(request, execute(), watch(), drained)
            except (DesktopError, SemanticaError) as exc:
                return JSONResponse(
                    {"code": exc.code, "message": exc.message},
                    status_code=exc.status,
                    headers={"Cache-Control": "no-store"},
                )
            except TimeoutError:
                return JSONResponse(
                    {"code": "SEMANTICA_SERVICE_TIMEOUT"},
                    status_code=504,
                    headers={"Cache-Control": "no-store"},
                )
            except ClientDisconnect:
                return Response(status_code=499)

        return handle

    for method, route, summary, model in modeling_contract.API_ROUTES:
        router.add_api_route(
            route,
            endpoint(route),
            methods=[method],
            summary=summary,
            openapi_extra=modeling_contract.openapi_extra(route, model),
        )
