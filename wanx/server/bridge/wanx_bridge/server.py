"""Public WANX boundary with leased streaming to independent HTTP services.

No upstream implementation modules, database files, or signing secrets are used here.
Octop stays on loopback; native Semantica uses its separately configured origin.
Only the adapter holds an ordinary Octop login session. Public callers use an
opaque bridge token whose authority is checked for the entire request/stream.
The two independent MCP endpoints instead retain their own scoped bearer keys;
their upstream verifiers own authorization, without a platform login session.
"""

from __future__ import annotations

import asyncio
import contextlib
import inspect
import json
import posixpath
import re
from collections.abc import AsyncIterator, Callable, Mapping
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any
from urllib.parse import parse_qsl, quote, unquote, urlencode, urlsplit

import anyio
import httpx
from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse, Response, StreamingResponse
from starlette.datastructures import Headers, QueryParams
from starlette.requests import ClientDisconnect
from websockets.asyncio.client import connect as ws_connect
from websockets.exceptions import ConnectionClosed, InvalidHandshake

from .assets import DashboardAssets, installed_dashboard
from .browser_expert import BrowserExpertPreparer
from .config import BridgeAuthError
from .huohua import HuohuaCapabilityGateway
from .managed_resource_guard import ManagedResourceGuard
from .readiness import diagnose_application
from .semantica import DEFAULT_URL as SEMANTICA_URL
from .semantica import create_router as semantica_router
from .semantica.desktop_routes import create_desktop_router
from .service_health import service_status
from .service_registry import SERVICE_ID, ServiceRegistry
from .service_sessions import ServiceSessionVerifier
from .upstream import BridgeUpstreamError
from .version import bridge_build_metadata, version_snapshot
from .zhijun_bootstrap import recover_private_profile

_HOP = frozenset(
    {
        "connection",
        "keep-alive",
        "proxy-authenticate",
        "proxy-authorization",
        "te",
        "trailer",
        "transfer-encoding",
        "upgrade",
        "host",
    }
)
_SECRET_RESPONSE = frozenset({"set-cookie", "x-octop-access-token", "authorization"})
_TOKEN_PARAMS = frozenset({"token", "access_token"})
_PUBLIC = frozenset({"/api/health"})
_MCP_ENDPOINTS = frozenset({"/mcp/space", "/mcp/starlink"})
_PROFILE = frozenset(
    {
        ("GET", "/api/auth/me"),
        ("PATCH", "/api/auth/me"),
        ("POST", "/api/auth/me/avatar"),
        ("DELETE", "/api/auth/me/avatar"),
    }
)


def _field(session: Any, name: str) -> Any:
    return session[name] if isinstance(session, Mapping) else getattr(session, name)


async def _call(fn: Any, *args: Any) -> Any:
    result = fn(*args)
    return await result if inspect.isawaitable(result) else result


def _error(code: str, status: int = 401) -> BridgeAuthError:
    return BridgeAuthError(code, status)


def _credentials(headers: Headers, query: QueryParams, *, required: bool) -> str | None:
    """Reject ambiguous credentials instead of selecting an attacker-controlled one."""
    values = []
    for header in headers.getlist("authorization"):
        scheme, _, value = header.partition(" ")
        if scheme.lower() != "bearer" or not value or value.strip() != value:
            raise _error("BOX_PLATFORM_AUTH_REQUIRED")
        values.append(value)
    values.extend(v for k, v in query.multi_items() if k in _TOKEN_PARAMS)
    if any(not v for v in values) or len(set(values)) > 1:
        raise _error("BOX_PLATFORM_AUTH_CONFLICT")
    if not values:
        if required:
            raise _error("BOX_PLATFORM_AUTH_REQUIRED")
        return None
    return values[0]


def _allowed(path: str, method: str) -> bool:
    # Local management belongs exclusively to its pinned HTTPS listener.
    # Reserve the whole namespace for every verb/WS, including aliases that an
    # intermediate URL parser could otherwise normalize after this boundary.
    decoded = path
    while True:
        normalized = unquote(decoded)
        if normalized == decoded:
            break
        decoded = normalized
    management_path = "/" + posixpath.normpath(decoded.replace("\\", "/")).lstrip("/")
    if management_path.casefold().startswith("/local-trust"):
        return False
    # Match decoded ASGI paths, reject traversal and slash aliases before httpx
    # normalizes them. Never forward public /docs or /.well-known provider routes.
    if "\\" in path or "//" in path or any(p in {".", ".."} for p in path.split("/")):
        return False
    if path == "/mcp" or path.startswith("/mcp/"):
        return path in _MCP_ENDPOINTS and method in {"GET", "POST", "DELETE"}
    if method == "WEBSOCKET" and (
        path in {"/api/clipboard/v1", "/api/huohua/v1", "/api/services"}
        or path.startswith(("/api/clipboard/v1/", "/api/huohua/v1/", "/api/services/"))
    ):
        return False
    if path in {"/docs", "/redoc", "/openapi.json"} or path.startswith(
        ("/.well-known", "/oidc", "/internal")
    ):
        return False
    if path.startswith("/api/auth"):
        return (method, path) in _PROFILE
    # Dashboard boot probes setup before /auth/me. This read-only exception
    # still requires the current platform session in proxy(), unlike /api/health.
    if path == "/api/setup/status" and method == "GET":
        return True
    if path.startswith(("/api/setup", "/api/config", "/api/internal")):
        return False
    # The platform owns identities and role authority. Even a current Owner
    # must not persistently promote a different platform member in upstream DB.
    if path.startswith("/api/users") and method not in {"GET", "HEAD"}:
        return False
    # Metadata is safe to inspect with a live session and upstream backup
    # permission. Archives contain JWT/OIDC secrets; transfer and restoration
    # remain local-administration operations.
    if path.startswith("/api/admin/backup"):
        return method == "GET" and path in {
            "/api/admin/backup/list",
            "/api/admin/backup/status",
            "/api/admin/backup/auto",
        }
    return True


def _headers(headers: Any, token: str | None, *, websocket: bool = False) -> list[tuple[str, str]]:
    connection = {v.strip().lower() for v in headers.get("connection", "").split(",")}
    blocked = _HOP | connection | {"authorization", "cookie", "forwarded"}
    output = [
        (k, v)
        for k, v in headers.items()
        if k.lower() not in blocked and not k.lower().startswith(("x-forwarded-", "sec-websocket-"))
    ]
    if token:
        output.append(("authorization", f"Bearer {token}"))
    if websocket:
        output = [(k, v) for k, v in output if k.lower() not in {"origin", "content-length"}]
    return output


def _target(origin: str, path: str, query: Any, token: str | None) -> str:
    params = [
        (k, token if k in _TOKEN_PARAMS and token else v)
        for k, v in query.multi_items()
        if k not in _TOKEN_PARAMS or token
    ]
    suffix = urlencode(params)
    return origin + quote(path, safe="/") + ("?" + suffix if suffix else "")


def _response_headers(response: httpx.Response, origin: str) -> dict[str, str]:
    connection = {v.strip().lower() for v in response.headers.get("connection", "").split(",")}
    blocked = _HOP | _SECRET_RESPONSE | connection
    output = {k: v for k, v in response.headers.items() if k.lower() not in blocked}
    if "location" in output:
        try:
            location = urlsplit(output["location"])
        except ValueError as exc:
            raise _error("BOX_PLATFORM_UPSTREAM_REDIRECT", 502) from exc
        # Never hand an upstream JWT, OAuth code, or external credential redirect
        # to a renderer. Relative ordinary app redirects remain supported.
        if location.fragment or any(
            k.lower() in _TOKEN_PARAMS | {"code", "id_token"} for k, _ in parse_qsl(location.query)
        ):
            raise _error("BOX_PLATFORM_UPSTREAM_REDIRECT", 502)
        if location.netloc:
            base = urlsplit(origin)
            if (location.scheme, location.netloc) != (base.scheme, base.netloc):
                raise _error("BOX_PLATFORM_UPSTREAM_REDIRECT", 502)
            output["location"] = location.path + ("?" + location.query if location.query else "")
    return output


async def _body(request: Request, limit: int = 16384) -> dict[str, Any]:
    data = bytearray()
    async for chunk in request.stream():
        data.extend(chunk)
        if len(data) > limit:
            raise _error("BOX_PLATFORM_BODY_TOO_LARGE", 413)
    try:
        value = json.loads(data)
    except (ValueError, UnicodeDecodeError):
        raise _error("BOX_PLATFORM_INVALID_REQUEST", 400) from None
    if not isinstance(value, dict):
        raise _error("BOX_PLATFORM_INVALID_REQUEST", 400)
    return value


def create_app(
    auth: Any,
    adapter: Any,
    *,
    upstream_url: str = "http://127.0.0.1:18088",
    semantica_url: str = SEMANTICA_URL,
    semantica_config_file: Path = Path("/data/.octop/semantica.json"),
    semantica_desktop_url: str | None = None,
    clipboard_url: str | None = "http://127.0.0.1:8092",
    http_transport: Any = None,
    lease_check_interval: float = 0.25,
    dashboard_dir: Path | None = None,
    build_metadata: dict[str, Any] | None = None,
    resources: Any = None,
    service_registry: ServiceRegistry | None = None,
    service_session_verifier: ServiceSessionVerifier | None = None,
) -> FastAPI:
    from centuarai_local_data_gate import load_required_policy

    if load_required_policy() is not None:
        raise _error("LOCAL_DATA_REQUIRED", 503)
    parsed = urlsplit(upstream_url)
    if (
        parsed.scheme not in {"http", "https"}
        or parsed.hostname not in {"127.0.0.1", "::1", "localhost"}
        or parsed.username
        or parsed.password
        or parsed.path not in {"", "/"}
        or parsed.query
        or parsed.fragment
    ):
        raise ValueError("upstream_url must be a loopback HTTP origin")
    if clipboard_url is not None:
        business = urlsplit(clipboard_url)
        if (
            business.scheme not in {"http", "https"}
            or business.hostname not in {"127.0.0.1", "::1", "localhost"}
            or business.username
            or business.password
            or business.path not in {"", "/"}
            or business.query
            or business.fragment
        ):
            raise ValueError("clipboard_url must be a loopback HTTP origin")
    assets = DashboardAssets(dashboard_dir or installed_dashboard())
    origin = upstream_url.rstrip("/")
    service_registry = service_registry or ServiceRegistry.empty()
    if service_session_verifier is None:
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

        signing_key = getattr(getattr(auth, "config", None), "box_key", None)
        service_session_verifier = ServiceSessionVerifier(
            service_registry, signing_key or Ed25519PrivateKey.generate()
        )
    metadata = bridge_build_metadata() if build_metadata is None else dict(build_metadata)
    client = httpx.AsyncClient(
        transport=http_transport,
        follow_redirects=False,
        trust_env=False,
        timeout=httpx.Timeout(connect=10, read=None, write=60, pool=10),
    )

    from .platform_browser_runtime import PlatformBrowserRuntime
    from .platform_sessions import PlatformSessions

    platform_root = Path(getattr(getattr(auth, "config", None), "state_dir", None) or semantica_config_file.parent) / "platform-browser"
    platform_runtime = PlatformBrowserRuntime(platform_root / "profiles")
    platform_sessions = PlatformSessions(platform_root / "bindings", platform_runtime)

    async def capability_request(
        method: str,
        path: str,
        claims: Mapping[str, Any],
        payload: Any,
        query: Mapping[str, Any],
        service_token: str,
    ) -> Response:
        upstream_token = service_session_verifier.delegated_upstream_token(service_token)
        if upstream_token is None:
            raise _error("SERVICE_CONTEXT_EXPIRED", 401)
        if path.startswith("/api/browser/platform-sessions/"):
            parts = path.removeprefix("/api/browser/platform-sessions/").split("/")
            group, action = ("platform", parts[0]) if len(parts) == 1 else parts
            def validate_platform_authority():
                if claims.get("taskId"):
                    service_session_verifier.assert_platform_task_authority(claims)
                    return claims
                verified = service_session_verifier.verify(service_token, service_id=SERVICE_ID, required_scope="workbench:browser")
                if service_session_verifier.delegated_upstream_token(service_token) is None:
                    raise BridgeAuthError("SERVICE_CONTEXT_EXPIRED", 401)
                return verified
            result = await platform_sessions.dispatch(claims, action, payload or {}, group=group, validate=validate_platform_authority)
            return JSONResponse(result, headers={"cache-control": "no-store"})
        params = [(key, str(value)) for key, value in query.items()]
        request = client.build_request(
            method,
            origin + quote(path, safe="/"),
            params=params,
            headers={"Authorization": "Bearer " + upstream_token},
            json=payload if payload is not None else None,
        )
        try:
            response = await client.send(request, stream=True)
        except httpx.HTTPError as exc:
            raise _error("SERVICE_UPSTREAM_UNAVAILABLE", 503) from exc
        if response.status_code in {401, 403}:
            await response.aclose()
            raise _error("SERVICE_UPSTREAM_AUTH_FAILED", 502)
        headers = _response_headers(response, origin)
        headers["cache-control"] = "no-store"
        content_type = response.headers.get("content-type", "")
        if "text/event-stream" in content_type.lower():
            async def events() -> AsyncIterator[bytes]:
                try:
                    if response.is_stream_consumed:
                        data = response.content
                        if len(data) > 2 * 1024 * 1024:
                            raise _error("SERVICE_UPSTREAM_RESPONSE_TOO_LARGE", 502)
                        yield data
                    else:
                        async for chunk in response.aiter_raw():
                            if len(chunk) > 2 * 1024 * 1024:
                                raise _error("SERVICE_UPSTREAM_RESPONSE_TOO_LARGE", 502)
                            yield chunk
                finally:
                    await response.aclose()

            return StreamingResponse(events(), status_code=response.status_code, headers=headers)
        try:
            data = await response.aread()
        finally:
            await response.aclose()
        if len(data) > 2 * 1024 * 1024:
            raise _error("SERVICE_UPSTREAM_RESPONSE_TOO_LARGE", 502)
        for name in ("content-length", "content-encoding"):
            headers.pop(name, None)
        return Response(content=data, status_code=response.status_code, headers=headers)

    capability_gateway = HuohuaCapabilityGateway(
        adapter,
        origin=origin,
        verifier=service_session_verifier,
        requester=capability_request,
    )
    # This boundary stays active even when background resource synchronization
    # is disabled: previously installed controlled packages must remain private.
    managed_resources = ManagedResourceGuard(adapter)
    browser_experts = BrowserExpertPreparer(
        getattr(getattr(auth, "config", None), "state_dir", None)
    )

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        async def platform_watchdog():
            while True:
                await asyncio.sleep(1)
                try:
                    await platform_sessions.expire()
                except Exception:
                    # A failed cleanup remains durably recovering; continue
                    # watching independent account leases.
                    continue
        platform_task = asyncio.create_task(platform_watchdog())
        resource_task = asyncio.create_task(resources.catalog.poll()) if resources else None
        try:
            yield
        finally:
            if resource_task:
                resource_task.cancel()
                await asyncio.gather(resource_task, return_exceptions=True)
                await resources.close()
            platform_task.cancel()
            await asyncio.gather(platform_task, return_exceptions=True)
            await platform_runtime.shutdown()
            await client.aclose()

    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan)
    app.state.platform_sessions = platform_sessions
    from .semantica.maintenance import SemanticaMaintenanceMiddleware

    app.add_middleware(SemanticaMaintenanceMiddleware, home=semantica_config_file.parent)

    @app.exception_handler(BridgeAuthError)
    @app.exception_handler(BridgeUpstreamError)
    async def auth_error(_: Request, exc: BridgeAuthError | BridgeUpstreamError) -> JSONResponse:
        return JSONResponse({"code": exc.code, "detail": exc.code}, status_code=exc.status)

    @app.exception_handler(httpx.HTTPError)
    async def upstream_error(_: Request, exc: httpx.HTTPError) -> JSONResponse:
        # Exception URLs may contain the upstream token; never return them.
        return JSONResponse({"code": "BOX_PLATFORM_UPSTREAM_UNAVAILABLE"}, status_code=502)

    async def watch(session: Any) -> None:
        while True:
            await _call(auth.assert_live, session)
            await asyncio.sleep(lease_check_interval)

    @app.post("/api/auth/platform/challenge")
    async def challenge(request: Request) -> JSONResponse:
        body = await _body(request)
        values = [body.get(key) for key in ("accountId", "clientId", "networkSessionId")]
        if any(not isinstance(value, str) or not value for value in values):
            raise _error("BOX_PLATFORM_INVALID_REQUEST", 400)
        return JSONResponse(
            await _call(auth.challenge, *values), headers={"Cache-Control": "no-store"}
        )

    @app.post("/api/auth/platform/exchange")
    async def exchange(request: Request) -> JSONResponse:
        body = await _body(request)
        grant = body.get("grant")
        if not isinstance(grant, str) or not grant:
            raise _error("BOX_PLATFORM_INVALID_REQUEST", 400)
        return JSONResponse(
            await _call(auth.exchange, grant, adapter), headers={"Cache-Control": "no-store"}
        )

    @app.post("/api/auth/platform/application")
    async def application_session(request: Request) -> JSONResponse:
        marker = _credentials(request.headers, request.query_params, required=True)
        body = await _body(request)
        if set(body) != {"application_id"} or not isinstance(body["application_id"], str):
            raise _error("BOX_PLATFORM_INVALID_REQUEST", 400)
        return JSONResponse(
            await _call(auth.application_session, marker, body["application_id"], adapter),
            headers={"Cache-Control": "no-store"},
        )

    @app.get("/api/platform/assets/manifest")
    async def asset_manifest(request: Request) -> JSONResponse:
        marker = _credentials(request.headers, request.query_params, required=True)
        session = await _call(auth.authorize, marker)
        manifest = await assets.manifest()
        await _call(auth.assert_live, session)
        return JSONResponse(manifest, headers={"Cache-Control": "no-store"})

    @app.get("/api/platform/version")
    async def platform_version(request: Request) -> JSONResponse:
        marker = _credentials(request.headers, request.query_params, required=True)
        session = await _call(auth.authorize, marker)
        result = version_snapshot(getattr(auth, "config", None), metadata)
        await _call(auth.assert_live, session)
        return JSONResponse(result, headers={"Cache-Control": "no-store"})

    async def resource_operation(request: Request, operation: str) -> JSONResponse:
        marker = _credentials(request.headers, request.query_params, required=True)
        session = await _call(auth.authorize, marker)
        body = await _body(request)
        if resources is None:
            raise _error("RESOURCE_SERVICE_NOT_CONFIGURED", 503)
        context = await _call(auth.resource_context, session)

        async def live() -> None:
            await _call(auth.assert_live, session)

        async def upstream_request(method: str, path: str, **kwargs: Any) -> httpx.Response:
            await live()
            if operation == "inspect_candidate" and (method != "GET" or kwargs):
                raise _error("RESOURCE_READ_ONLY_VIOLATION", 500)
            if not path.startswith("/api/") or path.startswith("//"):
                raise _error("RESOURCE_UPSTREAM_PATH_INVALID", 400)
            req = client.build_request(
                method,
                origin + path,
                headers={"Authorization": "Bearer " + _field(session, "upstream_token")},
                timeout=30,
                **kwargs,
            )
            req.headers.pop("cookie", None)
            response = await client.send(req)
            await live()
            return response

        handler = getattr(resources, operation, None)
        if handler is None:
            raise _error("APPLICATION_CONTRACT_UNSUPPORTED", 422)
        result = await handler(body, session, context, upstream_request, live)
        await live()
        return JSONResponse(result, headers={"Cache-Control": "no-store"})

    @app.post("/api/platform/applications/prepare")
    async def application_prepare(request: Request) -> JSONResponse:
        return await resource_operation(request, "prepare")

    @app.post("/api/platform/applications/candidates/prepare")
    async def application_candidate_prepare(request: Request) -> JSONResponse:
        return await resource_operation(request, "prepare_candidate")

    @app.post("/api/platform/applications/candidates/inspect")
    async def application_candidate_inspect(request: Request) -> JSONResponse:
        return await resource_operation(request, "inspect_candidate")

    @app.post("/api/platform/applications/readiness")
    async def application_readiness(request: Request) -> JSONResponse:
        marker = _credentials(request.headers, request.query_params, required=True)
        session = await _call(auth.authorize, marker)
        body = await _body(request)

        async def get(path: str) -> httpx.Response:
            await _call(auth.assert_live, session)
            req = client.build_request(
                "GET",
                origin + path,
                headers={"Authorization": "Bearer " + _field(session, "upstream_token")},
                timeout=10,
            )
            req.headers.pop("cookie", None)
            response = await client.send(req)
            await _call(auth.assert_live, session)
            return response

        async def inspect_resources(resource_body: dict[str, Any]) -> dict[str, Any]:
            if resources is None:
                raise _error("RESOURCE_SERVICE_NOT_CONFIGURED", 503)

            async def live() -> None:
                await _call(auth.assert_live, session)

            async def request_resource(method: str, path: str, **kwargs: Any) -> httpx.Response:
                if method != "GET" or kwargs:
                    raise _error("RESOURCE_READ_ONLY_VIOLATION", 500)
                return await get(path)

            context = await _call(auth.resource_context, session)
            operation = (
                "inspect_candidate" if resource_body.get("schemaVersion") == 2 else "inspect"
            )
            handler = getattr(resources, operation, None)
            if handler is None:
                raise _error("APPLICATION_CONTRACT_UNSUPPORTED", 422)
            return await handler(resource_body, session, context, request_resource, live)

        result = await diagnose_application(
            body,
            session,
            version_snapshot(getattr(auth, "config", None), metadata),
            get,
            inspect_resources=inspect_resources,
        )
        await _call(auth.assert_live, session)
        return JSONResponse(result, headers={"Cache-Control": "no-store"})

    @app.post("/api/platform/browser/expert/ensure")
    async def ensure_browser_expert(request: Request) -> JSONResponse:
        marker = _credentials(request.headers, request.query_params, required=True)
        session = await _call(auth.authorize, marker)
        body = await _body(request, limit=65536)

        async def live() -> None:
            await _call(auth.assert_live, session)

        async def upstream_request(method: str, path: str, **kwargs: Any) -> httpx.Response:
            await live()
            req = client.build_request(
                method,
                origin + path,
                headers={"Authorization": "Bearer " + _field(session, "upstream_token")},
                timeout=30,
                **kwargs,
            )
            req.headers.pop("cookie", None)
            response = await client.send(req)
            await live()
            return response

        result = await browser_experts.ensure(body, _field(session, "user"), upstream_request, live)
        await live()
        return JSONResponse(result, headers={"Cache-Control": "no-store"})

    @app.post("/api/bridge/v1/services/{service_id}/session")
    async def service_session(request: Request, service_id: str) -> JSONResponse:
        body = await _body(request, limit=8192)
        if body.get("serviceId", service_id) != service_id:
            raise _error("SERVICE_PROOF_INVALID", 401)
        required = {"serviceId", "protocolVersion", "nonce", "signature"}
        # User and space authority is delegated per client request below.  A
        # boxd bootstrap proof may identify its box, but cannot mint a token
        # for an arbitrary WANX user or widen its capability scope.
        if set(body) - required - {"boxId"} or not required.issubset(body):
            raise _error("SERVICE_PROOF_INVALID", 401)
        result = service_session_verifier.issue(
            service_id,
            protocol_version=body["protocolVersion"],
            nonce=body["nonce"],
            signature=body["signature"],
            box_id=body.get("boxId"),
        )
        result.pop("claims", None)
        return JSONResponse(result, headers={"Cache-Control": "no-store"})

    @app.get("/api/bridge/v1/services/{service_id}/status")
    async def service_state(request: Request, service_id: str) -> JSONResponse:
        marker = _credentials(request.headers, request.query_params, required=True)
        session = await _call(auth.authorize, marker)
        result = await service_status(
            service_registry,
            service_id,
            client=client,
            wanx_version=metadata.get("version"),
        )
        await _call(auth.assert_live, session)
        return JSONResponse(result, headers={"Cache-Control": "no-store"})

    def require_huohua_service(service_id: str) -> None:
        if service_id != SERVICE_ID:
            raise _error("SERVICE_NOT_INSTALLED", 404)

    @app.post("/api/bridge/v1/services/{service_id}/tasks")
    async def task_create(request: Request, service_id: str) -> JSONResponse:
        require_huohua_service(service_id)
        token = service_session_verifier.bearer(request.headers)
        body = await _body(request, limit=8192)
        if set(body) - {"taskId", "ttlSeconds", "scope"}:
            raise _error("TASK_REQUEST_INVALID", 400)
        scope = body.get("scope")
        if scope is not None and not isinstance(scope, list):
            raise _error("TASK_REQUEST_INVALID", 400)
        result = service_session_verifier.issue_task(
            token,
            task_id=body.get("taskId"),
            ttl_seconds=body.get("ttlSeconds", 300),
            scope=scope,
        )
        result.pop("claims", None)
        return JSONResponse(result, headers={"Cache-Control": "no-store"})

    @app.post("/api/bridge/v1/services/{service_id}/tasks/{task_id}/renew")
    async def task_renew(request: Request, service_id: str, task_id: str) -> JSONResponse:
        require_huohua_service(service_id)
        token = service_session_verifier.bearer(request.headers)
        body = await _body(request, limit=4096)
        if set(body) - {"ttlSeconds"}:
            raise _error("TASK_REQUEST_INVALID", 400)
        result = service_session_verifier.renew_task(
            token, task_id=task_id, ttl_seconds=body.get("ttlSeconds", 300)
        )
        result.pop("claims", None)
        return JSONResponse(result, headers={"Cache-Control": "no-store"})

    @app.post("/api/bridge/v1/services/{service_id}/tasks/{task_id}/revoke")
    @app.delete("/api/bridge/v1/services/{service_id}/tasks/{task_id}")
    async def task_revoke(request: Request, service_id: str, task_id: str) -> JSONResponse:
        require_huohua_service(service_id)
        token = service_session_verifier.bearer(request.headers)
        if request.method == "POST":
            body = await _body(request, limit=4096)
            if body:
                raise _error("TASK_REQUEST_INVALID", 400)
        result = service_session_verifier.revoke_task(token, task_id=task_id)
        return JSONResponse(result, headers={"Cache-Control": "no-store"})

    @app.post("/api/bridge/v1/capabilities/{capability}")
    async def capability_ingress(request: Request, capability: str) -> JSONResponse:
        token = service_session_verifier.bearer(request.headers)
        body = await _body(request, limit=2 * 1024 * 1024)
        result = await capability_gateway.dispatch(token, capability, body)
        if isinstance(result, Response):
            return result
        return JSONResponse(result, headers={"Cache-Control": "no-store"})

    async def forward(
        request: Request,
        *,
        path: str,
        target_origin: str,
        session: Any,
        token: str | None,
        guard_resources: bool = True,
        body_limit: int | None = None,
        filter_request_headers: Callable[[list[tuple[str, str]]], list[tuple[str, str]]]
        | None = None,
        filter_response_headers: Callable[[dict[str, str]], dict[str, str]] | None = None,
    ) -> Response:
        guard = asyncio.create_task(watch(session)) if session else None
        upstream = None
        pending = None
        request_complete = asyncio.Event()

        async def request_chunks() -> AsyncIterator[bytes]:
            size = 0
            async for chunk in request.stream():
                size += len(chunk)
                if body_limit is not None and size > body_limit:
                    raise _error("BOX_PLATFORM_BODY_TOO_LARGE", 413)
                yield chunk
            request_complete.set()

        async def wait_disconnect() -> None:
            # Only one task may consume ASGI receive while the upload is active.
            # Once drained, detect cancellation even before upstream sends headers.
            await request_complete.wait()
            while True:
                if (await request.receive())["type"] == "http.disconnect":
                    raise ClientDisconnect()

        disconnect_task = asyncio.create_task(wait_disconnect())
        try:
            content = request_chunks()
            request_body = None
            if guard_resources and managed_resources.needs_body(request.method, path):
                data = bytearray()
                async with asyncio.timeout(30):
                    async for chunk in content:
                        data.extend(chunk)
                        if len(data) > 2 * 1024 * 1024:
                            raise _error("BOX_PLATFORM_BODY_TOO_LARGE", 413)
                        if session:
                            await _call(auth.assert_live, session)
                request_body = bytes(data)
                content = request_body
            if guard_resources:
                await managed_resources.inspect_request(request.method, path, request_body)
            if session:
                await _call(auth.assert_live, session)
            outgoing = _headers(request.headers, token)
            if filter_request_headers is not None:
                outgoing = filter_request_headers(outgoing)
            req = client.build_request(
                request.method,
                _target(target_origin, path, request.query_params, token),
                headers=outgoing,
                content=content,
            )
            # AsyncClient keeps a shared response cookie jar. Never let a prior
            # upstream response attach another user's cookies to this request.
            req.headers.pop("cookie", None)
            pending = asyncio.create_task(client.send(req, stream=True))
            waiting = {pending, disconnect_task}
            if guard:
                waiting.add(guard)
            done, _ = await asyncio.wait(waiting, return_when=asyncio.FIRST_COMPLETED)
            if disconnect_task in done:
                await disconnect_task
            if guard in done:
                await guard
            upstream = await pending
            ontology = re.fullmatch(r"/api/agents/([^/]+)/ontology", path)
            if (
                guard_resources
                and target_origin == origin
                and session
                and request.method == "GET"
                and ontology
                and upstream.status_code == 404
            ):
                # Only retry the read. Never replay ontology edits or model calls.
                # Existing sessions may predate primary-profile provisioning.
                async def recover() -> tuple[bytes, bool]:
                    async with asyncio.timeout(30):
                        data = bytearray()
                        async for chunk in upstream.aiter_bytes():
                            data.extend(chunk)
                            if len(data) > 65536:
                                raise _error("BOX_UPSTREAM_PROTOCOL_INVALID", 502)
                        await _call(auth.assert_live, session)
                        try:
                            body = json.loads(data)
                        except (ValueError, UnicodeError):
                            return bytes(data), False
                        missing = (
                            isinstance(body, dict)
                            and isinstance(body.get("error"), dict)
                            and body["error"].get("code") == "NOT_FOUND"
                        )
                        repaired = missing and await recover_private_profile(
                            adapter,
                            token,
                            _field(session, "user"),
                            ontology[1],
                            lambda: _call(auth.assert_live, session),
                        )
                        return bytes(data), repaired

                pending = asyncio.create_task(recover())
                done, _ = await asyncio.wait(
                    {pending, guard, disconnect_task}, return_when=asyncio.FIRST_COMPLETED
                )
                if disconnect_task in done:
                    await disconnect_task
                if guard in done:
                    await guard
                data, repaired = await pending
                await upstream.aclose()
                if not repaired:
                    headers = _response_headers(upstream, target_origin)
                    for name in ("content-length", "content-encoding"):
                        headers.pop(name, None)
                    guard.cancel()
                    with contextlib.suppress(BaseException):
                        await guard
                    return Response(data, status_code=404, headers=headers)
                await _call(auth.assert_live, session)
                req = client.build_request(
                    "GET",
                    _target(target_origin, path, request.query_params, token),
                    headers=_headers(request.headers, token),
                )
                req.headers.pop("cookie", None)
                upstream = None
                pending = asyncio.create_task(client.send(req, stream=True))
                done, _ = await asyncio.wait(
                    {pending, guard, disconnect_task}, return_when=asyncio.FIRST_COMPLETED
                )
                if disconnect_task in done:
                    await disconnect_task
                if guard in done:
                    await guard
                upstream = await pending
            headers = _response_headers(upstream, target_origin)
            if filter_response_headers is not None:
                headers = filter_response_headers(headers)
            if (
                guard_resources
                and upstream.status_code == 200
                and managed_resources.needs_response(request.method, path)
            ):
                data = bytearray()
                async with asyncio.timeout(30):
                    async for chunk in upstream.aiter_bytes():
                        data.extend(chunk)
                        if len(data) > 4 * 1024 * 1024:
                            raise _error("RESOURCE_RESPONSE_TOO_LARGE", 502)
                        if session:
                            await _call(auth.assert_live, session)
                try:
                    value = json.loads(data)
                except (ValueError, UnicodeError) as exc:
                    raise _error("RESOURCE_UPSTREAM_RESPONSE_INVALID", 502) from exc
                filtered = await managed_resources.filter_response(request.method, path, value)
                if session:
                    await _call(auth.assert_live, session)
                await upstream.aclose()
                if guard:
                    guard.cancel()
                    with contextlib.suppress(BaseException):
                        await guard
                for name in ("content-length", "content-encoding", "etag", "last-modified"):
                    headers.pop(name, None)
                headers["cache-control"] = "no-store"
                return JSONResponse(filtered, headers=headers)
            # MockTransport and a few ASGI adapters hand back an already
            # buffered response even when `stream=True`.  Preserve the same
            # response contract instead of trying to iterate a consumed body.
            if getattr(upstream, "is_stream_consumed", False):
                data = upstream.content
                await upstream.aclose()
                if guard:
                    guard.cancel()
                    with contextlib.suppress(BaseException):
                        await guard
                return Response(data, status_code=upstream.status_code, headers=headers)
        except BaseException as exc:
            if pending and not pending.done():
                pending.cancel()
                with contextlib.suppress(BaseException):
                    await pending
            elif pending and upstream is None:
                with contextlib.suppress(BaseException):
                    upstream = pending.result()
            if upstream:
                await upstream.aclose()
            if guard:
                guard.cancel()
                with contextlib.suppress(BaseException):
                    await guard
            if isinstance(exc, ClientDisconnect):
                return Response(status_code=499)
            raise
        finally:
            # StreamingResponse owns disconnect monitoring after response headers.
            disconnect_task.cancel()
            with contextlib.suppress(BaseException):
                await disconnect_task

        async def stream() -> AsyncIterator[bytes]:
            iterator = upstream.aiter_raw().__aiter__()
            chunk_task: asyncio.Task[bytes] | None = None

            async def next_chunk() -> bytes:
                return await anext(iterator)

            try:
                while True:
                    chunk_task = asyncio.create_task(next_chunk())
                    # Do not directly await a pending read: disconnect would
                    # cancel httpx cleanup inside Starlette's cancelled scope.
                    # Cancel the read only in the shielded finally below, also
                    # for independent MCP streams without a platform guard.
                    waiting = {chunk_task, guard} if guard else {chunk_task}
                    done, _ = await asyncio.wait(waiting, return_when=asyncio.FIRST_COMPLETED)
                    if guard in done:
                        # Headers may already be sent. Close the stream, never
                        # continue delivering bytes after lease revocation.
                        with contextlib.suppress(BridgeAuthError):
                            await guard
                        return
                    try:
                        yield await chunk_task
                    except StopAsyncIteration:
                        return
            finally:
                # StreamingResponse cancels its task group on disconnect. Shield
                # cleanup so the HTTP pool never retains an orphaned SSE socket.
                with anyio.CancelScope(shield=True):
                    if chunk_task and not chunk_task.done():
                        chunk_task.cancel()
                        with contextlib.suppress(BaseException):
                            await chunk_task
                    if guard:
                        guard.cancel()
                        with contextlib.suppress(BaseException):
                            await guard
                    await upstream.aclose()

        return StreamingResponse(stream(), status_code=upstream.status_code, headers=headers)

    async def authorize_native(request: Request) -> Any:
        marker = _credentials(request.headers, request.query_params, required=True)
        session = await _call(auth.authorize, marker)
        await _call(auth.assert_live, session)
        return session

    def service_context(session: Any, requested_space_id: str | None = None) -> tuple[str, str | None, str]:
        user = _field(session, "user")
        user_id = user.get("id") if isinstance(user, Mapping) else None
        if user_id is None:
            raise _error("SERVICE_CONTEXT_INVALID", 502)
        user_id = str(user_id)
        # A client may select a space, but identity is always taken from the
        # authenticated Host session and the selected value is length checked.
        if requested_space_id is not None and (
            not isinstance(requested_space_id, str) or not 1 <= len(requested_space_id) <= 256
        ):
            raise _error("SERVICE_CONTEXT_INVALID", 400)
        bound_space = None
        if isinstance(user, Mapping):
            bound_space = user.get("spaceId", user.get("space_id"))
        if bound_space is not None and not isinstance(bound_space, str):
            raise _error("SERVICE_CONTEXT_INVALID", 502)
        if bound_space is not None and requested_space_id is not None and bound_space != requested_space_id:
            raise _error("SERVICE_CONTEXT_FORBIDDEN", 403)
        space_id = bound_space or requested_space_id
        return user_id, space_id, str(getattr(getattr(auth, "config", None), "device_id", "bridge"))

    async def service_record_or_error(service_id: str) -> Any:
        record = service_registry.get(service_id)
        if record is None or not record.enabled:
            raise _error("SERVICE_NOT_INSTALLED", 404)
        status = await service_status(
            service_registry,
            service_id,
            client=client,
            wanx_version=metadata.get("version"),
        )
        if status["status"] != "ready":
            code = {
                "starting": "SERVICE_STARTING",
                "incompatible": "SERVICE_INCOMPATIBLE",
                "degraded": "SERVICE_DEGRADED",
                "failed": "SERVICE_UNAVAILABLE",
            }.get(status["status"], "SERVICE_UNAVAILABLE")
            raise _error(code, 503 if status["status"] != "incompatible" else 409)
        return record

    async def registered_service_proxy(request: Request, service_id: str, path: str) -> Response:
        marker = _credentials(request.headers, request.query_params, required=True)
        session = await _call(auth.authorize, marker)
        record = await service_record_or_error(service_id)
        decoded_path = path
        for _ in range(3):
            next_path = unquote(decoded_path)
            if next_path == decoded_path:
                break
            decoded_path = next_path
        if "\\" in decoded_path or "//" in decoded_path or "%" in decoded_path or any(
            part in {".", ".."} for part in decoded_path.split("/")
        ):
            raise _error("SERVICE_ROUTE_FORBIDDEN", 403)
        path = decoded_path
        if not record.allows(request.method, path):
            raise _error("SERVICE_ROUTE_FORBIDDEN", 403)
        # Personal-space is the default WANX scope. Bind it into the delegated
        # service token even when Host did not send an optional space header;
        # otherwise huohua-boxd cannot prove that its explicit `space_id=personal`
        # capability requests belong to the same user/space scope.
        user_id, space_id, box_id = service_context(
            session, request.headers.get("x-wanx-space-id") or "personal"
        )
        token = service_session_verifier.issue_delegated(
            service_id,
            protocol_version=record.protocol_version,
            box_id=box_id,
            user_id=user_id,
            space_id=space_id,
            scope=record.allowed_scopes,
            upstream_token=session.upstream_token if service_id == SERVICE_ID else None,
            upstream_expires_at=session.upstream_expires_at,
            authority=auth.service_task_binding(session) if hasattr(auth, "service_task_binding") else None,
        )

        def service_response_headers(headers: dict[str, str]) -> dict[str, str]:
            if (not record.routes[0].sse
                    and headers.get("content-type", "").lower().startswith("text/event-stream")):
                raise _error("SERVICE_SSE_FORBIDDEN", 502)
            return headers

        try:
            return await forward(
                request,
                path=path,
                target_origin=record.upstream,
                session=session,
                token=token,
                guard_resources=False,
                filter_response_headers=service_response_headers,
                body_limit=2 * 1024 * 1024,
                filter_request_headers=lambda values: [
                    (key, value)
                    for key, value in values
                    if not key.lower().startswith("x-wanx-")
                ],
            )
        except httpx.HTTPError as exc:
            raise _error("SERVICE_UPSTREAM_UNAVAILABLE", 503) from exc

    def mount_service(service_id: str, prefix: str) -> None:
        async def root_endpoint(request: Request) -> Response:
            return await registered_service_proxy(request, service_id, prefix)

        async def endpoint(request: Request, service_path: str) -> Response:
            # Use the matched route, never an upstream or service identity from a header.
            return await registered_service_proxy(
                request, service_id, prefix + ("/" + service_path if service_path else "")
            )

        for route_path, handler in ((prefix, root_endpoint), (prefix + "/{service_path:path}", endpoint)):
            for method in ("GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"):
                app.add_api_route(
                    route_path, handler,
                    methods=[method],
                    name=f"service_{service_id}_{method.lower()}",
                )

    # Keep the legacy URL's not-installed behavior even without a registry entry.
    mount_service(SERVICE_ID, "/api/huohua/v1")
    for registered_id, registered in service_registry.services.items():
        if registered_id != SERVICE_ID:
            mount_service(registered_id, registered.route_prefix)

    app.include_router(
        semantica_router(
            service_url=semantica_url,
            octop_url=origin,
            client=client,
            authorize=authorize_native,
            forward=forward,
        )
    )

    async def assert_semantica_live(session: Any) -> None:
        await _call(auth.assert_live, session)

    app.include_router(
        create_desktop_router(
            config_file=semantica_config_file,
            service_url=semantica_desktop_url,
            box_id=getattr(getattr(auth, "config", None), "device_id", None),
            octop_url=origin,
            client=client,
            authorize=authorize_native,
            watch=watch,
            forward=forward,
            assert_live=assert_semantica_live,
        )
    )

    @app.api_route(
        "/{path:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]
    )
    async def proxy(request: Request, path: str) -> Response:
        path = "/" + path
        if path == "/api/services" or path.startswith("/api/services/"):
            raise _error("SERVICE_NOT_INSTALLED", 404)
        if not _allowed(path, request.method):
            raise _error("BOX_PLATFORM_ROUTE_FORBIDDEN", 403)
        if path in _MCP_ENDPOINTS:
            # Never interpret an MCP key as a platform marker or manufacture an
            # upstream login JWT. Keep Origin for the MCP server's own checks.
            # URL credentials and duplicate headers are not accepted, even if
            # equal: this transport has one unambiguous Authorization source.
            authorization = request.headers.getlist("authorization")
            if (
                any(k.lower() in _TOKEN_PARAMS for k in request.query_params)
                or len(authorization) > 1
                or authorization
                and not re.fullmatch(r"(?i:Bearer) [A-Za-z0-9._~+/-]+=*", authorization[0])
            ):
                raise _error("MCP_AUTH_INVALID", 401)

            def mcp_headers(headers: list[tuple[str, str]]) -> list[tuple[str, str]]:
                return headers + [("authorization", value) for value in authorization]

            return await forward(
                request,
                path=path,
                target_origin=origin,
                session=None,
                token=None,
                guard_resources=False,
                filter_request_headers=mcp_headers,
            )
        protected = path == "/api" or path.startswith("/api/") and path not in _PUBLIC
        marker = _credentials(request.headers, request.query_params, required=protected)
        session = await _call(auth.authorize, marker) if marker else None
        token = _field(session, "upstream_token") if session else None
        is_clipboard = path == "/api/clipboard/v1" or path.startswith("/api/clipboard/v1/")
        service_origin = origin
        forward_token = token
        if is_clipboard:
            if not clipboard_url:
                raise _error("CLIPBOARD_SERVICE_UNAVAILABLE", 503)
            if _field(session, "user").get("application_id", "wanx") != "wanx":
                raise _error("BOX_PLATFORM_ROUTE_FORBIDDEN", 403)
            service_origin = clipboard_url.rstrip("/")
            forward_token = marker
        if path.startswith("/assets/"):
            asset_response = await assets.response(request, path)
            if asset_response is not None:
                if session:
                    await _call(auth.assert_live, session)
                return asset_response

        def clipboard_headers(headers: list[tuple[str, str]]) -> list[tuple[str, str]]:
            # This server-to-server hop reuses the lease for each storage hop.
            return [(k, v) for k, v in headers if k.lower() != "origin"]

        return await forward(
            request,
            path=path,
            target_origin=service_origin,
            session=session,
            token=forward_token,
            filter_request_headers=clipboard_headers if is_clipboard else None,
        )

    @app.websocket("/api/bridge/platform-browser/attach")
    async def platform_attach(websocket: WebSocket) -> None:
        value = None
        tasks = []
        try:
            ticket = websocket.headers.get("x-platform-attach", "")
            if not ticket or websocket.query_params:
                raise BridgeAuthError("PLATFORM_ATTACH_INVALID", 403)
            value, endpoint = await platform_sessions.consume_ticket(ticket)
            async with ws_connect(endpoint, max_size=16 * 1024 * 1024) as upstream:
                await platform_sessions.register_connection(value, websocket)
                async def incoming():
                    while True:
                        message = await websocket.receive_text()
                        # Browser-level close would destroy the shared session.
                        try:
                            command = json.loads(message)
                        except ValueError:
                            raise BridgeAuthError("PLATFORM_CDP_INVALID", 400) from None
                        if command.get("method") in {"Browser.close", "Browser.crash"}:
                            await websocket.send_json({"id": command.get("id"), "error": {"code": -32000, "message": "Shared browser lifecycle is managed by Bridge"}})
                            continue
                        await upstream.send(message)
                async def outgoing():
                    async for message in upstream:
                        await websocket.send_text(message)
                tasks = [asyncio.create_task(incoming()), asyncio.create_task(outgoing())]
                await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        except (BridgeAuthError, WebSocketDisconnect, ConnectionClosed, OSError):
            with contextlib.suppress(Exception):
                await websocket.close(code=4401)
        finally:
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            if value:
                platform_sessions.connections.get(value["sessionId"], set()).discard(websocket)
                await platform_sessions.disconnected(value)

    @app.websocket("/{path:path}")
    async def websocket_proxy(websocket: WebSocket, path: str) -> None:
        path = "/" + path
        tasks = []
        try:
            if not path.startswith("/api/") or not _allowed(path, "WEBSOCKET"):
                raise _error("BOX_PLATFORM_ROUTE_FORBIDDEN", 403)
            marker = _credentials(websocket.headers, websocket.query_params, required=True)
            service_mode = False
            service_token = None
            session = None
            token = None
            # The existing browser stream is the one WANX browser capability
            # that needs WebSocket transport.  A delegated task token may use
            # it; no new Huohua-specific WebSocket route is introduced.
            if path == "/api/browser-stream/ws" and marker:
                try:
                    claims = service_session_verifier.verify(
                        marker, service_id=SERVICE_ID, required_scope="workbench:browser"
                    )
                    service_token = marker
                    token = service_session_verifier.delegated_upstream_token(marker)
                    if not isinstance(claims.get("userId"), str) or token is None:
                        raise _error("SERVICE_CONTEXT_EXPIRED", 401)
                    service_mode = True
                except BridgeAuthError:
                    service_mode = False
            if not service_mode:
                session = await _call(auth.authorize, marker)
                await _call(auth.assert_live, session)
            # One snapshot for both query and desktop start message. Renewals
            # update authority, but must not switch an established WS identity.
            if token is None:
                token = _field(session, "upstream_token")

            async def assert_live_ws() -> None:
                if service_mode:
                    service_session_verifier.verify(
                        service_token or "", service_id=SERVICE_ID, required_scope="workbench:browser"
                    )
                else:
                    await _call(auth.assert_live, session)

            async def watch_service() -> None:
                while True:
                    await assert_live_ws()
                    await asyncio.sleep(lease_check_interval)

            target = _target(origin, path, websocket.query_params, token)
            target = ("wss" if parsed.scheme == "https" else "ws") + target[target.index(":") :]
            async with ws_connect(
                target,
                additional_headers=_headers(websocket.headers, token, websocket=True),
                max_size=None,
                max_queue=16,
                open_timeout=10,
                close_timeout=2,
                proxy=None,
            ) as upstream:
                await assert_live_ws()
                await websocket.accept()

                async def incoming() -> None:
                    while True:
                        message = await websocket.receive()
                        if message["type"] == "websocket.disconnect":
                            return
                        await assert_live_ws()
                        payload = message.get("bytes")
                        if payload is None:
                            payload = message.get("text", "")
                            if path.endswith("/desktop-stream/ws") or path.endswith(
                                "/mobile-stream/ws"
                            ):
                                try:
                                    value = json.loads(payload)
                                except ValueError:
                                    value = None
                                if isinstance(value, dict) and value.get("type") == "start":
                                    if value.get("token") is not None and value["token"] != marker:
                                        raise _error("BOX_PLATFORM_AUTH_CONFLICT")
                                    value["token"] = token
                                    payload = json.dumps(value)
                        await upstream.send(payload)

                async def outgoing() -> None:
                    async for message in upstream:
                        await assert_live_ws()
                        if isinstance(message, bytes):
                            await websocket.send_bytes(message)
                        else:
                            await websocket.send_text(message)

                tasks = [
                    asyncio.create_task(incoming()),
                    asyncio.create_task(outgoing()),
                    asyncio.create_task(watch_service() if service_mode else watch(session)),
                ]
                done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
                for task in done:
                    await task
        except BridgeAuthError:
            with contextlib.suppress(RuntimeError, WebSocketDisconnect):
                await websocket.close(code=4401, reason="BOX_PLATFORM_SESSION_ENDED")
        except (ConnectionClosed, WebSocketDisconnect):
            pass
        except (OSError, TimeoutError, InvalidHandshake):
            with contextlib.suppress(RuntimeError, WebSocketDisconnect):
                await websocket.close(code=1011, reason="BOX_PLATFORM_UPSTREAM_UNAVAILABLE")
        finally:
            for task in tasks:
                task.cancel()
            if tasks:
                await asyncio.gather(*tasks, return_exceptions=True)
            with contextlib.suppress(RuntimeError, WebSocketDisconnect):
                await websocket.close()

    return app
