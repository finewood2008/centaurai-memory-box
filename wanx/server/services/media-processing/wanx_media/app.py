"""HTTP entry point for a registered WANX Bridge service."""

from __future__ import annotations

from contextlib import asynccontextmanager
import hashlib
import ipaddress
import json
import os
from pathlib import Path
from typing import Annotated, Any

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from fastapi import FastAPI, Path as UrlPath, Query, Request, WebSocket
from fastapi.responses import JSONResponse
import jwt
from pydantic import BaseModel, ConfigDict, Field
from starlette.concurrency import run_in_threadpool

from . import summary_templates
from .media import (
    CAPABILITIES,
    SUMMARY_CAPABILITY,
    capability_info,
    configured,
    validate_options,
)
from .ota_runtime import MediaDrain, load_runtime_identity, local_models_configured
from .store import CHUNK, MAX_INPUT, RETENTION, Problem, Store
from .streaming import CAPABILITY as STREAMING_CAPABILITY, StreamingSessions
from .summary_engine import MAX_INPUT_BYTES as SUMMARY_MAX_BYTES
from .worker import Worker

SERVICE = "wanx.media"
PREFIX = "/api/services/" + SERVICE + "/v1"


INTERNAL = "/internal/media/v1"
ASR_SESSIONS = PREFIX + "/asr/sessions"
SUMMARY_TEMPLATES = PREFIX + "/summary-templates"
TEMPLATE_ID_PATTERN = rf"^(?:{summary_templates.BUILTIN_TEMPLATE_ID}|[a-f0-9]{{32}})$"
TemplateId = Annotated[str, Field(pattern=TEMPLATE_ID_PATTERN)]
TemplatePathId = Annotated[str, UrlPath(pattern=TEMPLATE_ID_PATTERN)]


class DelegationSpec(BaseModel):
    model_config = ConfigDict(extra="forbid")
    capabilities: list[str] = Field(min_length=1, max_length=5)
    ttlSeconds: int = Field(gt=0, le=7 * 86400, strict=True)


class JobSpec(BaseModel):
    model_config = ConfigDict(extra="forbid")
    requestId: str = Field(min_length=1, max_length=128)
    capability: str = Field(max_length=64)
    size: int = Field(gt=0, le=MAX_INPUT, strict=True)
    sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    options: dict[str, Any] = Field(default_factory=dict)


class SummarySpec(BaseModel):
    model_config = ConfigDict(extra="forbid")
    requestId: str = Field(min_length=1, max_length=128)
    text: str = Field(min_length=1, max_length=SUMMARY_MAX_BYTES)
    templateId: TemplateId | None = None


class TemplateSpec(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    name: str = Field(min_length=1, max_length=100)
    instructions: str = Field(min_length=1, max_length=4000)


class UpdateTemplateSpec(TemplateSpec):
    expectedRevision: int = Field(ge=1, strict=True)


class DefaultTemplateSpec(BaseModel):
    model_config = ConfigDict(extra="forbid")
    templateId: TemplateId | None


def create_app(directory: Path, key: Ed25519PublicKey, *, start_worker=True):
    runtime_identity = load_runtime_identity()
    drain = (
        MediaDrain(
            Path(os.environ["WANX_MEDIA_OTA_RUNTIME_FILE"]).with_name("drain"),
            (PREFIX + "/", INTERNAL + "/"),
        )
        if runtime_identity is not None else None
    )
    store = Store(directory)
    worker = Worker(store, pause_requested=drain.requested if drain else None)
    streams = StreamingSessions(store)
    local_models_ready = runtime_identity is None or local_models_configured(streams.model)
    fingerprint = hashlib.sha256(key.public_bytes_raw()).hexdigest()

    @asynccontextmanager
    async def lifespan(app):
        if start_worker:
            worker.start()
        try:
            yield
        finally:
            if start_worker:
                worker.close()

    app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None)
    app.state.store = store
    if drain is not None:
        app.add_middleware(drain.middleware)

        @app.get("/internal/ota/v1/drain")
        async def ota_drain_status(request: Request):
            try:
                local = request.client and ipaddress.ip_address(request.client.host).is_loopback
            except ValueError:
                local = False
            if not local:
                raise Problem("LOCAL_OTA_ONLY", 403)
            draining = drain.requested()
            return {"draining": draining, "idle": draining and drain.inflight == 0 and worker.idle()}

    @app.exception_handler(Problem)
    async def on_problem(request, exc):
        return JSONResponse(
            {"code": exc.code},
            status_code=exc.status,
            headers={"Retry-After": "30"} if exc.status == 429 else {},
        )

    @app.get("/healthz")
    def health():
        return {"healthy": True}

    @app.get("/readyz")
    def ready():
        return {"ready": local_models_ready and worker.thread.is_alive()}

    @app.get("/version")
    def version():
        return runtime_identity or {"version": "0.1.0", "protocolVersion": 1}

    def grant_for(db, request):
        if request.url.path.startswith(INTERNAL + "/"):
            try:
                trusted_peer = (
                    request.client
                    and ipaddress.ip_address(request.client.host).is_loopback
                )
            except ValueError:
                trusted_peer = False
            if not trusted_peer or any(
                h in request.headers
                for h in (
                    "forwarded",
                    "x-forwarded-for",
                    "via",
                    "authorization",
                    "x-media-grant",
                )
            ):
                raise Problem("LOCAL_DELEGATION_ONLY", 403)
            secret = request.headers.get("x-media-delegation", "")
            if not secret.startswith("media_worker_") or len(secret) > 256:
                raise Problem("LOCAL_DELEGATION_REQUIRED", 401)
            return store.authorize_delegate(db, secret)
        if "x-media-delegation" in request.headers:
            raise Problem("HOST_AUTH_REQUIRED", 401)
        value = request.headers.get("authorization", "")
        secret = request.headers.get("x-media-grant", "")
        if (
            not value.startswith("Bearer ")
            or len(value) > 32768
            or not 16 <= len(secret) <= 256
        ):
            raise Problem("MEDIA_AUTH_REQUIRED", 401)
        token = value[7:]
        try:
            if jwt.get_unverified_header(token).get("kid") != fingerprint:
                raise ValueError
            claims = jwt.decode(
                token,
                key,
                algorithms=["EdDSA"],
                issuer="wanx-bridge",
                audience="wanx-bridge",
                options={
                    "require": [
                        "iss",
                        "aud",
                        "iat",
                        "exp",
                        "jti",
                        "scope",
                        "boxId",
                        "userId",
                        "spaceId",
                        "protocolVersion",
                        "serviceId",
                    ]
                },
            )
            if (
                claims["serviceId"] != SERVICE
                or claims["aud"] != "wanx-bridge"
                or type(claims["protocolVersion"]) is not int
                or claims["protocolVersion"] != 1
                or not isinstance(claims["scope"], list)
                or not all(
                    isinstance(claims[k], str) and claims[k]
                    for k in ("boxId", "userId", "spaceId")
                )
            ):
                raise ValueError
        except (jwt.PyJWTError, ValueError, TypeError):
            raise Problem("INVALID_SERVICE_IDENTITY", 401) from None
        scope = "service:read" if request.method == "GET" else "service:write"
        if scope not in claims["scope"]:
            raise Problem("SCOPE_DENIED", 403)
        return store.authorize(db, claims, secret)

    @app.post(PREFIX + "/delegations")
    def issue_delegation(request: Request, spec: DelegationSpec):
        with store.db() as db:
            parent = grant_for(db, request)
            body = store.delegate(db, parent, spec.capabilities, spec.ttlSeconds)
            return JSONResponse(body, headers={"Cache-Control": "no-store"})

    @app.get(PREFIX + "/delegations")
    def list_delegations(request: Request):
        with store.db() as db:
            parent = grant_for(db, request)
            rows = db.execute(
                "SELECT * FROM grants WHERE parent_id=? AND revoked=0 AND expires>unixepoch()",
                (parent["id"],),
            )
            return {"delegations": [store.context(row) for row in rows]}

    @app.delete(PREFIX + "/delegations/{delegation_id}")
    def revoke_delegation(delegation_id: str, request: Request):
        with store.db() as db:
            parent = grant_for(db, request)
            if not db.execute(
                "UPDATE grants SET revoked=1 WHERE parent_id=? AND id=?",
                (parent["id"], delegation_id),
            ).rowcount:
                raise Problem("DELEGATION_NOT_FOUND", 404)
            store.sweep(db)
            return {"revoked": True}

    @app.get(INTERNAL + "/context")
    def delegated_context(request: Request):
        with store.db() as db:
            return store.context(grant_for(db, request))

    @app.delete(INTERNAL + "/delegation/self")
    @app.delete(PREFIX + "/grant/self")
    def revoke_self(request: Request):
        with store.db() as db:
            grant = grant_for(db, request)
            db.execute("UPDATE grants SET revoked=1 WHERE id=?", (grant["id"],))
            store.sweep(db)
            return {"revoked": True}

    @app.get(PREFIX + "/capabilities")
    @app.get(INTERNAL + "/capabilities")
    def discover(request: Request):
        with store.db() as db:
            grant = grant_for(db, request)
            return {
                "instance": grant["instance"],
                "grantExpiresAt": store.expires_at(grant),
                "maxInputBytes": MAX_INPUT,
                "chunkBytes": CHUNK,
                "resultTtlSeconds": RETENTION,
                "processingLocation": "box",
                "capabilities": [
                    streams.capability() if cap == STREAMING_CAPABILITY else capability_info(cap)
                    for cap in json.loads(grant["caps"])
                ],
            }

    def summary_grant(db, request):
        grant = grant_for(db, request)
        if SUMMARY_CAPABILITY not in json.loads(grant["caps"]):
            raise Problem("CAPABILITY_DENIED", 403)
        return grant

    @app.post(PREFIX + "/summaries", status_code=202)
    def create_summary(request: Request, spec: SummarySpec):
        with store.db() as db:
            grant = summary_grant(db, request)
            try:
                data = spec.text.encode("utf-8")
            except UnicodeEncodeError:
                raise Problem("SUMMARY_INVALID_INPUT", 422) from None
            if len(data) > SUMMARY_MAX_BYTES or not spec.text.strip():
                raise Problem("SUMMARY_INVALID_INPUT", 422)

            def snapshot():
                if not configured(SUMMARY_CAPABILITY):
                    raise Problem("SUMMARY_MODEL_UNAVAILABLE", 503)
                template = summary_templates.resolve_template(db, grant, spec.templateId)
                return {
                    "processingLocation": "cloud",
                    "template": {
                        "id": template["id"],
                        "revision": template["revision"],
                        "instructions": template["instructions"],
                    }
                }

            receipt = store.create(
                db,
                grant,
                spec.requestId,
                SUMMARY_CAPABILITY,
                len(data),
                hashlib.sha256(data).hexdigest(),
                {"templateId": spec.templateId},
                snapshot=snapshot,
            )
            if receipt["state"] != "uploading":
                return receipt
            job_id = receipt["id"]
            store.append(db, store.owned(db, grant, job_id), 0, data)
            store.submit(db, store.owned(db, grant, job_id))
            return store.receipt(store.owned(db, grant, job_id))

    @app.get(SUMMARY_TEMPLATES)
    def get_summary_templates(request: Request):
        with store.db() as db:
            return summary_templates.list_templates(db, summary_grant(db, request))

    @app.post(SUMMARY_TEMPLATES, status_code=201)
    def create_summary_template(request: Request, spec: TemplateSpec):
        with store.db() as db:
            return summary_templates.create_template(
                db, summary_grant(db, request), spec.name, spec.instructions
            )

    @app.get(SUMMARY_TEMPLATES + "/default")
    def get_default_summary_template(request: Request):
        with store.db() as db:
            return summary_templates.resolve_template(db, summary_grant(db, request), None)

    @app.put(SUMMARY_TEMPLATES + "/default")
    def set_default_summary_template(request: Request, spec: DefaultTemplateSpec):
        with store.db() as db:
            return summary_templates.set_default(
                db, summary_grant(db, request), spec.templateId
            )

    @app.get(SUMMARY_TEMPLATES + "/{template_id}")
    def get_summary_template(request: Request, template_id: TemplatePathId):
        with store.db() as db:
            return summary_templates.get_template(
                db, summary_grant(db, request), template_id
            )

    @app.put(SUMMARY_TEMPLATES + "/{template_id}")
    def update_summary_template(
        request: Request, template_id: TemplatePathId, spec: UpdateTemplateSpec
    ):
        with store.db() as db:
            return summary_templates.update_template(
                db,
                summary_grant(db, request),
                template_id,
                spec.name,
                spec.instructions,
                spec.expectedRevision,
            )

    @app.delete(SUMMARY_TEMPLATES + "/{template_id}")
    def delete_summary_template(
        request: Request,
        template_id: TemplatePathId,
        expectedRevision: Annotated[int, Query(ge=1)],
    ):
        with store.db() as db:
            summary_templates.delete_template(
                db, summary_grant(db, request), template_id, expectedRevision
            )
            return {"deleted": True}

    @app.post(ASR_SESSIONS, status_code=201)
    async def create_asr_session(request: Request):
        def authorized_grant():
            with store.db() as db:
                grant = grant_for(db, request)
                if STREAMING_CAPABILITY not in json.loads(grant["caps"]):
                    raise Problem("CAPABILITY_DENIED", 403)
                return grant["id"], store.expires_at(grant)

        grant_id, expires = await run_in_threadpool(authorized_grant)
        return JSONResponse(
            streams.issue(ASR_SESSIONS, grant_id, expires),
            status_code=201,
            headers={"Cache-Control": "no-store"},
        )

    @app.websocket(ASR_SESSIONS + "/{session}/stream")
    async def stream_asr(websocket: WebSocket, session: str):
        await streams.stream(websocket, session)

    @app.post(PREFIX + "/jobs")
    @app.post(INTERNAL + "/jobs")
    def create(request: Request, spec: JobSpec):
        with store.db() as db:
            grant = grant_for(db, request)
            if (
                spec.capability not in json.loads(grant["caps"])
                or spec.capability not in CAPABILITIES
            ):
                raise Problem("CAPABILITY_DENIED", 403)
            if spec.capability == SUMMARY_CAPABILITY:
                raise Problem("SUMMARY_ENDPOINT_REQUIRED", 422)
            try:
                validate_options(spec.capability, spec.options)
            except ValueError as exc:
                raise Problem(str(exc), 422) from None
            if spec.capability == "text.embedding" and spec.size > 1024:
                raise Problem("QUERY_SIZE_LIMIT", 413)
            if not configured(spec.capability):
                raise Problem("MODEL_UNAVAILABLE", 503)
            return store.create(
                db,
                grant,
                spec.requestId,
                spec.capability,
                spec.size,
                spec.sha256,
                spec.options,
            )

    @app.get(PREFIX + "/jobs/{job}")
    @app.get(INTERNAL + "/jobs/{job}")
    def status(job: str, request: Request):
        with store.db() as db:
            return store.receipt(store.owned(db, grant_for(db, request), job))

    @app.put(PREFIX + "/jobs/{job}/input")
    @app.put(INTERNAL + "/jobs/{job}/input")
    async def append(job: str, request: Request, offset: int = Query(ge=0)):
        with store.db() as db:
            store.owned(db, grant_for(db, request), job)
        data = bytearray()
        async for chunk in request.stream():
            if len(data) + len(chunk) > CHUNK:
                raise Problem("CHUNK_TOO_LARGE", 413)
            data.extend(chunk)
        with store.db() as db:
            row = store.owned(db, grant_for(db, request), job)
            return {"offset": store.append(db, row, offset, bytes(data))}

    def mutate(request, job, operation):
        with store.db() as db:
            grant = grant_for(db, request)
            row = store.owned(db, grant, job)
            operation(db, row)
            return store.receipt(store.owned(db, grant, job))

    @app.post(PREFIX + "/jobs/{job}/submit")
    @app.post(INTERNAL + "/jobs/{job}/submit")
    def submit(job: str, request: Request):
        return mutate(request, job, store.submit)

    @app.post(PREFIX + "/jobs/{job}/retry")
    @app.post(INTERNAL + "/jobs/{job}/retry")
    def retry(job: str, request: Request):
        return mutate(request, job, store.retry)

    @app.delete(PREFIX + "/jobs/{job}")
    @app.delete(INTERNAL + "/jobs/{job}")
    def cancel(job: str, request: Request):
        return mutate(request, job, store.cancel)

    @app.get(PREFIX + "/jobs/{job}/result")
    @app.get(INTERNAL + "/jobs/{job}/result")
    def result(job: str, request: Request):
        with store.db() as db:
            row = store.owned(db, grant_for(db, request), job)
            if row["state"] != "done":
                raise Problem("RESULT_NOT_READY", 409)
            return {
                "jobId": job,
                "capability": row["cap"],
                "inputSha256": row["digest"],
                "result": json.loads(row["result"]),
            }

    return app
