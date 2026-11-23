"""Map product capabilities to public WANX Host capabilities/contracts."""
from __future__ import annotations

from typing import Any

from .public_capabilities import EXPERT, gaps

# Protocol permissions used by the fixed standard shell. Business contract IDs
# are deliberately separate from these Host transport permissions.
HOST_CAPABILITIES = frozenset({"identity.read", "http.request"})


def resolve(capabilities: list[str], *, expert: bool = False, backend: dict[str, Any] | None = None) -> dict[str, Any]:
    host = ["identity.read"]
    if backend and backend.get("mode") != "none":
        host.append("http.request")
    return {"hostCapabilities": host, "gaps": gaps(capabilities, backend=backend)}


def validate_manifest_capabilities(manifest: dict[str, Any]) -> list[dict[str, str]]:
    values = manifest.get("capabilities")
    if not isinstance(values, list):
        return [{"code": "HOST_CAPABILITIES_INVALID", "path": "/capabilities"}]
    return [
        {"code": "HOST_CAPABILITY_UNSUPPORTED", "path": f"/capabilities/{index}"}
        for index, value in enumerate(values)
        if value not in HOST_CAPABILITIES
    ]


def runtime_gaps(capabilities: list[str], *, expert: bool = False, backend: dict[str, Any] | None = None) -> list[dict[str, str]]:
    return gaps(capabilities, backend=backend)
