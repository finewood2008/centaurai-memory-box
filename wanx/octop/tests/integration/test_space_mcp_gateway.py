"""Official SDK → desktop relay → box gateway → real MCP auth and storage."""

import asyncio
import shutil
import socket
from contextlib import asynccontextmanager
from pathlib import Path
from types import SimpleNamespace
from uuid import uuid4

import httpx
import pytest
import uvicorn
from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client

from tests.integration.test_space_mcp import BASE, issue

ROOT = Path(__file__).resolve().parents[3]


@asynccontextmanager
async def listening(app):
    """Use kernel-assigned ports; exercise HTTP streaming without external services."""
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    sock.listen(128)
    origin = f"http://127.0.0.1:{sock.getsockname()[1]}"
    server = uvicorn.Server(
        uvicorn.Config(app, log_level="critical", access_log=False, lifespan="off")
    )
    task = asyncio.create_task(server.serve(sockets=[sock]))
    try:
        async with asyncio.timeout(10):
            while not server.started:
                if task.done():
                    await task
                await asyncio.sleep(0.01)
        yield origin
    finally:
        server.should_exit = True
        await asyncio.wait_for(task, 10)
        sock.close()


@asynccontextmanager
async def desktop_relay(node, edition, gateway):
    # No keys or account tokens are passed to the process. Only the SDK holds the key.
    source = """
      const {createSpaceMcpRelay} = await import(process.argv[1]);
      const relay = createSpaceMcpRelay({
        state: {}, persist: async () => {}, scope: () => 'scope',
        storageScope: () => 'owner', assertScope: value => {
          if (value !== 'scope') throw Error('SPACE_CONTEXT_CHANGED');
        },
        client: {
          snapshot: () => ({connection: {mode: 'netbird'}}),
          mcpConnection: async () => ({url: process.argv[2], context() {}}),
        },
      });
      console.log(await relay.url());
      process.stdin.resume();
      process.stdin.once('end', async () => { await relay.close(); });
    """
    process = await asyncio.create_subprocess_exec(
        node,
        "--input-type=module",
        "-e",
        source,
        (ROOT / "apps" / edition / "shell/space-mcp-relay.mjs").as_uri(),
        gateway,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        url = (await asyncio.wait_for(process.stdout.readline(), 10)).decode().strip()
        assert url.startswith("http://127.0.0.1:") and url.endswith("/mcp/space")
        yield url
    finally:
        process.stdin.close()
        try:
            await asyncio.wait_for(process.communicate(), 10)
        except TimeoutError:
            process.kill()
            await process.wait()
            raise
        assert process.returncode == 0


@pytest.mark.parametrize("edition", ["personal-client", "team-client"])
async def test_official_sdk_through_relay_and_gateway(env, monkeypatch, edition):
    node = shutil.which("node")
    if node is None:
        pytest.skip("Node.js required to exercise the production desktop relay")
    monkeypatch.syspath_prepend(str(ROOT / "server" / "bridge"))
    from wanx_bridge.config import BridgeAuthError
    from wanx_bridge.server import create_app

    platform_checks = []

    def authorize(marker):
        # Reproduce the production symptom if an MCP Key reaches platform auth.
        platform_checks.append(marker)
        raise BridgeAuthError("BOX_PLATFORM_SESSION_EXPIRED", 401)

    client, _, admin = env
    aid, key, _ = await issue(client, admin)
    app = client._octop_app
    async with app.state.space_mcp.session_manager.run(), listening(app) as upstream:
        gateway = create_app(SimpleNamespace(authorize=authorize), object(), upstream_url=upstream)
        async with (
            gateway.router.lifespan_context(gateway),
            listening(gateway) as gateway_url,
            desktop_relay(node, edition, gateway_url) as url,
        ):
            async with (
                httpx.AsyncClient(
                    headers={"Authorization": "Bearer " + key}, trust_env=False
                ) as http,
                streamable_http_client(url, http_client=http) as (read, write, _),
                ClientSession(read, write) as session,
            ):
                initialized = await session.initialize()
                assert initialized.serverInfo.name == "wanx-space"
                assert "space_read_text" in {t.name for t in (await session.list_tools()).tools}
                assert (await session.list_resources()).resources
                assert (await session.list_prompts()).prompts
                access = await session.call_tool("space_access", {})
                assert not access.isError and access.structuredContent["workspace"]["root"]
                args = {"operation_id": uuid4().hex, "name": "roundtrip.txt", "text": "first"}
                created = await session.call_tool("space_write_text", args)
                assert not created.isError, created
                assert (await session.call_tool("space_write_text", args)).structuredContent == (
                    created.structuredContent
                )
                fid = created.structuredContent["id"]
                readback = await session.call_tool("space_read_text", {"target": fid})
                assert readback.structuredContent["text"] == "first"
                update = {
                    "operation_id": uuid4().hex,
                    "target": fid,
                    "expected": readback.structuredContent["version"],
                    "text": "second",
                }
                assert not (await session.call_tool("space_write_text", update)).isError
                assert (
                    await session.call_tool(
                        "space_write_text", {**update, "operation_id": uuid4().hex}
                    )
                ).isError
                assert (
                    await session.call_tool("space_read_text", {"target": fid})
                ).structuredContent["text"] == "second"
            assert platform_checks == []
            async with httpx.AsyncClient(trust_env=False) as http:
                # Each layer keeps MCP credentials separate from platform/Starlink auth.
                for method, endpoint, credential in [
                    ("POST", url, "xg_" + "a" * 40),
                    ("POST", url, admin["Authorization"].removeprefix("Bearer ")),
                    ("POST", gateway_url + "/mcp/starlink", key),
                    ("GET", gateway_url + "/api/auth/me", key),
                ]:
                    response = await http.request(
                        method,
                        endpoint,
                        headers={"Authorization": "Bearer " + credential},
                        json={},
                    )
                    assert response.status_code == 401
                assert platform_checks == [key]
                assert (
                    await client.delete(BASE + f"/connections/{aid}", headers=admin)
                ).status_code == 200
                response = await http.post(url, headers={"Authorization": "Bearer " + key}, json={})
                assert response.status_code == 401
                assert platform_checks == [key]
