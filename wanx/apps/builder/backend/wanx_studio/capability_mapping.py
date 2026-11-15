"""Map product capabilities to public WANX Host capabilities/contracts."""
from __future__ import annotations

from typing import Any

HOST_CAPABILITIES = frozenset({
    "identity.read", "http.request", "experts.read", "experts.select", "chat.stream", "files.upload",
})

# Product capabilities are intentionally not copied into protocol-3 manifests.
PRODUCT_MAP = {
    "files": ("files.upload",),
    "model": ("chat.stream",),
}


def resolve(capabilities: list[str], *, expert: bool = False, backend: dict[str, Any] | None = None) -> dict[str, Any]:
    host: list[str] = ["identity.read"]
    gaps: list[dict[str, str]] = []
    for product in dict.fromkeys(capabilities):
        mapped = PRODUCT_MAP.get(product)
        if mapped:
            host.extend(mapped)
        elif product in {"data", "reports", "knowledge"}:
            gaps.append({"id": product, "reason": "NO_PUBLIC_HOST_CONTRACT"})
        elif product:
            gaps.append({"id": product, "reason": "UNKNOWN_PRODUCT_CAPABILITY"})
    if backend and backend.get("mode") != "none":
        host.append("http.request")
    if expert:
        host.extend(("experts.read", "experts.select"))
    return {"hostCapabilities": list(dict.fromkeys(host)), "gaps": gaps}


def validate_manifest_capabilities(manifest: dict[str, Any]) -> list[dict[str, str]]:
    values = manifest.get("capabilities")
    if not isinstance(values, list):
        return [{"code": "HOST_CAPABILITIES_INVALID", "path": "/capabilities"}]
    return [
        {"code": "HOST_CAPABILITY_UNSUPPORTED", "path": f"/capabilities/{index}"}
        for index, value in enumerate(values)
        if value not in HOST_CAPABILITIES
    ]
