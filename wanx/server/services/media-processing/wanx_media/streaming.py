"""Ephemeral streaming ASR sessions scoped to an interactive media grant."""

from __future__ import annotations

import asyncio
from contextlib import suppress
from dataclasses import dataclass
import hashlib
import hmac
import json
import re
import secrets
import time
import uuid

from fastapi import WebSocket, WebSocketDisconnect
from starlette.concurrency import run_in_threadpool

from .store import Problem, Store
from .stream_model import StreamingModel

CAPABILITY = "audio.transcribe.streaming"
PROTOCOL = "wanx.asr.v1"
TICKET_PREFIX = "wanx.asr.ticket."
TICKET_TTL = 30
IDLE_TIMEOUT = 15
MAX_DURATION = 3600
AUTH_INTERVAL = 1
MAX_PENDING = 16
MAX_FRAME = 6400
BYTES_PER_SECOND = 32000
AUDIO = {"encoding": "pcm_s16le", "sampleRate": 16000, "channels": 1}
TICKET = re.compile(r"[A-Za-z0-9_-]{43}")


@dataclass(frozen=True)
class Pending:
    grant_id: str
    digest: bytes
    expires: float


class StreamingSessions:
    def __init__(self, store: Store):
        self.store = store
        self.model = StreamingModel()
        self.pending: dict[str, Pending] = {}
        self.active = False

    def capability(self):
        ready = self.model.configured()
        return {
            "id": CAPABILITY,
            "configured": ready,
            "state": "configured" if ready else "unavailable",
            "transport": "websocket",
            "audio": AUDIO,
            "maxFrameBytes": MAX_FRAME,
            "maxDurationSeconds": MAX_DURATION,
        }

    def issue(self, root: str, grant_id: str, grant_expiry: float | None):
        if not self.model.configured():
            raise Problem("MODEL_UNAVAILABLE", 503)
        now = time.time()
        self.pending = {key: value for key, value in self.pending.items() if value.expires > now}
        if self.active or len(self.pending) >= MAX_PENDING:
            raise Problem("STREAM_BUSY", 429)
        if grant_expiry is not None and grant_expiry <= now:
            raise Problem("GRANT_REQUIRED", 403)
        sid = uuid.uuid4().hex
        ticket = secrets.token_urlsafe(32)
        expires = now + TICKET_TTL
        if grant_expiry is not None:
            expires = min(expires, grant_expiry)
        self.pending[sid] = Pending(grant_id, hashlib.sha256(ticket.encode()).digest(), expires)
        return {
            "id": sid,
            "streamPath": f"{root}/{sid}/stream",
            "ticket": ticket,
            "ticketExpiresAt": expires,
            "audio": AUDIO,
            "maxFrameBytes": MAX_FRAME,
            "idleTimeoutSeconds": IDLE_TIMEOUT,
            "maxDurationSeconds": MAX_DURATION,
        }

    def claim(self, websocket: WebSocket, sid: str):
        protocols = websocket.scope["subprotocols"]
        if (
            websocket.query_params
            or len(protocols) != 2
            or protocols[0] != PROTOCOL
            or not protocols[1].startswith(TICKET_PREFIX)
        ):
            return None
        ticket = protocols[1][len(TICKET_PREFIX):]
        pending = self.pending.get(sid)
        if (
            not pending
            or pending.expires <= time.time()
            or not TICKET.fullmatch(ticket)
            or not hmac.compare_digest(pending.digest, hashlib.sha256(ticket.encode()).digest())
        ):
            return None
        if self.active:
            return None
        self.pending.pop(sid)
        self.active = True
        return pending.grant_id

    async def require_grant(self, grant_id: str):
        def live():
            with self.store.db() as db:
                row = db.execute(
                    "SELECT caps FROM grants WHERE id=? AND parent_id IS NULL "
                    "AND revoked=0 AND (until_revoked=1 OR expires>?)",
                    (grant_id, time.time()),
                ).fetchone()
                return row is not None and CAPABILITY in json.loads(row["caps"])

        if not await run_in_threadpool(live):
            raise Problem("STREAM_GRANT_REVOKED", 403)

    async def stream(self, websocket: WebSocket, sid: str):
        grant_id = self.claim(websocket, sid)
        if grant_id is None:
            await websocket.close(code=4403)
            return
        accepted = False
        try:
            await self.require_grant(grant_id)
            await websocket.accept(subprotocol=PROTOCOL)
            accepted = True
            try:
                recognizer = await run_in_threadpool(self.model.open)
            except Exception:
                raise Problem("MODEL_UNAVAILABLE", 503) from None
            await self.require_grant(grant_id)
            await websocket.send_json({"type": "ready"})
            await self.receive_audio(websocket, grant_id, recognizer)
        except (WebSocketDisconnect, OSError):
            pass
        except Problem as exc:
            code = {403: 4403, 413: 1009, 503: 1011}.get(exc.status, 1008)
            with suppress(WebSocketDisconnect, OSError):
                if accepted:
                    await websocket.send_json({"type": "error", "code": exc.code})
                await websocket.close(code=code)
        finally:
            self.active = False

    async def receive_audio(self, websocket, grant_id, recognizer):
        loop = asyncio.get_running_loop()
        start = last_audio = last_auth = loop.time()
        received = 0
        max_burst = 2 * BYTES_PER_SECOND
        budget = max_burst
        while True:
            now = loop.time()
            if now - last_auth >= AUTH_INTERVAL:
                await self.require_grant(grant_id)
                last_auth = now
            if now - last_audio >= IDLE_TIMEOUT:
                raise Problem("STREAM_IDLE_TIMEOUT")
            if now - start >= MAX_DURATION:
                raise Problem("STREAM_DURATION_LIMIT")
            try:
                message = await asyncio.wait_for(websocket.receive(), timeout=AUTH_INTERVAL)
            except TimeoutError:
                continue
            if message["type"] == "websocket.disconnect":
                return
            pcm = message.get("bytes")
            if pcm is None:
                try:
                    control = json.loads(message["text"]) if len(message["text"]) <= 64 else None
                except (TypeError, ValueError):
                    control = None
                if control != {"type": "end"}:
                    raise Problem("INVALID_STREAM_MESSAGE")
                await self.publish(websocket, grant_id, recognizer.finish)
                await self.require_grant(grant_id)
                await websocket.send_json(
                    {"type": "end", "durationMs": received * 1000 // BYTES_PER_SECOND}
                )
                await websocket.close(code=1000)
                return
            if not pcm or len(pcm) % 2:
                raise Problem("INVALID_AUDIO_FRAME")
            if len(pcm) > MAX_FRAME:
                raise Problem("AUDIO_FRAME_TOO_LARGE", 413)
            received += len(pcm)
            if received > MAX_DURATION * BYTES_PER_SECOND:
                raise Problem("STREAM_DURATION_LIMIT")
            # Refill at capture speed, retaining at most two seconds of credit.
            received_at = loop.time()
            budget = min(max_burst, budget + (received_at - last_audio) * BYTES_PER_SECOND)
            if len(pcm) > budget:
                raise Problem("AUDIO_RATE_LIMIT", 429)
            budget -= len(pcm)
            last_audio = received_at
            await self.publish(websocket, grant_id, recognizer.accept, pcm)

    async def publish(self, websocket, grant_id, operation, *args):
        try:
            events = await run_in_threadpool(operation, *args)
        except Exception:
            raise Problem("STREAM_INFERENCE_FAILED", 503) from None
        if events:
            await self.require_grant(grant_id)
            for event in events:
                await websocket.send_json(event)
