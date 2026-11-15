"""Explicit, fail-closed registry for optional box services.

The registry is deliberately configuration-only.  It is read when Bridge starts,
never discovered over the network, and never contains a service private key.
"""

from __future__ import annotations

import json
import os
import re
import stat
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from .service_activation import SUPPORTED_PROFILES

SERVICE_ID = "huohua.workbench"
SERVICE_REGISTRY_ENV = "WANX_BRIDGE_SERVICE_REGISTRY_FILE"
SERVICE_UPSTREAM = "http://127.0.0.1:8093"
SERVICE_ROUTE_PREFIX = "/api/huohua/v1"
GENERIC_SCOPES = frozenset({"service:read", "service:write"})
HUOHUA_SCOPES = frozenset({"workbench:read", "workbench:write", "workbench:browser"})
_SERVICE_ID = re.compile(r"[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*\Z")
SERVICE_STATUSES = frozenset(
    {"not_installed", "starting", "ready", "degraded", "incompatible", "failed"}
)


class ServiceRegistryError(ValueError):
    """Raised when a registry cannot be trusted."""

    def __init__(self, code: str) -> None:
        self.code = code
        super().__init__(code)


def _text(value: Any, *, max_length: int = 256) -> str:
    if not isinstance(value, str) or not value or len(value) > max_length:
        raise ServiceRegistryError("SERVICE_REGISTRY_INVALID")
    return value


def _loopback_origin(value: Any) -> str:
    origin = _text(value)
    try:
        parsed = urlsplit(origin)
        port = parsed.port
    except ValueError as exc:
        raise ServiceRegistryError("SERVICE_REGISTRY_UPSTREAM_INVALID") from exc
    if (
        parsed.scheme != "http"
        or parsed.hostname != "127.0.0.1"
        or port is None
        or not 1 <= port <= 65535
        or parsed.username
        or parsed.password
        or parsed.path not in {"", "/"}
        or parsed.query
        or parsed.fragment
    ):
        raise ServiceRegistryError("SERVICE_REGISTRY_UPSTREAM_INVALID")
    return f"http://127.0.0.1:{port}"


def _route(value: Any, service_id: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ServiceRegistryError("SERVICE_REGISTRY_ROUTE_INVALID")
    if set(value) - {"prefix", "methods", "sse", "websocket"}:
        raise ServiceRegistryError("SERVICE_REGISTRY_ROUTE_INVALID")
    prefix = SERVICE_ROUTE_PREFIX if service_id == SERVICE_ID else f"/api/services/{service_id}/v1"
    if value.get("prefix") != prefix:
        raise ServiceRegistryError("SERVICE_REGISTRY_ROUTE_INVALID")
    methods = value.get("methods")
    if (
        not isinstance(methods, list)
        or not methods
        or any(not isinstance(method, str) or method not in {"GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"} for method in methods)
        or len(set(methods)) != len(methods)
    ):
        raise ServiceRegistryError("SERVICE_REGISTRY_ROUTE_INVALID")
    # Huohua uses HTTP/SSE.  Existing Agent chat WebSockets keep their
    # existing WANX contract and must not become a service-specific tunnel.
    if value.get("websocket", False) is not False or type(value.get("sse", False)) is not bool:
        raise ServiceRegistryError("SERVICE_REGISTRY_ROUTE_INVALID")
    return {"prefix": prefix, "methods": list(methods), "sse": value.get("sse", False), "websocket": False}


@dataclass(frozen=True)
class ServiceRoute:
    prefix: str
    methods: frozenset[str]
    sse: bool
    websocket: bool

    def allows(self, method: str, path: str, *, websocket: bool = False) -> bool:
        if websocket or method not in self.methods:
            return False
        return path == self.prefix or path.startswith(self.prefix + "/")


@dataclass(frozen=True)
class ServiceRecord:
    service_id: str
    enabled: bool
    upstream: str
    uid: int
    token_audience: str
    protocol_version: int
    min_wanx_version: str
    version: str | None
    routes: tuple[ServiceRoute, ...]
    liveness: str
    readiness: str
    version_path: str
    service_public_key_file: Path
    activation_file: Path | None
    activation_profiles: tuple[dict[str, Any], ...] = ()

    @property
    def route_prefix(self) -> str:
        return self.routes[0].prefix

    @property
    def allowed_scopes(self) -> frozenset[str]:
        return HUOHUA_SCOPES if self.service_id == SERVICE_ID else GENERIC_SCOPES

    @property
    def bootstrap_scopes(self) -> frozenset[str]:
        return self.allowed_scopes - {"workbench:browser"}

    def allows(self, method: str, path: str, *, websocket: bool = False) -> bool:
        return any(route.allows(method, path, websocket=websocket) for route in self.routes)

    def public_key_bytes(self) -> bytes:
        try:
            info = self.service_public_key_file.lstat()
            if (
                not stat.S_ISREG(info.st_mode)
                or info.st_size != 32
                or (os.name == "posix" and info.st_uid != os.geteuid())
            ):
                raise OSError
            if os.name == "posix" and (info.st_mode & 0o077):
                raise OSError
            return self.service_public_key_file.read_bytes()
        except (OSError, ValueError) as exc:
            raise ServiceRegistryError("SERVICE_REGISTRY_PUBLIC_KEY_INVALID") from exc


class ServiceRegistry:
    def __init__(self, services: dict[str, ServiceRecord], *, source: Path | None = None) -> None:
        self.services = dict(services)
        self.source = source

    def get(self, service_id: str) -> ServiceRecord | None:
        return self.services.get(service_id)

    @classmethod
    def empty(cls) -> ServiceRegistry:
        return cls({})

    @classmethod
    def from_mapping(cls, value: Any, *, source: Path | None = None) -> ServiceRegistry:
        if not isinstance(value, dict) or type(value.get("schemaVersion")) is not int or value.get("schemaVersion") != 1:
            raise ServiceRegistryError("SERVICE_REGISTRY_SCHEMA_UNSUPPORTED")
        services = value.get("services")
        if not isinstance(services, dict):
            raise ServiceRegistryError("SERVICE_REGISTRY_INVALID")
        result: dict[str, ServiceRecord] = {}
        for service_id, raw in services.items():
            if (not isinstance(service_id, str) or len(service_id) > 128
                    or not _SERVICE_ID.fullmatch(service_id) or not isinstance(raw, dict)):
                raise ServiceRegistryError("SERVICE_REGISTRY_SERVICE_INVALID")
            required = {"enabled", "upstream", "uid", "tokenAudience", "protocolVersion", "minWanxVersion", "routes", "health", "servicePublicKeyFile"}
            if set(raw) - required - {"version", "activation"} or not required.issubset(raw):
                raise ServiceRegistryError("SERVICE_REGISTRY_SERVICE_INVALID")
            if type(raw["enabled"]) is not bool or type(raw["uid"]) is not int or raw["uid"] < 0:
                raise ServiceRegistryError("SERVICE_REGISTRY_SERVICE_INVALID")
            if raw["tokenAudience"] != "wanx-bridge" or type(raw["protocolVersion"]) is not int or raw["protocolVersion"] != 1:
                raise ServiceRegistryError("SERVICE_REGISTRY_SERVICE_INVALID")
            health = raw["health"]
            if not isinstance(health, dict) or set(health) != {"liveness", "readiness", "version"}:
                raise ServiceRegistryError("SERVICE_REGISTRY_HEALTH_INVALID")
            paths = tuple(_text(health[key], max_length=128) for key in ("liveness", "readiness", "version"))
            if any(
                not path.startswith("/")
                or ".." in path.split("/")
                or "//" in path
                or "\\" in path
                or any(char in path for char in "%?#")
                for path in paths
            ):
                raise ServiceRegistryError("SERVICE_REGISTRY_HEALTH_INVALID")
            activation = raw.get("activation", {"mode": "ota", "path": f"/var/lib/wanx/services/{service_id}/activation.json"})
            if not isinstance(activation, dict):
                raise ServiceRegistryError("SERVICE_REGISTRY_ACTIVATION_INVALID")
            if activation == {"mode": "legacy"}:
                activation_file = None
                profiles = ()
            elif {"mode", "path"}.issubset(activation) and not set(activation) - {"mode", "path", "profiles"} and activation["mode"] == "ota":
                activation_file = Path(_text(activation["path"], max_length=1024))
                if not activation_file.is_absolute() or ".." in activation_file.parts:
                    raise ServiceRegistryError("SERVICE_REGISTRY_ACTIVATION_INVALID")
                profiles = activation.get("profiles", list(SUPPORTED_PROFILES) if service_id == SERVICE_ID else [])
                if not isinstance(profiles, list) or not profiles or any(
                    not isinstance(profile, dict)
                    or set(profile) != {"profileId", "profileVersion", "profileDigest"}
                    or not isinstance(profile["profileId"], str)
                    or not 1 <= len(profile["profileId"]) <= 128
                    or type(profile["profileVersion"]) is not int
                    or profile["profileVersion"] < 1
                    or not isinstance(profile["profileDigest"], str)
                    or re.fullmatch(r"[0-9a-f]{64}", profile["profileDigest"]) is None
                    for profile in profiles
                ):
                    raise ServiceRegistryError("SERVICE_REGISTRY_ACTIVATION_INVALID")
            else:
                raise ServiceRegistryError("SERVICE_REGISTRY_ACTIVATION_INVALID")
            key_path = Path(_text(raw["servicePublicKeyFile"], max_length=1024))
            if not key_path.is_absolute():
                raise ServiceRegistryError("SERVICE_REGISTRY_PUBLIC_KEY_INVALID")
            raw_routes = raw["routes"]
            if not isinstance(raw_routes, list) or len(raw_routes) != 1:
                raise ServiceRegistryError("SERVICE_REGISTRY_ROUTE_INVALID")
            routes: list[ServiceRoute] = []
            for raw_route in raw_routes:
                route = _route(raw_route, service_id)
                routes.append(
                    ServiceRoute(
                        route["prefix"],
                        frozenset(route["methods"]),
                        route["sse"],
                        route["websocket"],
                    )
                )
            result[service_id] = ServiceRecord(
                service_id=service_id,
                enabled=raw["enabled"],
                upstream=_loopback_origin(raw["upstream"]),
                uid=raw["uid"],
                token_audience=raw["tokenAudience"],
                protocol_version=raw["protocolVersion"],
                min_wanx_version=_text(raw["minWanxVersion"], max_length=64),
                version=raw.get("version") if raw.get("version") is None else _text(raw["version"], max_length=64),
                routes=tuple(routes),
                liveness=paths[0],
                readiness=paths[1],
                version_path=paths[2],
                service_public_key_file=key_path,
                activation_file=activation_file,
                activation_profiles=tuple(dict(profile) for profile in profiles),
            )
        return cls(result, source=source)

    @classmethod
    def load(cls, path: str | Path | None) -> ServiceRegistry:
        if path is None:
            return cls.empty()
        source = Path(path)
        try:
            info = source.lstat()
            if not stat.S_ISREG(info.st_mode) or info.st_size > 65536:
                raise OSError
            if os.name == "posix" and (info.st_mode & 0o077 or info.st_uid != os.geteuid()):
                raise OSError
            flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
            fd = os.open(source, flags)
            try:
                with os.fdopen(fd, "r", encoding="utf-8") as stream:
                    value = json.load(stream)
                fd = -1
            finally:
                if fd >= 0:
                    os.close(fd)
        except (OSError, ValueError, UnicodeError) as exc:
            raise ServiceRegistryError("SERVICE_REGISTRY_FILE_INVALID") from exc
        return cls.from_mapping(value, source=source)

    def as_dict(self) -> dict[str, Any]:
        return {
            "schemaVersion": 1,
            "services": {
                service_id: {
                    "enabled": record.enabled,
                    "upstream": record.upstream,
                    "uid": record.uid,
                    "tokenAudience": record.token_audience,
                    "protocolVersion": record.protocol_version,
                    "minWanxVersion": record.min_wanx_version,
                    **({"version": record.version} if record.version else {}),
                    "routes": [
                        {
                            "prefix": route.prefix,
                            "methods": sorted(route.methods),
                            "sse": route.sse,
                            "websocket": route.websocket,
                        }
                        for route in record.routes
                    ],
                    "health": {"liveness": record.liveness, "readiness": record.readiness, "version": record.version_path},
                    "servicePublicKeyFile": str(record.service_public_key_file),
                    "activation": {"mode": "ota", "path": str(record.activation_file), "profiles": list(record.activation_profiles)} if record.activation_file else {"mode": "legacy"},
                }
                for service_id, record in self.services.items()
            },
        }
