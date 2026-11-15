"""MCP review: UTF-8 request budget and safe public URL fallback."""

import json
from types import SimpleNamespace

import httpx
import pytest
from starlette.requests import Request

from wanx_bridge.semantica import mcp
from wanx_bridge.semantica.client import SemanticaError
from wanx_bridge.semantica.mcp_connection import connection_info


@pytest.mark.parametrize("fields,accepted", [(2, True), (4, False)])
async def test_request_limit_measures_utf8_wire_bytes(tmp_path, monkeypatch, fields, accepted):
    (tmp_path / "semantica.json").write_text(json.dumps({"service_url": "http://127.0.0.1:8090"}))
    server = SimpleNamespace(paths=SimpleNamespace(root=tmp_path))
    body = {
        "arguments": {
            "skill_id": "native-check",
            "idempotency_key": "large-request",
            "inputs": {f"field_{i}": "资料" * 6000 for i in range(fields)},
        }
    }
    seen = []

    async def upstream(request):
        seen.append(request)
        assert len(request.content) <= 128 * 1024
        assert json.loads(request.content)["arguments"]["inputs"] == body["arguments"]["inputs"]
        return httpx.Response(200, json={"accepted": True})

    original = httpx.AsyncClient
    monkeypatch.setattr(
        mcp,
        "httpx",
        SimpleNamespace(
            AsyncClient=lambda **kw: original(transport=httpx.MockTransport(upstream), **kw)
        ),
    )
    if accepted:
        assert await mcp._public_read(
            server, "xg_" + "a" * 40, "/reasoning/prepare", payload=body
        ) == {"accepted": True}
        assert len(seen) == 1
    else:
        with pytest.raises(SemanticaError) as error:
            await mcp._public_read(server, "xg_" + "a" * 40, "/reasoning/prepare", payload=body)
        assert error.value.code == "SEMANTICA_REQUEST_TOO_LARGE"
        assert seen == []


@pytest.mark.parametrize(
    "host",
    [
        "[invalid",
        "bridge.example.com:bad",
        "bridge.example.com:0",
        "127.1",
        "127.0.1",
        "0x7f.0.0.1",
        "2130706433",
        "bridge..example.com",
        "-bad.example.com",
    ],
)
def test_invalid_addresses_fall_back_without_advertising_loopback_or_raising(host):
    request = Request(
        {
            "type": "http",
            "scheme": "https",
            "server": ("bridge.example.com", 443),
            "path": "/api/semantica/mcp/connection-info",
            "root_path": "",
            "query_string": b"",
            "headers": [(b"host", host.encode())],
        }
    )
    with pytest.raises(SemanticaError) as error:
        connection_info(request)
    assert error.value.code == "MCP_PUBLIC_URL_UNAVAILABLE"
    assert error.value.status == 503


def test_valid_https_preserves_port_and_deployment_prefix():
    request = Request(
        {
            "type": "http",
            "scheme": "https",
            "server": ("bridge.example.com", 8443),
            "path": "/box/api/semantica/mcp/connection-info",
            "root_path": "/box",
            "query_string": b"",
            "headers": [(b"host", b"bridge.example.com:8443")],
        }
    )
    assert connection_info(request) == {"url": "https://bridge.example.com:8443/box/mcp/starlink"}
