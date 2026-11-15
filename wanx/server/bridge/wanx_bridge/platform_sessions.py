"""Durable account bindings and one writer lease shared by humans and tasks."""
from __future__ import annotations

import asyncio
import json
import os
import secrets
import time
from pathlib import Path
from urllib.parse import urlsplit

from .config import BridgeAuthError

ACTIONS = {'describe', 'open', 'state', 'frame', 'tabs', 'claim', 'input', 'release', 'stop'}
STORAGE_ACTIONS = {'import', 'export', 'ack'}
AUTOMATION_ACTIONS = {'acquire', 'attach', 'heartbeat', 'release', 'state'}


def validate_storage(value):
    def invalid():
        return BridgeAuthError('PLATFORM_STORAGE_INVALID', 400)
    if not isinstance(value, dict) or set(value) != {'cookies', 'origins'}:
        raise invalid()
    if len(json.dumps(value).encode()) > 2 * 1024 * 1024:
        raise invalid()
    if not isinstance(value['cookies'], list) or not isinstance(value['origins'], list) or len(value['cookies']) > 2048 or len(value['origins']) > 128:
        raise invalid()
    for cookie in value['cookies']:
        if not isinstance(cookie, dict) or set(cookie) - {'name', 'value', 'domain', 'path', 'expires', 'httpOnly', 'secure', 'sameSite', 'partitionKey'}:
            raise invalid()
        if not all(isinstance(cookie.get(k), str) for k in ('name', 'value', 'domain', 'path')):
            raise invalid()
        if not isinstance(cookie.get('expires'), (int, float)) or type(cookie.get('httpOnly')) is not bool or type(cookie.get('secure')) is not bool or cookie.get('sameSite') not in {'Strict', 'Lax', 'None'}:
            raise invalid()
    for origin in value['origins']:
        if not isinstance(origin, dict) or set(origin) != {'origin', 'localStorage'} or not isinstance(origin['origin'], str):
            raise invalid()
        parsed = urlsplit(origin['origin'])
        if parsed.scheme not in {'http', 'https'} or not parsed.hostname or parsed.username or parsed.password or parsed.path not in {'', '/'} or parsed.query or parsed.fragment:
            raise invalid()
        if not isinstance(origin['localStorage'], list) or len(origin['localStorage']) > 2048:
            raise invalid()
        for item in origin['localStorage']:
            if not isinstance(item, dict) or set(item) != {'name', 'value'} or not all(isinstance(v, str) for v in item.values()):
                raise invalid()
    return value


class PlatformSessions:
    def __init__(self, root: Path, runtime, *, clock=time.monotonic):
        self.root = Path(root)
        self.runtime = runtime
        self.clock = clock
        self.lock = asyncio.Lock()
        self.records = {}
        self.leases = {}
        self.tickets = {}
        self.connections = {}
        for path in self.root.glob('*.json'):
            record = json.loads(path.read_text())
            if record['mode'] in {'control', 'automation', 'recovering'} or (record['mode'] in {'syncing', 'sync_failed'} and not record.get('pending')):
                record['mode'] = 'recovering'
                record['needsReview'] = True
            self.records[record['sessionId']] = record
            self._save(record)

    def _save(self, record):
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        path = self.root / (record['sessionId'] + '.json')
        temporary = path.with_suffix('.tmp')
        with temporary.open('w') as file:
            os.chmod(temporary, 0o600)
            json.dump(record, file)
            file.flush()
            os.fsync(file.fileno())
        os.replace(temporary, path)
        fd = os.open(self.root, os.O_RDONLY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)

    def _owner(self, claims):
        fields = ('boxId', 'ownershipEpoch', 'serviceId', 'userId', 'spaceId')
        if any(claims.get(k) is None for k in ('boxId', 'ownershipEpoch', 'serviceId', 'userId')):
            raise BridgeAuthError('PLATFORM_IDENTITY_REQUIRED', 403)
        return [claims.get(k) for k in fields]

    def _state(self, r):
        lease = self.leases.get(r['sessionId'])
        return {k: r[k] for k in ('sessionId', 'mode', 'epoch', 'revision', 'needsReview')} | dict(
            controlId=lease['controlId'] if lease else None,
            expiresAt=time.time() + max(0, lease['expires'] - self.clock()) if lease else None,
            serverTime=time.time(), width=1280, height=800, sessionEpoch=r['epoch'])

    async def _revoke(self, r, abnormal=False):
        sid = r['sessionId']
        self.leases.pop(sid, None)
        await asyncio.gather(*(connection.close(code=4401) for connection in list(self.connections.get(sid, ()))), return_exceptions=True)
        if abnormal:
            r['mode'] = 'recovering'
            r['needsReview'] = True
            self._save(r)
            await self.runtime.close(sid)
        else:
            r['mode'] = 'syncing'
        self._save(r)

    async def expire(self):
        async with self.lock:
            for sid, lease in list(self.leases.items()):
                valid = lease.get('validate')
                try:
                    if valid:
                        valid()
                    authorized = True
                except Exception:
                    authorized = False
                if lease['expires'] <= self.clock() or not authorized:
                    await self._revoke(self.records[sid], abnormal=lease['kind'] == 'automation')

    def _lease(self, r, body, kind=None):
        lease = self.leases.get(r['sessionId'])
        if not lease or not secrets.compare_digest(str(body.get('lease', '')), lease['secret']) or body.get('epoch') != r['epoch'] or (kind and lease['kind'] != kind):
            raise BridgeAuthError('PLATFORM_LEASE_INVALID', 409)
        if lease['kind'] == 'automation' and (body.get('taskId'), body.get('attemptId')) != (lease['taskId'], lease['attemptId']):
            raise BridgeAuthError('PLATFORM_TASK_MISMATCH', 403)
        return lease

    async def dispatch(self, claims, action, body, *, group='platform', validate=None):
        await self.expire()
        owner = self._owner(claims)
        if not isinstance(body, dict):
            raise BridgeAuthError('PLATFORM_REQUEST_INVALID', 400)
        allowed = ACTIONS if group == 'platform' else STORAGE_ACTIONS if group == 'storage' else AUTOMATION_ACTIONS
        if action not in allowed:
            raise BridgeAuthError('PLATFORM_ACTION_INVALID', 400)
        async with self.lock:
            if action == 'describe':
                ready = await self.runtime.probe() if hasattr(self.runtime, "probe") else self.runtime.ready()
                return dict(version=1, available=True, runtimeReady=ready, reason=None if ready else 'PLATFORM_RUNTIME_MISSING')
            if action == 'open':
                binding = body.get('accountBindingId')
                if not isinstance(binding, str) or not 8 <= len(binding) <= 128 or type(body.get('accountId')) is not int or body['accountId'] < 1 or body.get('platform') != 'tencent':
                    raise BridgeAuthError('PLATFORM_ACCOUNT_INVALID', 400)
                r = next((r for r in self.records.values() if r['owner'] == owner and r['binding'] == binding), None)
                if r is None:
                    sid = secrets.token_urlsafe(24)
                    r = dict(sessionId=sid, owner=owner, binding=binding, accountId=body['accountId'], mode='readonly', epoch=0, revision=0, needsReview=False, pending=None, acknowledged=None, storageState=None)
                    self.records[sid] = r
                    self._save(r)
                if r['accountId'] != body['accountId']:
                    raise BridgeAuthError('PLATFORM_ACCOUNT_MISMATCH', 403)
                if r['mode'] == 'recovering':
                    return self._state(r)
                await self.runtime.open(r['sessionId'], r['storageState'])
                if r['mode'] == 'stopped':
                    r['mode'] = 'readonly'
                    self._save(r)
                return self._state(r)
            r = self.records.get(body.get('sessionId'))
            if r is None or r['owner'] != owner:
                raise BridgeAuthError('PLATFORM_SESSION_NOT_FOUND', 404)
            sid = r['sessionId']
            if group == 'automation' and action != 'state' and (not claims.get('taskId') or claims['taskId'] != body.get('taskId')):
                raise BridgeAuthError('PLATFORM_TASK_MISMATCH', 403)
            if action == 'state':
                return self._state(r)
            if action in {'frame', 'tabs'}:
                if r['mode'] in {'stopped', 'recovering'}:
                    raise BridgeAuthError('PLATFORM_SESSION_STOPPED', 409)
                await self.runtime.open(sid, r['storageState'])
                result = self._state(r) | dict(tabs=await self.runtime.tabs(sid))
                if action == 'frame':
                    result.update(image=await self.runtime.frame(sid), captureId=secrets.token_urlsafe(12), capturedAt=time.time())
                return result
            if action in {'claim', 'acquire'}:
                request_id = body.get('requestId')
                if not isinstance(request_id, str) or not 1 <= len(request_id) <= 128:
                    raise BridgeAuthError('PLATFORM_REQUEST_ID_REQUIRED', 400)
                kind = 'automation' if action == 'acquire' else 'control'
                old = self.leases.get(sid)
                if old and old['requestId'] == request_id and old['kind'] == kind:
                    return self._state(r) | dict(lease=old['secret'])
                if r['mode'] != 'readonly':
                    raise BridgeAuthError('PLATFORM_SESSION_BUSY', 409)
                if kind == 'automation' and (not body.get('taskId') or not body.get('attemptId') or claims.get('taskId') != body['taskId']):
                    raise BridgeAuthError('PLATFORM_TASK_MISMATCH', 403)
                await self.runtime.open(sid, r['storageState'])
                r['epoch'] += 1
                r['mode'] = kind
                self.leases[sid] = dict(kind=kind, requestId=request_id, secret=secrets.token_urlsafe(32), controlId=secrets.token_urlsafe(16), expires=self.clock()+60, maximum=self.clock()+(3600 if kind == 'automation' else 600), sequence=-1, validate=validate, taskId=body.get('taskId'), attemptId=body.get('attemptId'))
                self._save(r)
                return self._state(r) | dict(lease=self.leases[sid]['secret'])
            if action == 'input':
                lease = self._lease(r, body, 'control')
                sequence = body.get('sequence')
                if type(sequence) is not int or sequence < 0 or not isinstance(body.get('event'), dict):
                    raise BridgeAuthError('PLATFORM_INPUT_INVALID', 400)
                if sequence > lease['sequence']:
                    # Record before execution: uncertain clicks are never replayed.
                    lease['sequence'] = sequence
                    await self.runtime.input(sid, body['event'])
                lease['validate'] = validate
                lease['expires'] = min(self.clock()+60, lease['maximum'])
                return self._state(r) | dict(sequence=lease['sequence'])
            if action == 'heartbeat':
                lease = self._lease(r, body, 'automation')
                lease['validate'] = validate
                lease['expires'] = min(self.clock()+60, lease['maximum'])
                return self._state(r)
            if action == 'attach':
                lease = self._lease(r, body, 'automation')
                self.tickets = {key: value for key, value in self.tickets.items() if value['expires'] > self.clock()}
                ticket = secrets.token_urlsafe(32)
                self.tickets[ticket] = dict(sessionId=sid, epoch=r['epoch'], expires=self.clock()+15, validate=validate or lease['validate'])
                return dict(attachPath='/api/bridge/platform-browser/attach', ticket=ticket)
            if action == 'release':
                if r['mode'] in {'syncing', 'sync_failed', 'readonly'} and body.get('epoch') == r['epoch']:
                    return self._state(r)
                self._lease(r, body, 'automation' if group == 'automation' else 'control')
                await self._revoke(r, abnormal=group == "automation" and body.get("completed") is False)
                return self._state(r)
            if action == 'import':
                if r['mode'] not in {'readonly', 'stopped', 'sync_failed', 'recovering'} or body.get('expectedRevision') != r['revision']:
                    raise BridgeAuthError('PLATFORM_REVISION_CONFLICT', 409)
                state = validate_storage(body.get('storageState'))
                await self.runtime.close(sid)
                # The runtime rebuilds its context from this authoritative snapshot.
                r.update(storageState=state, mode='readonly', pending=None, needsReview=False)
                r['revision'] += 1
                self._save(r)
                await self.runtime.open(sid, state)
                return self._state(r)
            if action == 'export':
                if r['pending']:
                    return r['pending']
                if r['mode'] not in {'syncing', 'sync_failed', 'readonly'}:
                    raise BridgeAuthError('PLATFORM_SESSION_BUSY', 409)
                if body.get('expectedRevision', r['revision']) != r['revision']:
                    raise BridgeAuthError('PLATFORM_REVISION_CONFLICT', 409)
                r['mode'] = 'syncing'
                self._save(r)
                try:
                    state = validate_storage(await self.runtime.storage(sid))
                    r['revision'] += 1
                    r['pending'] = dict(storageState=state, syncId=secrets.token_urlsafe(24), revision=r['revision'])
                except Exception:
                    r['mode'] = 'sync_failed'
                    self._save(r)
                    raise
                self._save(r)
                return r['pending']
            if action == 'ack':
                identity = dict(syncId=body.get('syncId'), revision=body.get('revision'))
                if r['acknowledged'] == identity:
                    return self._state(r)
                pending = r['pending']
                if not pending or any(pending[k] != v for k, v in identity.items()):
                    raise BridgeAuthError('PLATFORM_SYNC_MISMATCH', 409)
                if body.get('success') is False:
                    r['mode'] = 'sync_failed'
                else:
                    r.update(storageState=pending['storageState'], pending=None, acknowledged=identity, mode='readonly')
                self._save(r)
                return self._state(r)
            if action == 'stop':
                if r['mode'] not in {'readonly', 'stopped'}:
                    raise BridgeAuthError('PLATFORM_SESSION_BUSY', 409)
                await self.runtime.close(sid)
                r['mode'] = 'stopped'
                self._save(r)
                return self._state(r)

    async def consume_ticket(self, ticket):
        await self.expire()
        async with self.lock:
            value = self.tickets.pop(ticket, None)
            if not value or value['expires'] <= self.clock():
                raise BridgeAuthError('PLATFORM_ATTACH_INVALID', 403)
            r = self.records[value['sessionId']]
            if r['mode'] != 'automation' or r['epoch'] != value['epoch']:
                raise BridgeAuthError('PLATFORM_ATTACH_INVALID', 403)
            if value['validate']:
                value['validate']()
            return value, self.runtime.endpoint(r['sessionId'])

    async def register_connection(self, value, websocket):
        # Endpoint connection is an await boundary: release may have occurred
        # after ticket consumption. Admission and lease revocation share a lock.
        async with self.lock:
            r = self.records[value['sessionId']]
            lease = self.leases.get(r['sessionId'])
            if not lease or lease['expires'] <= self.clock() or r['mode'] != 'automation' or r['epoch'] != value['epoch']:
                raise BridgeAuthError('PLATFORM_ATTACH_INVALID', 403)
            if lease['validate']:
                lease['validate']()
            await websocket.accept()
            self.connections.setdefault(r['sessionId'], set()).add(websocket)

    async def disconnected(self, value):
        async with self.lock:
            r = self.records[value['sessionId']]
            if r['mode'] == 'automation' and r['epoch'] == value['epoch']:
                await self._revoke(r, abnormal=True)
