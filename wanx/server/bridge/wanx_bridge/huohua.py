"""Fixed Bridge routes for the optional ``huohua-boxd`` service."""

from __future__ import annotations

import asyncio
from collections.abc import Mapping
from typing import Any
from urllib.parse import unquote

from .config import BridgeAuthError
from .service_health import service_status as service_status
from .service_registry import SERVICE_ID
from .service_sessions import ServiceSessionVerifier

CAPABILITIES: dict[str, tuple[str, str, str]] = {
    "browser.platform": ("POST", "/api/browser/platform-sessions", "workbench:browser"),
    "browser.platform.storage": ("POST", "/api/browser/platform-sessions/storage", "workbench:browser"),
    "browser.platform.automation": ("POST", "/api/browser/platform-sessions/automation", "workbench:browser"),
    "dialogue.models": ("GET", "/api/dialogue/models", "workbench:read"),
    "providers.resolved": ("GET", "/api/providers/resolved", "workbench:read"),
    "providers.active-model": ("GET", "/api/providers/active-model", "workbench:read"),
    "dialogue.sessions": ("ANY", "/api/dialogue/sessions", "workbench:write"),
    "agents": ("ANY", "/api/agents", "workbench:write"),
    "personal-space.overview": ("GET", "/api/personal-space/overview", "workbench:read"),
    "personal-space.files": ("ANY", "/api/personal-space/files", "workbench:read"),
    "personal-space.folders": ("ANY", "/api/personal-space/folders", "workbench:write"),
    "personal-space.uploads": ("POST", "/api/personal-space/uploads", "workbench:write"),
    "personal-space.trash": ("ANY", "/api/personal-space/trash", "workbench:write"),
    "browser.env": ("GET", "/api/browser/env-status", "workbench:browser"),
    "browser.sessions": ("GET", "/api/browser/harness-sessions", "workbench:browser"),
    "browser.control": ("GET", "/api/browser/control-capabilities", "workbench:browser"),
    "browser.handoff": ("POST", "/api/browser/sessions", "workbench:browser"),
    "browser.shutdown": ("POST", "/api/browser/shutdown", "workbench:browser"),
    "browser.model-access": ("POST", "/api/browser/model-access", "workbench:browser"),
    "browser.install": ("POST", "/api/browser/install", "workbench:browser"),
    "browser.record": ("ANY", "/api/browser/record-replay", "workbench:browser"),
    "browser.learning": ("ANY", "/api/browser/learning", "workbench:browser"),
    "browser.uninstall": ("POST", "/api/browser/uninstall", "workbench:browser"),
}
_SENSITIVE_FIELDS = frozenset(
    {
        "authorization",
        "cookie",
        "access_token",
        "accesstoken",
        "api_key",
        "apikey",
        "client_secret",
        "clientsecret",
        "credentials",
        "provider_credentials",
        "providercredentials",
        "provider_token",
        "providertoken",
        "secret",
        "service_id",
        "serviceid",
        "base_url",
        "baseurl",
        "host",
        "port",
        "upstream",
        "upstream_url",
        "upstreamurl",
    }
)
_QUERY_FIELDS = frozenset(
    {
        "cursor",
        "folderId",
        "folder_id",
        "limit",
        "offset",
        "page",
        "pageSize",
        "page_size",
        "parent",
        "q",
        "sessionId",
        "session_id",
        "spaceId",
        "space_id",
        "sort",
        "userId",
        "user_id",
    }
)
_EXACT_CAPABILITIES = frozenset(
    {
        "dialogue.models",
        "providers.resolved",
        "providers.active-model",
        "personal-space.overview",
        "personal-space.uploads",
        "browser.env",
        "browser.sessions",
        "browser.control",
        "browser.shutdown",
        "browser.model-access",
        "browser.install",
        "browser.uninstall",
    }
)


def _path_allowed(spec_path: str, path: str) -> bool:
    return path == spec_path or path.startswith(spec_path + "/")


def resolve_capability(capability: str, method: str, path: str) -> tuple[str, str]:
    if not isinstance(capability, str) or capability not in CAPABILITIES:
        raise BridgeAuthError("CAPABILITY_NOT_ALLOWED", 403)
    expected_method, prefix, scope = CAPABILITIES[capability]
    if not isinstance(method, str) or method.upper() not in {"GET", "POST", "PUT", "PATCH", "DELETE"}:
        raise BridgeAuthError("CAPABILITY_METHOD_NOT_ALLOWED", 403)
    method = method.upper()
    if expected_method != "ANY" and method != expected_method:
        raise BridgeAuthError("CAPABILITY_METHOD_NOT_ALLOWED", 403)
    if capability in {"browser.record", "browser.learning"} and method not in {"GET", "POST"}:
        raise BridgeAuthError("CAPABILITY_METHOD_NOT_ALLOWED", 403)
    if not isinstance(path, str) or not path.startswith("/"):
        raise BridgeAuthError("CAPABILITY_PATH_INVALID", 400)
    decoded_path = path
    for _ in range(3):
        next_path = unquote(decoded_path)
        if next_path == decoded_path:
            break
        decoded_path = next_path
    if "\\" in decoded_path or "//" in decoded_path or ".." in decoded_path.split("/"):
        raise BridgeAuthError("CAPABILITY_PATH_INVALID", 400)
    if capability in _EXACT_CAPABILITIES and decoded_path != prefix:
        raise BridgeAuthError("CAPABILITY_PATH_NOT_ALLOWED", 403)
    if capability not in _EXACT_CAPABILITIES and not _path_allowed(prefix, decoded_path):
        raise BridgeAuthError("CAPABILITY_PATH_NOT_ALLOWED", 403)
    if capability.startswith("browser.platform"):
        from .platform_sessions import ACTIONS, AUTOMATION_ACTIONS, STORAGE_ACTIONS
        actions = {"browser.platform": ACTIONS, "browser.platform.storage": STORAGE_ACTIONS, "browser.platform.automation": AUTOMATION_ACTIONS}[capability]
        if decoded_path not in {prefix + "/" + action for action in actions}:
            raise BridgeAuthError("CAPABILITY_PATH_NOT_ALLOWED", 403)
    if capability == "browser.handoff":
        parts = decoded_path.split("/")
        if len(parts) != 6 or not parts[4] or parts[5] != "handoff":
            raise BridgeAuthError("CAPABILITY_PATH_NOT_ALLOWED", 403)
    if capability in {"dialogue.sessions", "personal-space.files", "agents"}:
        scope = "workbench:read" if method in {"GET", "HEAD"} else "workbench:write"
    if decoded_path.endswith("/chat/ws"):
        raise BridgeAuthError("CAPABILITY_WEBSOCKET_NOT_ALLOWED", 403)
    return decoded_path, scope


def _validate_context(value: Any, claims: Mapping[str, Any]) -> None:
    """Reject identity overrides nested in a capability payload or query."""
    if isinstance(value, Mapping):
        for key, item in value.items():
            normalized = key.casefold().replace("-", "_") if isinstance(key, str) else key
            if normalized in {"userid", "user_id"} and item != claims.get("userId"):
                raise BridgeAuthError("SERVICE_CONTEXT_FORBIDDEN", 403)
            if normalized in {"spaceid", "space_id"} and item != claims.get("spaceId"):
                raise BridgeAuthError("SERVICE_CONTEXT_FORBIDDEN", 403)
            if normalized in {"owner", "ownerid", "owner_id"} and item not in (
                claims.get("userId"),
                claims.get("spaceId"),
            ):
                raise BridgeAuthError("SERVICE_CONTEXT_FORBIDDEN", 403)
            _validate_context(item, claims)
    elif isinstance(value, list):
        for item in value:
            _validate_context(item, claims)


def _validate_payload(value: Any, claims: Mapping[str, Any], *, depth: int = 0) -> None:
    """Keep capability payloads data-only and prevent credential tunnelling."""
    if depth > 12:
        raise BridgeAuthError("CAPABILITY_REQUEST_INVALID", 400)
    if isinstance(value, Mapping):
        if len(value) > 128:
            raise BridgeAuthError("CAPABILITY_REQUEST_INVALID", 400)
        for key, item in value.items():
            if not isinstance(key, str) or len(key) > 128:
                raise BridgeAuthError("CAPABILITY_REQUEST_INVALID", 400)
            if key.casefold().replace("-", "_") in _SENSITIVE_FIELDS:
                raise BridgeAuthError("CAPABILITY_FIELD_FORBIDDEN", 403)
            _validate_payload(item, claims, depth=depth + 1)
    elif isinstance(value, list):
        if len(value) > 2048:
            raise BridgeAuthError("CAPABILITY_REQUEST_INVALID", 400)
        for item in value:
            _validate_payload(item, claims, depth=depth + 1)
    elif isinstance(value, str) and len(value) > 65536:
        raise BridgeAuthError("CAPABILITY_REQUEST_INVALID", 400)
    _validate_context(value, claims)




class HuohuaCapabilityGateway:
    """Validate capability contracts before handing requests to an adapter."""

    def __init__(
        self,
        adapter: Any,
        *,
        origin: str,
        verifier: ServiceSessionVerifier,
        requester: Any = None,
    ) -> None:
        self.adapter = adapter
        self.origin = origin.rstrip("/")
        self.verifier = verifier
        self.requester = requester

    async def dispatch(self, token: str, capability: str, request: dict[str, Any]) -> Any:
        claims = self.verifier.verify(token, service_id=SERVICE_ID)
        if not isinstance(claims.get("userId"), str):
            raise BridgeAuthError("SERVICE_CONTEXT_REQUIRED", 403)
        if not isinstance(request, dict):
            raise BridgeAuthError("CAPABILITY_REQUEST_INVALID", 400)
        allowed = {"method", "path", "body", "query", "userId", "spaceId"}
        if set(request) - allowed:
            raise BridgeAuthError("CAPABILITY_REQUEST_INVALID", 400)
        method = request.get("method", "GET")
        path = request.get("path")
        if path is None:
            path = CAPABILITIES.get(capability, (None, None, None))[1]
        path, scope = resolve_capability(capability, method, path)
        self.verifier.verify(token, service_id=SERVICE_ID, required_scope=scope)
        for key in ("userId", "spaceId"):
            if key in request and request[key] != claims.get(key):
                raise BridgeAuthError("SERVICE_CONTEXT_FORBIDDEN", 403)
        payload = request.get("body")
        if payload is not None and not isinstance(payload, (dict, list)):
            raise BridgeAuthError("CAPABILITY_REQUEST_INVALID", 400)
        query = request.get("query", {})
        if not isinstance(query, Mapping) or any(
            not isinstance(key, str) or not isinstance(value, (str, int, float, bool))
            for key, value in query.items()
        ):
            raise BridgeAuthError("CAPABILITY_REQUEST_INVALID", 400)
        if any(
            key not in _QUERY_FIELDS
            and key.casefold().replace("-", "_") not in _SENSITIVE_FIELDS
            for key in query
        ):
            raise BridgeAuthError("CAPABILITY_FIELD_FORBIDDEN", 403)
        if len(query) > 16:
            raise BridgeAuthError("CAPABILITY_REQUEST_INVALID", 400)
        if capability == "browser.platform.storage":
            from .platform_sessions import validate_storage
            if not isinstance(payload, dict) or set(payload) - {"sessionId", "expectedRevision", "storageState", "syncId", "revision", "success"}:
                raise BridgeAuthError("CAPABILITY_REQUEST_INVALID", 400)
            if "storageState" in payload:
                validate_storage(payload["storageState"])
            _validate_payload({k: v for k, v in payload.items() if k != "storageState"}, claims)
        else:
            _validate_payload(payload, claims)
        _validate_payload(query, claims)
        handler = self.requester or getattr(self.adapter, "capability_request", None) or getattr(
            self.adapter, "request_as_service", None
        )
        if handler is None:
            raise BridgeAuthError("CAPABILITY_SERVICE_UNAVAILABLE", 503)
        if self.requester is not None:
            result = handler(method.upper(), path, claims, payload, dict(query), token)
        else:
            result = handler(method.upper(), path, claims, payload, dict(query))
        if asyncio.iscoroutine(result):
            result = await result
        return result
