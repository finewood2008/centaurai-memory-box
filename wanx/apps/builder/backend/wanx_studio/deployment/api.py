"""Authenticated deployment transport; executor and recovery authority stay private."""
from __future__ import annotations

import json
import re

from fastapi import Depends, Request

from ..contracts import StudioError

BODY_LIMIT = 1024 * 1024
SAFE_INTEGER = 9007199254740991
TARGET_KEYS = {"organizationId", "boxId", "applicationId", "environment"}
ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}")
OPERATION_ID = re.compile(r"[a-f0-9]{32}")
INTEGER = re.compile(r"0|[1-9][0-9]*")


def _query(request, allowed=(), *, target=False, required=False):
    raw = request.scope.get("query_string", b"")
    if len(raw) > 4096 or b"%" in raw:
        raise StudioError("DEPLOYMENT_QUERY_INVALID", 422)
    result = {}
    for key, value in request.query_params.multi_items():
        if key not in allowed or key in result:
            raise StudioError("DEPLOYMENT_QUERY_INVALID", 422)
        if key in {"after", "limit"}:
            if not INTEGER.fullmatch(value) or len(value) > 16:
                raise StudioError("DEPLOYMENT_QUERY_INVALID", 422)
            value = int(value)
            if value > SAFE_INTEGER or (key == "limit" and not 1 <= value <= 100):
                raise StudioError("DEPLOYMENT_QUERY_INVALID", 422)
        elif key == "environment":
            if value not in {"dev", "prod"}:
                raise StudioError("DEPLOYMENT_QUERY_INVALID", 422)
        elif not ID.fullmatch(value):
            raise StudioError("DEPLOYMENT_QUERY_INVALID", 422)
        result[key] = value
    count = len(TARGET_KEYS.intersection(result))
    if target and (count != 4 if required else count not in {0, 4}):
        raise StudioError("DEPLOYMENT_QUERY_INVALID", 422)
    return result


def _operation_id(value):
    if not OPERATION_ID.fullmatch(value):
        raise StudioError("DEPLOYMENT_OPERATION_ID_INVALID", 422)
    return value


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Duplicate key")
        result[key] = value
    return result


def _invalid_constant(_value):
    raise ValueError("Non-JSON constant")


async def _body(request, *, empty=False):
    chunks, size = [], 0
    async for chunk in request.stream():
        size += len(chunk)
        if size > BODY_LIMIT:
            raise StudioError("DEPLOYMENT_BODY_TOO_LARGE", 413)
        chunks.append(chunk)
    raw = b"".join(chunks)
    if empty and not raw:
        return {}
    try:
        value = json.loads(raw.decode("utf-8"), object_pairs_hook=_unique_object,
                           parse_constant=_invalid_constant)
    except (ValueError, UnicodeError, RecursionError):
        raise StudioError("DEPLOYMENT_BODY_INVALID", 422) from None
    if not isinstance(value, dict) or (empty and value):
        raise StudioError("DEPLOYMENT_BODY_INVALID", 422)
    return value


def mount(router, svc, identity):
    def coordinator(owner):
        svc.authorize_management(owner)
        return svc.deployments

    @router.get("/deployment/capabilities")
    async def capabilities(request: Request, owner=Depends(identity)):
        deployment = coordinator(owner)
        _query(request)
        return deployment.capabilities()

    @router.post("/deployment/releases")
    async def release(request: Request, owner=Depends(identity)):
        deployment = coordinator(owner)
        _query(request)
        return await deployment.register_release(owner, await _body(request))

    @router.post("/deployment/operations", status_code=202)
    async def submit(request: Request, owner=Depends(identity)):
        deployment = coordinator(owner)
        _query(request)
        return await deployment.submit(owner, await _body(request))

    @router.get("/deployment/operations")
    async def operations(request: Request, owner=Depends(identity)):
        deployment = coordinator(owner)
        query = _query(request, TARGET_KEYS | {"limit"}, target=True)
        target = {key: query[key] for key in TARGET_KEYS} if TARGET_KEYS.issubset(query) else None
        return {"items": deployment.operations(owner, target, query.get("limit", 50))}

    @router.get("/deployment/environments")
    async def environment(request: Request, owner=Depends(identity)):
        deployment = coordinator(owner)
        target = _query(request, TARGET_KEYS, target=True, required=True)
        return await deployment.environment(owner, target)

    @router.get("/deployment/operations/{operation_id}")
    async def operation(operation_id: str, request: Request, owner=Depends(identity)):
        deployment = coordinator(owner)
        _query(request)
        return deployment.operation(owner, _operation_id(operation_id))

    @router.get("/deployment/operations/{operation_id}/events")
    async def events(operation_id: str, request: Request, owner=Depends(identity)):
        deployment = coordinator(owner)
        query = _query(request, {"after", "limit"})
        return deployment.journal.events(owner, _operation_id(operation_id),
                                         query.get("after", 0), query.get("limit", 100))

    @router.get("/deployment/operations/{operation_id}/receipt")
    async def receipt(operation_id: str, request: Request, owner=Depends(identity)):
        deployment = coordinator(owner)
        _query(request)
        return deployment.journal.receipt(owner, _operation_id(operation_id))

    @router.post("/deployment/operations/{operation_id}/resume", status_code=202)
    async def resume(operation_id: str, request: Request, owner=Depends(identity)):
        deployment = coordinator(owner)
        _query(request)
        operation_id = _operation_id(operation_id)
        await _body(request, empty=True)
        return await deployment.resume(owner, operation_id)

    @router.post("/deployment/operations/{operation_id}/receipt/retry")
    async def retry_receipt(operation_id: str, request: Request, owner=Depends(identity)):
        deployment = coordinator(owner)
        _query(request)
        operation_id = _operation_id(operation_id)
        await _body(request, empty=True)
        deployment.journal.retry_delivery(owner, operation_id, deployment.clock())
        # Receipt delivery has no path to submit, resume or execute a deployment.
        await deployment.deliver_pending(owner=owner, operation_id=operation_id)
        return deployment.journal.receipt(owner, operation_id)
