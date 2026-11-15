"""Loopback desktop Bridge using native WANX identity and shared Semantica routes.

This process never proxies Semantica business requests through Octop. Octop is
queried only for native identity/permissions; platform Bridge auth is unchanged.
"""

from __future__ import annotations

import argparse
import asyncio
import re
from contextlib import asynccontextmanager
from pathlib import Path
from urllib.parse import urlsplit

import httpx
from centuarai_local_data_gate import load_required_policy
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from .desktop import APPS, DesktopConfig, DesktopError
from .desktop_routes import create_desktop_router, identity


def loopback_origin(value: str) -> str:
    parsed = urlsplit(value)
    if (
        parsed.scheme != "http"
        or parsed.hostname != "127.0.0.1"
        or parsed.username is not None
        or parsed.password is not None
        or parsed.path not in {"", "/"}
        or parsed.query
        or parsed.fragment
    ):
        raise ValueError("LOCAL_ORIGIN_REQUIRED")
    _ = parsed.port
    return value.rstrip("/")


def create_app(
    *, config_file: Path, octop_url: str, client: httpx.AsyncClient | None = None
) -> FastAPI:
    octop_url = loopback_origin(octop_url)
    config = DesktopConfig.load(config_file)
    loopback_origin(config.service_url)
    upstream = client or httpx.AsyncClient(trust_env=False, follow_redirects=False)

    @asynccontextmanager
    async def lifespan(_app):
        try:
            yield
        finally:
            if client is None:
                await upstream.aclose()

    app = FastAPI(title="WANX local Semantica Bridge", lifespan=lifespan)

    @app.exception_handler(DesktopError)
    async def desktop_error(_request: Request, exc: DesktopError):
        return JSONResponse(
            {"code": exc.code},
            status_code=exc.status,
            headers={"Cache-Control": "no-store"},
        )

    @app.exception_handler(httpx.HTTPError)
    async def upstream_error(_request: Request, _exc: httpx.HTTPError):
        return JSONResponse(
            {"code": "SEMANTICA_CONNECTION_FAILED"},
            status_code=503,
            headers={"Cache-Control": "no-store"},
        )

    @app.middleware("http")
    async def local_boundary(request: Request, call_next):
        if (
            not request.client
            or request.client.host not in {"127.0.0.1", "::1"}
            or "origin" in request.headers
            or any(k in request.query_params for k in ("token", "access_token"))
        ):
            return JSONResponse({"code": "SEMANTICA_RESOURCE_FORBIDDEN"}, status_code=403)
        # Never let this native-session entry bypass a required data gateway.
        try:
            policy = await asyncio.to_thread(load_required_policy)
        except Exception:
            return JSONResponse({"code": "LOCAL_DATA_REQUIRED"}, status_code=503)
        if policy is not None:
            return JSONResponse({"code": "LOCAL_DATA_REQUIRED"}, status_code=503)
        response = await call_next(request)
        response.headers["Cache-Control"] = "no-store"
        return response

    @app.get("/api/bridge/health", summary="Identify the local direct Semantica transport")
    async def health():
        return {
            "service": "wanx-semantica-bridge",
            "protocol": 1,
            "transport": "semantica-direct",
            "box_id": config.box_id,
        }

    async def authorize(request: Request):
        markers = request.headers.getlist("authorization")
        if len(markers) != 1 or not re.fullmatch(r"Bearer [A-Za-z0-9._~-]{1,8192}", markers[0]):
            raise DesktopError("HOST_SESSION_EXPIRED", 401)
        if request.headers.get("x-wanx-data-context", "personal") != "personal":
            raise DesktopError("MODELING_HOST_CREATION_REQUIRED", 403)
        # Do not accept a user id, application id or workspace grant from the caller.
        token = markers[0][7:]
        identity_request = upstream.build_request(
            "GET",
            octop_url + "/api/auth/me",
            headers={"authorization": "Bearer " + token},
            timeout=10,
        )
        identity_request.headers.pop("cookie", None)
        response = await upstream.send(identity_request, follow_redirects=False)
        if response.status_code != 200:
            raise DesktopError(
                "HOST_SESSION_EXPIRED"
                if response.status_code in {401, 403}
                else "SEMANTICA_IDENTITY_UNAVAILABLE",
                401 if response.status_code in {401, 403} else 503,
            )
        try:
            profile = response.json()
        except ValueError as exc:
            raise DesktopError("SEMANTICA_IDENTITY_UNAVAILABLE", 503) from exc
        if (
            not isinstance(profile, dict)
            or type(profile.get("id")) is not int
            or profile["id"] < 1
            or profile.get("application_id", "wanx") not in APPS
            or (
                profile.get("role") != "admin"
                and "knowledge_bases" not in (profile.get("permissions") or [])
            )
        ):
            raise DesktopError("SEMANTICA_RESOURCE_FORBIDDEN", 403)
        return {"upstream_token": token, "user": profile}

    async def assert_live(session):
        await identity(upstream, octop_url, session, public=False)

    async def watch(session):
        while True:
            await asyncio.sleep(1)
            await assert_live(session)

    async def no_business_forward(*_args, **_kwargs):
        raise DesktopError("MODELING_HOST_CREATION_REQUIRED", 403)

    router = create_desktop_router(
        config_file=config_file,
        service_url=config.service_url,
        box_id=config.box_id,
        octop_url=octop_url,
        client=upstream,
        authorize=authorize,
        forward=no_business_forward,
        watch=watch,
        assert_live=assert_live,
    )
    # Explicit modeling contracts provide the docs; the finite legacy dispatcher
    # handles multiple methods and does not describe an arbitrary public proxy.
    for route in router.routes:
        if "{path:path}" in route.path:
            route.include_in_schema = False
    app.include_router(router)
    return app


def main():
    import uvicorn

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--octop-url", default="http://127.0.0.1:18088")
    parser.add_argument("--port", type=int, default=8088)
    args = parser.parse_args()
    if not 1024 <= args.port <= 65535:
        parser.error("port must be between 1024 and 65535")
    app = create_app(config_file=args.config, octop_url=args.octop_url)
    uvicorn.run(app, host="127.0.0.1", port=args.port, proxy_headers=False)


if __name__ == "__main__":
    main()
