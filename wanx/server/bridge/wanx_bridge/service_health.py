"""Health and activation gates shared by registered box services."""

from __future__ import annotations

from typing import Any

import httpx

from .service_activation import ActivationError, load_activation, matches_running
from .service_registry import ServiceRegistry


def _version(value: str) -> tuple[int, int, int]:
    try:
        parts = value.split(".", 2)
        return tuple(int(part.split("-", 1)[0]) for part in (parts + ["0", "0"])[:3])  # type: ignore[return-value]
    except (AttributeError, TypeError, ValueError):
        return (-1, -1, -1)


async def service_status(
    registry: ServiceRegistry,
    service_id: str,
    *,
    client: httpx.AsyncClient | None = None,
    bridge_protocol: int = 1,
    wanx_version: str | None = None,
) -> dict[str, Any]:
    base = {
        "schemaVersion": 1,
        "serviceId": service_id,
        "bridgeProtocolVersion": bridge_protocol,
        "bridgeVersion": wanx_version,
    }
    record = registry.get(service_id)
    if record is None or not record.enabled:
        return {**base, "status": "not_installed", "version": None, "protocolVersion": None}
    activation = None
    if record.activation_file is not None:
        try:
            activation = load_activation(
                record.activation_file, service_id=record.service_id,
                supported_profiles=record.activation_profiles,
            )
        except ActivationError as exc:
            return {**base, "status": "failed", "version": None, "protocolVersion": None, "code": exc.code}
        if activation is None:
            return {**base, "status": "not_installed", "version": None, "protocolVersion": None}
        if activation["state"] != "committed":
            return {**base, "status": "starting", "version": None, "protocolVersion": None, "code": "SERVICE_ACTIVATION_PENDING"}
    if record.protocol_version != bridge_protocol:
        return {**base, "status": "incompatible", "version": record.version, "protocolVersion": record.protocol_version, "code": "SERVICE_PROTOCOL_INCOMPATIBLE"}
    minimum = record.min_wanx_version[2:].split(" ")[0] if record.min_wanx_version.startswith(">=") else None
    if wanx_version and minimum and _version(wanx_version) < _version(minimum):
        return {**base, "status": "incompatible", "version": record.version, "protocolVersion": record.protocol_version, "code": "SERVICE_WANX_VERSION_INCOMPATIBLE"}
    own_client = client is None
    client = client or httpx.AsyncClient(trust_env=False, follow_redirects=False, timeout=httpx.Timeout(2.0))
    try:
        try:
            liveness_response = await client.get(record.upstream + record.liveness)
        except (httpx.HTTPError, OSError, TimeoutError):
            return {
                **base,
                "status": "starting",
                "version": record.version,
                "protocolVersion": record.protocol_version,
                "code": "SERVICE_NOT_READY",
            }
        if liveness_response.status_code != 200:
            status = "degraded" if liveness_response.status_code < 500 else "failed"
            return {
                **base,
                "status": status,
                "version": record.version,
                "protocolVersion": record.protocol_version,
                "code": "SERVICE_LIVENESS_FAILED",
            }
        try:
            readiness_response = await client.get(record.upstream + record.readiness)
        except (httpx.HTTPError, OSError, TimeoutError):
            return {
                **base,
                "status": "starting",
                "version": record.version,
                "protocolVersion": record.protocol_version,
                "code": "SERVICE_NOT_READY",
            }
        if readiness_response.status_code != 200:
            status = "degraded" if readiness_response.status_code < 500 else "failed"
            return {
                **base,
                "status": status,
                "version": record.version,
                "protocolVersion": record.protocol_version,
                "code": "SERVICE_READINESS_FAILED",
            }
        try:
            readiness = readiness_response.json()
        except ValueError:
            readiness = {}
        if isinstance(readiness, dict) and readiness.get("ready") is False:
            return {
                **base,
                "status": "starting",
                "version": record.version,
                "protocolVersion": record.protocol_version,
                "code": readiness.get("code", "SERVICE_NOT_READY"),
            }
        actual_version = record.version
        actual_protocol = record.protocol_version
        try:
            version_response = await client.get(record.upstream + record.version_path)
        except (httpx.HTTPError, OSError, TimeoutError):
            return {
                **base,
                "status": "degraded",
                "version": actual_version,
                "protocolVersion": actual_protocol,
                "code": "SERVICE_VERSION_UNAVAILABLE",
            }
        if version_response.status_code != 200:
            return {
                **base,
                "status": "degraded",
                "version": actual_version,
                "protocolVersion": actual_protocol,
                "code": "SERVICE_VERSION_UNAVAILABLE",
            }
        try:
            version_info = version_response.json()
        except ValueError:
            version_info = None
        if not isinstance(version_info, dict) or type(version_info.get("protocolVersion")) is not int:
            return {
                **base,
                "status": "incompatible",
                "version": actual_version,
                "protocolVersion": None,
                "code": "SERVICE_VERSION_INVALID",
            }
        actual_version = version_info.get("version") or actual_version
        actual_protocol = version_info["protocolVersion"]
        if actual_protocol != record.protocol_version:
            return {
                **base,
                "status": "incompatible",
                "version": actual_version,
                "protocolVersion": actual_protocol,
                "code": "SERVICE_PROTOCOL_INCOMPATIBLE",
            }
        if activation is not None:
            try:
                current = load_activation(
                    record.activation_file, service_id=record.service_id,
                    supported_profiles=record.activation_profiles,
                )
            except ActivationError:
                current = None
            if current != activation:
                return {**base, "status": "starting", "version": actual_version, "protocolVersion": actual_protocol, "code": "SERVICE_ACTIVATION_CHANGED"}
            if not matches_running(activation, version_info):
                return {**base, "status": "incompatible", "version": actual_version, "protocolVersion": actual_protocol, "code": "SERVICE_ACTIVATION_MISMATCH"}
        return {
            **base,
            "status": "ready",
            "version": actual_version,
            "protocolVersion": actual_protocol,
        }
    finally:
        if own_client:
            await client.aclose()
