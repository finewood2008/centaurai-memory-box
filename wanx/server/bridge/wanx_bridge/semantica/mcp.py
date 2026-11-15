"""Independent, server-hosted Starlink MCP; warehouse keys stay upstream-scoped."""

from __future__ import annotations

import asyncio
import ipaddress
import json
import re
from typing import Any
from urllib.parse import urlsplit

import httpx
from fastapi import FastAPI
from mcp.server.auth.middleware.auth_context import AuthContextMiddleware, get_access_token
from mcp.server.auth.middleware.bearer_auth import BearerAuthBackend, RequireAuthMiddleware
from mcp.server.auth.provider import AccessToken
from mcp.server.fastmcp import FastMCP
from mcp.server.transport_security import TransportSecuritySettings
from mcp.types import CallToolResult, TextContent
from pydantic import Field, ValidationError
from starlette.middleware.authentication import AuthenticationMiddleware

from wanx_bridge.semantica.client import SemanticaClient, SemanticaError
from wanx_bridge.semantica.maintenance import MaintenanceError, request_guard

from .mcp_reasoning_contract import OPERATIONS, register_tools, validate_payload

REASONING_PATHS = frozenset("/reasoning/" + op for op in OPERATIONS)
SAFE_ERRORS = frozenset(
    [
        "ACCESS_KEY_INVALID",
        "ACCESS_KEY_REQUIRED",
        "ACCESS_KEY_SCOPE_DENIED",
        "MODEL_AUTH_REQUIRED",
        "MODEL_BUSY",
        "MODEL_CALL_FAILED",
        "MODEL_CHECK_REQUIRED",
        "MODEL_CLOUD_CONFIRMATION_REQUIRED",
        "MODEL_CONFIG_CHANGED",
        "MODEL_CONFIG_CONFLICT",
        "MODEL_CONFIG_INVALID",
        "MODEL_DEFAULT_NOT_CONFIGURED",
        "MODEL_INPUT_TOO_LARGE",
        "MODEL_INVALID_OUTPUT",
        "MODEL_INVALID_REQUEST",
        "MODEL_OPTIONS_INVALID",
        "MODEL_OPTIONS_UNCONFIRMED",
        "MODEL_PURPOSE_DENIED",
        "MODEL_RELAY_UNAVAILABLE",
        "MODEL_REPLAY_DENIED",
        "MODEL_SERVICE_UNAVAILABLE",
        "MODEL_SHARED_REQUIRED",
        "MODEL_TASK_REVOKED",
        "MODEL_THINKING_UNSUPPORTED",
        "MODEL_UNAVAILABLE",
        "MODEL_WAREHOUSE_UNAVAILABLE",
        "REASONING_CONFIRMATION_INVALID",
        "REASONING_DELIVERY_STALE",
        "REASONING_IDEMPOTENCY_CONFLICT",
        "REASONING_PREPARATION_NOT_FOUND",
        "REASONING_RESULT_NOT_FOUND",
        "REASONING_SCOPE_CHANGED",
        "REASONING_SCOPE_MISMATCH",
        "REASONING_SCOPE_REQUIRED",
        "REASONING_SCOPE_UNAVAILABLE",
        "REASONING_SOURCE_NOT_READ",
        "SEMANTICA_INVALID_REQUEST",
        "SEMANTICA_MAINTENANCE",
        "SEMANTICA_REQUEST_TOO_LARGE",
        "SEMANTICA_RESOURCE_FORBIDDEN",
        "SEMANTICA_RESOURCE_NOT_FOUND",
        "SEMANTICA_SERVICE_ERROR",
        "SEMANTICA_SERVICE_TIMEOUT",
        "SEMANTICA_SERVICE_UNAVAILABLE",
        "SEMANTICA_VERSION_CONFLICT",
        "SKILL_BUILTIN_CHANGED",
        "SKILL_BUILTIN_UNAVAILABLE",
        "SKILL_DEPENDENCY_CONFLICT",
        "SKILL_DISABLED",
        "SKILL_FEATURE_DISABLED",
        "SKILL_FORBIDDEN",
        "SKILL_ID_CONFLICT",
        "SKILL_INVALID_REQUEST",
        "SKILL_NOT_FOUND",
        "SKILL_NOT_PUBLISHABLE",
        "SKILL_PACKAGE_ENTRY",
        "SKILL_PACKAGE_PATH",
        "SKILL_PACKAGE_READ_ONLY",
        "SKILL_REFERENCED",
        "SKILL_RESOURCE_STALE",
        "SKILL_REVISION_CONFLICT",
        "SKILL_TOO_LARGE",
        "SKILL_UNSUPPORTED_FORMAT",
        "SKILL_VERSION_CONFLICT",
    ]
)


def safe_error(error):
    code = getattr(error, "code", None)
    return code if isinstance(code, str) and code in SAFE_ERRORS else "STARLINK_UNAVAILABLE"


class StarlinkMCP(FastMCP):
    """Strict reasoning inputs and code-only errors before SDK coercion/echoing."""

    async def list_tools(self):
        listing = await super().list_tools()
        for tool in listing:
            if tool.name.startswith("xingtu_reasoning_"):
                tool.inputSchema = {**tool.inputSchema, "additionalProperties": False}
        return listing

    async def call_tool(self, name, arguments):
        operations = {"xingtu_reasoning_" + op.replace("-", "_"): op for op in OPERATIONS}
        if name not in operations:
            return await super().call_tool(name, arguments)
        try:
            payload = validate_payload("/reasoning/" + operations[name], arguments, None)
        except (ValueError, ValidationError):
            return CallToolResult(
                isError=True, content=[TextContent(type="text", text="SKILL_INVALID_REQUEST")]
            )
        try:
            return await super().call_tool(name, payload)
        except Exception as error:
            code = "STARLINK_UNAVAILABLE"
            # The SDK wraps domain errors; never return its message or supplied values.
            for _ in range(8):
                if error is None:
                    break
                candidate = safe_error(error)
                if candidate != "STARLINK_UNAVAILABLE":
                    code = candidate
                    break
                if (
                    isinstance(error, ValueError)
                    and len(error.args) == 1
                    and isinstance(error.args[0], str)
                    and error.args[0] in SAFE_ERRORS
                ):
                    code = error.args[0]
                    break
                error = error.__cause__
            return CallToolResult(isError=True, content=[TextContent(type="text", text=code)])


async def public_read(
    server: Any,
    key: str,
    path: str,
    *,
    payload: dict[str, Any] | None = None,
    query: dict[str, str] | None = None,
) -> dict[str, Any]:
    try:
        with request_guard(
            server.paths.root,
            "POST" if path == "/search" or path in REASONING_PATHS else "GET",
            "/api/open/v1" + path,
        ):
            return await _public_read(server, key, path, payload=payload, query=query)
    except MaintenanceError:
        raise SemanticaError("SEMANTICA_MAINTENANCE") from None


async def _public_read(
    server: Any,
    key: str,
    path: str,
    *,
    payload: dict[str, Any] | None = None,
    query: dict[str, str] | None = None,
) -> dict[str, Any]:
    # Only fixed public read operations, never the service-token management API.
    if not re.fullmatch(r"xg_[A-Za-z0-9_-]{30,80}", key):
        raise SemanticaError("ACCESS_KEY_INVALID", 401)
    if path not in REASONING_PATHS and not re.fullmatch(
        r"/(warehouse|documents|graph|search|evidence/[A-Za-z0-9_-]{1,128})", path
    ):
        raise SemanticaError("SEMANTICA_INVALID_REQUEST", 422)
    if path in REASONING_PATHS:
        try:
            payload = validate_payload(path, payload, query)
        except (ValueError, ValidationError):
            raise SemanticaError("SKILL_INVALID_REQUEST", 422) from None
    if (
        payload is not None
        and len(
            json.dumps(payload, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode(
                "utf-8"
            )
        )
        > 128 * 1024
    ):
        raise SemanticaError("SEMANTICA_REQUEST_TOO_LARGE", 413)

    def address() -> str:
        config_path = server.paths.root / "semantica.json"
        if config_path.stat().st_size > 16384:
            raise ValueError("SEMANTICA_CONFIG_INVALID")
        value = json.loads(config_path.read_text())["service_url"]
        u = urlsplit(value)
        try:
            local = u.hostname == "localhost" or ipaddress.ip_address(u.hostname or "").is_loopback
        except ValueError:
            local = False
        if (
            not local
            or u.scheme != "http"
            or u.username
            or u.password
            or u.query
            or u.fragment
            or u.path not in {"", "/"}
        ):
            raise ValueError("SEMANTICA_CONFIG_INVALID")
        return str(value).rstrip("/")

    base = await asyncio.to_thread(address)
    async with httpx.AsyncClient(
        timeout=320 if path in REASONING_PATHS else 90, trust_env=False, follow_redirects=False
    ) as client:
        response = await client.request(
            "POST" if path == "/search" or path in REASONING_PATHS else "GET",
            base + "/api/open/v1" + path,
            headers={"Authorization": "Bearer " + key},
            params=query,
            json=payload if path == "/search" or path in REASONING_PATHS else None,
        )
    if response.status_code == 401:
        raise SemanticaError("ACCESS_KEY_INVALID", 401)
    return SemanticaClient.decode(response)


class WarehouseKeyVerifier:
    def __init__(self, server: Any):
        self.server = server

    async def verify_token(self, token: str) -> AccessToken | None:
        try:
            await public_read(self.server, token, "/warehouse")
        except Exception:
            return None
        return AccessToken(token=token, client_id="starlink-warehouse-key", scopes=["starlink"])


def mount_starlink_mcp(app: FastAPI, server: Any, *, origin_guard, mount_transport) -> FastMCP:
    mcp = StarlinkMCP(
        "wanx-starlink",
        instructions="万象·星图 MCP。使用仓库专属 Key，只能读取该 Key 绑定仓的知识与证据。空间资料使用独立的空间 MCP 和 Key。",
        stateless_http=True,
        json_response=True,
        streamable_http_path="/starlink",
        transport_security=TransportSecuritySettings(enable_dns_rebinding_protection=False),
    )

    async def read(
        path: str, *, query: dict[str, str] | None = None, payload: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        access = get_access_token()
        if not access:
            raise ValueError("ACCESS_KEY_REQUIRED")
        try:
            return await public_read(server, access.token, path, query=query, payload=payload)
        except Exception as exc:
            # Never serialize HTTP headers/configuration in a tool error.
            raise ValueError(safe_error(exc)) from None

    @mcp.tool(description="读取当前仓库 Key 所绑定的星图仓库概况。不能指定其他仓库。")
    async def xingtu_warehouse() -> dict[str, Any]:
        return await read("/warehouse")

    @mcp.tool(description="读取此仓库 Key 获准的材料列表。")
    async def xingtu_documents(
        limit: int = Field(default=100, ge=1, le=200), offset: int = Field(default=0, ge=0)
    ) -> dict[str, Any]:
        return await read("/documents", query={"limit": str(limit), "offset": str(offset)})

    @mcp.tool(description="读取授权仓的真实知识图谱与来源，遵循仓库保护规则。")
    async def xingtu_graph(
        limit: int = Field(default=200, ge=1, le=500),
        entity_id: str = Field(default="", max_length=128),
    ) -> dict[str, Any]:
        return await read(
            "/graph", query={"limit": str(limit), **({"entity_id": entity_id} if entity_id else {})}
        )

    @mcp.tool(description="在授权仓检索证据与引用。")
    async def xingtu_search(
        query: str = Field(min_length=1, max_length=2000),
        limit: int = Field(default=10, ge=1, le=50),
    ) -> dict[str, Any]:
        return await read("/search", payload={"query": query, "limit": limit})

    @mcp.tool(description="读取授权仓内的证据，不能跨仓。")
    async def xingtu_evidence(
        evidence_id: str = Field(pattern=r"^[A-Za-z0-9_-]{1,128}$"),
    ) -> dict[str, Any]:
        return await read("/evidence/" + evidence_id)

    register_tools(mcp, read)

    transport = mcp.streamable_http_app()
    secured = origin_guard(
        AuthenticationMiddleware(
            AuthContextMiddleware(RequireAuthMiddleware(transport, ["starlink"])),
            backend=BearerAuthBackend(WarehouseKeyVerifier(server)),
        ),
        server,
    )
    mount_transport(app, "starlink", secured)
    app.state.starlink_mcp = mcp
    return mcp
