"""Exercise the exact realtime media route through the public Bridge listener."""

import asyncio
import time
import uuid

import httpx
import pytest
from fastapi import FastAPI, Request, WebSocket
from fastapi.responses import JSONResponse
from test_gateway import Auth, live_server
from test_generic_services import SERVICE, configuration
from websockets.asyncio.client import connect
from websockets.exceptions import ConnectionClosed, InvalidStatus

from wanx_bridge.media_stream import PROTOCOL, TICKET_PREFIX
from wanx_bridge.server import create_app
from wanx_bridge.service_registry import MEDIA_ASR_SESSIONS, MEDIA_SERVICE_ID, ServiceRegistry

AUTH = {"authorization": "Bearer opaque-marker", "x-media-grant": "test-media-grant"}
TICKET = "t" * 43


def create_registry(tmp_path, *, websocket=True, upstream="http://127.0.0.1:19094"):
    raw, _ = configuration(tmp_path)
    record = raw["services"].pop(SERVICE)
    record["upstream"] = upstream
    record["routes"] = [{
        "prefix": f"/api/services/{MEDIA_SERVICE_ID}/v1",
        "methods": ["GET", "POST"],
        "websocket": websocket,
    }]
    raw["services"][MEDIA_SERVICE_ID] = record
    return ServiceRegistry.from_mapping(raw)


def test_registry_restricts_websocket_to_media_session_path(tmp_path):
    registry = create_registry(tmp_path)
    record = registry.get(MEDIA_SERVICE_ID)
    path = MEDIA_ASR_SESSIONS + "/" + ("a" * 32) + "/stream"
    assert record.allows("GET", path, websocket=True)
    assert not record.allows("POST", path, websocket=True)
    assert not record.allows("GET", path + "/other", websocket=True)
    assert not record.allows("GET", path.replace("/stream", "/result"), websocket=True)
    assert not record.allows("GET", path.replace("/" + ("a" * 32), "/invalid"), websocket=True)
    assert not record.allows("GET", record.route_prefix + "/jobs", websocket=True)
    assert not create_registry(tmp_path, websocket=False).get(MEDIA_SERVICE_ID).allows("GET", path, websocket=True)
    assert ServiceRegistry.from_mapping(registry.as_dict()).as_dict() == registry.as_dict()


@pytest.fixture
async def environment(tmp_path):
    upstream = FastAPI()
    seen = []

    @upstream.get("/healthz")
    @upstream.get("/readyz")
    @upstream.get("/version")
    async def health():
        return {"ready": True, "version": "1.0.0", "protocolVersion": 1}

    @upstream.post(MEDIA_ASR_SESSIONS)
    async def create_session(request: Request):
        assert request.headers["x-media-grant"] == AUTH["x-media-grant"]
        assert request.headers["authorization"].startswith("Bearer ey")
        assert "cookie" not in request.headers
        session_id = uuid.uuid4().hex
        return JSONResponse({
            "id": session_id,
            "ticket": TICKET,
            "streamPath": MEDIA_ASR_SESSIONS + f"/{session_id}/stream",
            "ticketExpiresAt": time.time() + 30,
        }, status_code=201)

    @upstream.websocket(MEDIA_ASR_SESSIONS + "/{session_id}/stream")
    async def stream(websocket: WebSocket):
        assert websocket.scope["subprotocols"] == [PROTOCOL, TICKET_PREFIX + TICKET]
        assert not websocket.query_params
        assert "authorization" not in websocket.headers
        assert "x-media-grant" not in websocket.headers
        assert "origin" not in websocket.headers
        seen.append(websocket.url.path)
        await websocket.accept(subprotocol=PROTOCOL)
        message = await websocket.receive()
        if message["type"] == "websocket.disconnect":
            return
        assert message["bytes"] == b"\x00\x00" * 160
        await websocket.send_json({"type": "partial", "text": "你好"})
        assert await websocket.receive_text() == '{"type":"stop"}'
        await websocket.send_json({"type": "end"})
        await websocket.close()

    auth = Auth()
    auth.session.upstream_expires_at = time.time() + 60
    async with live_server(upstream) as upstream_url:
        registry = create_registry(tmp_path, upstream=upstream_url)
        app = create_app(
            auth, object(), service_registry=registry, build_metadata={"version": "1.0.0"},
            lease_check_interval=0.01,
        )
        async with live_server(app) as origin:
            async with httpx.AsyncClient(base_url=origin, trust_env=False) as client:
                yield auth, client, origin.replace("http:", "ws:", 1), seen


async def test_one_shot_ticket_authenticates_and_relays_clip(environment):
    _, client, websocket_origin, seen = environment
    assert (await client.post(MEDIA_ASR_SESSIONS)).status_code == 401
    assert (await client.post(MEDIA_ASR_SESSIONS, params={"token": "opaque-marker"})).status_code == 401
    response = await client.post(MEDIA_ASR_SESSIONS, headers={**AUTH, "cookie": "not-upstream"})
    assert response.status_code == 201, response.text
    assert response.headers["cache-control"] == "no-store"
    path = response.json()["streamPath"]
    url = websocket_origin + path
    protocols = [PROTOCOL, TICKET_PREFIX + response.json()["ticket"]]
    for rejected_url, rejected_protocols in (
        (url, [PROTOCOL, TICKET_PREFIX + ("x" * 43)]),
        (url + "?unused=1", protocols),
        (url.replace("/stream", "/unregistered"), protocols),
    ):
        with pytest.raises(InvalidStatus) as denied:
            async with connect(rejected_url, subprotocols=rejected_protocols):
                pytest.fail("unexpected media socket open")
        assert denied.value.response.status_code == 403
    assert not seen
    async with connect(
        url, subprotocols=protocols, additional_headers=AUTH, origin="https://host.example"
    ) as socket:
        assert socket.subprotocol == PROTOCOL
        await socket.send(b"\x00\x00" * 160)
        assert "你好" in await asyncio.wait_for(socket.recv(), 2)
        await socket.send('{"type":"stop"}')
        assert '"end"' in await asyncio.wait_for(socket.recv(), 2)
        with pytest.raises(ConnectionClosed) as closed:
            await asyncio.wait_for(socket.recv(), 2)
        assert closed.value.rcvd.code == 1000
    assert seen == [path]
    with pytest.raises(InvalidStatus):
        async with connect(url, subprotocols=protocols):
            pytest.fail("the ticket was already spent")
    assert seen == [path]


async def test_idle_media_socket_closes_on_platform_revocation(environment):
    auth, client, websocket_origin, _ = environment
    response = await client.post(MEDIA_ASR_SESSIONS, headers=AUTH)
    assert response.status_code == 201, response.text
    path = response.json()["streamPath"]
    protocols = [PROTOCOL, TICKET_PREFIX + response.json()["ticket"]]
    async with connect(websocket_origin + path, subprotocols=protocols) as socket:
        auth.deadline = time.monotonic()
        with pytest.raises(ConnectionClosed) as closed:
            await asyncio.wait_for(socket.recv(), 2)
        assert closed.value.rcvd.code == 4401


@pytest.mark.parametrize("frame", [b"\x00" * 6402, "t" * 257])
async def test_oversized_media_frame_closes_without_forwarding(environment, frame):
    _, client, websocket_origin, _ = environment
    response = await client.post(MEDIA_ASR_SESSIONS, headers=AUTH)
    assert response.status_code == 201, response.text
    path = response.json()["streamPath"]
    protocols = [PROTOCOL, TICKET_PREFIX + response.json()["ticket"]]
    async with connect(websocket_origin + path, subprotocols=protocols) as socket:
        await socket.send(frame)
        with pytest.raises(ConnectionClosed) as closed:
            await asyncio.wait_for(socket.recv(), 2)
        assert closed.value.rcvd.code == 1009
