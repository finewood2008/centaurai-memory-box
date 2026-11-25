"""WANX Bridge's authenticated handoff to the local realtime ASR socket."""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import hmac
import json
import re
import time
from dataclasses import dataclass
from typing import Any

from fastapi import WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse, Response, StreamingResponse
from websockets.asyncio.client import connect
from websockets.exceptions import ConnectionClosed, InvalidHandshake, InvalidStatus

from .config import BridgeAuthError
from .service_registry import MEDIA_ASR_STREAM, ServiceRecord

PROTOCOL = "wanx.asr.v1"
TICKET_PREFIX = "wanx.asr.ticket."
_TICKET = re.compile(r"[A-Za-z0-9_-]{43}")
_MAX_PENDING = 128
_MAX_TICKET_TTL = 30
_MAX_HANDOFF_BYTES = 8192
_MAX_AUDIO_FRAME = 6400
_MAX_CONTROL_FRAME = 256


def _digest(ticket: str) -> bytes:
    return hashlib.sha256(ticket.encode("ascii")).digest()


@dataclass(frozen=True)
class Handoff:
    digest: bytes
    expires: float
    session: Any


class MediaStreamGateway:
    def __init__(self) -> None:
        self.pending: dict[str, Handoff] = {}

    async def bind(self, response: Response, session: Any) -> Response:
        """Keep the platform lease associated with the media service's one-shot ticket."""
        if response.status_code != 201:
            return response
        data = bytearray()
        try:
            if isinstance(response, StreamingResponse):
                iterator = response.body_iterator
                try:
                    async with asyncio.timeout(5):
                        async for chunk in iterator:
                            data.extend(chunk)
                            if len(data) > _MAX_HANDOFF_BYTES:
                                raise ValueError
                finally:
                    await iterator.aclose()
            else:
                data.extend(response.body)
            if len(data) > _MAX_HANDOFF_BYTES:
                raise ValueError
            body = json.loads(data)
            if not isinstance(body, dict):
                raise ValueError
            match = MEDIA_ASR_STREAM.fullmatch(body["streamPath"])
            ticket = body["ticket"]
            expires = body["ticketExpiresAt"]
            if (
                match is None
                or body["id"] != match[1]
                or not _TICKET.fullmatch(ticket)
                or type(expires) not in (int, float)
                or not time.time() < expires < float("inf")
            ):
                raise ValueError
        except (KeyError, TypeError, ValueError, TimeoutError) as exc:
            raise BridgeAuthError("ASR_HANDOFF_INVALID", 502) from exc

        now = time.monotonic()
        ttl = min(_MAX_TICKET_TTL, expires - time.time())
        self.pending = {
            key: handoff for key, handoff in self.pending.items() if handoff.expires > now
        }
        if len(self.pending) >= _MAX_PENDING:
            raise BridgeAuthError("ASR_HANDOFF_BUSY", 429)
        self.pending[match[1]] = Handoff(_digest(ticket), now + ttl, session)
        return JSONResponse(body, status_code=201, headers={"cache-control": "no-store"})

    def claim(self, websocket: WebSocket, session_id: str) -> tuple[list[str], Any]:
        protocols = websocket.scope.get("subprotocols", [])
        if (
            websocket.scope.get("query_string")
            or len(protocols) != 2
            or protocols[0] != PROTOCOL
            or not protocols[1].startswith(TICKET_PREFIX)
        ):
            raise BridgeAuthError("ASR_TICKET_REQUIRED", 401)
        ticket = protocols[1][len(TICKET_PREFIX):]
        handoff = self.pending.get(session_id)
        if (
            handoff is None
            or handoff.expires <= time.monotonic()
            or not _TICKET.fullmatch(ticket)
            or not hmac.compare_digest(handoff.digest, _digest(ticket))
        ):
            raise BridgeAuthError("ASR_TICKET_INVALID", 401)
        self.pending.pop(session_id)
        return protocols, handoff.session

    async def proxy(self, websocket: WebSocket, record: ServiceRecord | None, assert_live, watch, ready) -> None:
        path = websocket.scope["path"]
        match = MEDIA_ASR_STREAM.fullmatch(path)
        if (
            record is None
            or not record.enabled
            or match is None
            or not record.allows("GET", path, websocket=True)
            or websocket.scope.get("raw_path", path.encode("ascii")) != path.encode("ascii")
        ):
            await websocket.close(code=4403)
            return

        close_code = 1000
        try:
            protocols, session = self.claim(websocket, match[1])
            await assert_live(session)
            await ready(record.service_id)
            await assert_live(session)
            target = record.upstream.replace("http://", "ws://", 1) + path
            async with connect(
                target,
                subprotocols=protocols,
                max_size=65536,
                max_queue=4,
                open_timeout=5,
                close_timeout=2,
                compression=None,
                proxy=None,
            ) as upstream:
                if upstream.subprotocol != PROTOCOL:
                    close_code = 1011
                    return
                await assert_live(session)
                await websocket.accept(subprotocol=PROTOCOL)

                async def incoming():
                    while True:
                        message = await websocket.receive()
                        if message["type"] == "websocket.disconnect":
                            return None
                        await assert_live(session)
                        payload = message.get("bytes")
                        if payload is None:
                            payload = message["text"]
                            if len(payload.encode("utf-8")) > _MAX_CONTROL_FRAME:
                                return 1009
                        elif len(payload) > _MAX_AUDIO_FRAME:
                            return 1009
                        await upstream.send(payload)

                async def outgoing():
                    async for message in upstream:
                        await assert_live(session)
                        if not isinstance(message, str):
                            return 1011
                        await websocket.send_text(message)
                    return upstream.close_code

                tasks = [
                    asyncio.create_task(incoming()),
                    asyncio.create_task(outgoing()),
                    asyncio.create_task(watch(session)),
                ]
                try:
                    done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
                    for task in done:
                        close_code = await task or close_code
                finally:
                    for task in tasks:
                        task.cancel()
                    await asyncio.gather(*tasks, return_exceptions=True)
        except BridgeAuthError as exc:
            close_code = 4401 if exc.status in {401, 403} else 1011
        except InvalidStatus as exc:
            close_code = 4401 if exc.response.status_code == 403 else 1011
        except ConnectionClosed as exc:
            close_code = exc.rcvd.code if exc.rcvd is not None else 1011
            if close_code not in {1000, 1001, 1008, 1009, 1011} and not 4000 <= close_code <= 4999:
                close_code = 1011
        except WebSocketDisconnect:
            return
        except (InvalidHandshake, OSError, TimeoutError):
            close_code = 1011
        finally:
            with contextlib.suppress(RuntimeError, WebSocketDisconnect):
                await websocket.close(code=close_code)
