import json

import pytest

from wanx_bridge.service_registry import ServiceRegistry, ServiceRegistryError


def registry(tmp_path, *, upstream="http://127.0.0.1:8093"):
    key = tmp_path / "huohua.pub"
    key.write_bytes(b"0" * 32)
    key.chmod(0o600)
    path = tmp_path / "services.json"
    path.write_text(json.dumps({
        "schemaVersion": 1,
        "services": {"huohua.workbench": {
            "enabled": True, "upstream": upstream, "uid": 10006,
            "tokenAudience": "wanx-bridge", "protocolVersion": 1,
            "minWanxVersion": ">=1.0.0", "version": "1.0.0",
            "routes": [{"prefix": "/api/huohua/v1", "methods": ["GET", "POST"], "sse": True, "websocket": False}],
            "health": {"liveness": "/healthz", "readiness": "/readyz", "version": "/version"},
            "activation": {"mode": "legacy"}, "servicePublicKeyFile": str(key),
        }},
    }))
    path.chmod(0o600)
    return path


def test_registry_rejects_non_loopback_upstream(tmp_path):
    with pytest.raises(ServiceRegistryError, match="SERVICE_REGISTRY_UPSTREAM_INVALID"):
        ServiceRegistry.load(registry(tmp_path, upstream="http://example.com:8093"))


def test_registry_round_trips_and_allows_fixed_route(tmp_path):
    loaded = ServiceRegistry.load(registry(tmp_path))
    service = loaded.get("huohua.workbench")
    assert service is not None
    assert service.allows("GET", "/api/huohua/v1/status")
    assert not service.allows("PUT", "/api/huohua/v1/status")
    assert not service.allows("GET", "/api/huohua/v1/status", websocket=True)
    assert not service.allows("PATCH", "/api/huohua/v1")
    assert not service.allows("GET", "http://127.0.0.1:8093/api/huohua/v1/status")


def test_registry_rejects_websocket_route(tmp_path):
    path = registry(tmp_path)
    value = json.loads(path.read_text())
    route = value["services"]["huohua.workbench"]["routes"][0]
    route["websocket"] = True
    path.write_text(json.dumps(value))
    with pytest.raises(ServiceRegistryError, match="SERVICE_REGISTRY_ROUTE_INVALID"):
        ServiceRegistry.load(path)


def test_existing_registry_requires_activation_unless_legacy_explicit(tmp_path):
    path = registry(tmp_path)
    value = json.loads(path.read_text())
    value["services"]["huohua.workbench"].pop("activation")
    loaded = ServiceRegistry.from_mapping(value)
    assert str(loaded.get("huohua.workbench").activation_file) == "/var/lib/wanx/services/huohua.workbench/activation.json"
    assert ServiceRegistry.from_mapping(loaded.as_dict()).as_dict() == loaded.as_dict()
    assert ServiceRegistry.load(path).get("huohua.workbench").activation_file is None
