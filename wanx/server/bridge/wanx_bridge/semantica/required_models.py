"""Private model listener using one-use broker attestations, never user bearers."""

from __future__ import annotations

import asyncio
import hashlib
import ipaddress
import json
import secrets
import time
from contextlib import suppress

import httpx
from centuarai_local_data_gate.client import BrokerClient
from centuarai_local_data_gate.protocol import (
    DataProtocolError,
    digest,
    encode,
    gateway_proof_digest,
    verify_gateway_model_lease,
    verify_gateway_model_request,
    verify_gateway_request,
)
from centuarai_local_data_gate.semantica_models import validate_model_body_binding

from .desktop import DesktopConfig, DesktopError, strict_json
from .desktop_routes import bounded_body, live_request


def encoded(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()


class RequiredModelRelay:
    def __init__(self, relay, config):
        if config.audience != "octop":
            raise ValueError("REQUIRED_MODEL_NATIVE_AUDIENCE_INVALID")
        self.relay, self.config = relay, config
        self.broker = BrokerClient(config)
        self.generation = secrets.token_urlsafe(32)
        self.closed = False
        self.tasks = set()

    async def close(self):
        self.closed = True
        pending = [task for task in tuple(self.tasks) if task is not asyncio.current_task()]
        for task in pending:
            task.cancel()
        await asyncio.gather(*pending, return_exceptions=True)
        await self.broker.close()

    def _proof(self, request):
        if request.headers.get("origin") is not None or any(
            name in request.headers
            for name in ("authorization", "cookie", "x-semantica-scope", "x-starklink-signature")
        ):
            raise DesktopError("MODEL_AUTH_REQUIRED", 403)
        if len(request.headers.getlist("x-centuarai-model-proof")) != 1:
            raise DesktopError("MODEL_AUTH_REQUIRED", 403)
        proof = request.headers["x-centuarai-model-proof"]
        claims = verify_gateway_model_request(
            proof, self.config.gateway_key, int(time.time() * 1000)
        )
        if (
            claims["gatewayId"] != self.config.gateway_id
            or claims["boxId"] != self.config.box_id
            or claims["boxKeyThumbprint"] != self.config.box_key_thumbprint
        ):
            raise DataProtocolError("LOCAL_DATA_CONTEXT_CHANGED")
        return proof, claims

    def _request(self, request, raw, verified=None):
        proof, claims = verified if verified is not None else self._proof(request)
        if int(time.time() * 1000) >= claims["expiresAtMs"]:
            raise DataProtocolError("LOCAL_DATA_SESSION_EXPIRED")
        validate_model_body_binding(claims, raw)
        body = strict_json(raw)
        if not isinstance(body, dict) or body.get("action") != claims["modelAction"]:
            raise DesktopError("MODEL_INVALID_REQUEST", 422)
        try:
            owner = json.loads(body["owner"])
        except (KeyError, TypeError, ValueError):
            raise DesktopError("MODEL_AUTH_REQUIRED", 403) from None
        ctx = claims["serviceContext"]
        if owner != [claims["boxId"], "semantica", ctx["principalNamespace"]]:
            raise DesktopError("MODEL_AUTH_REQUIRED", 403)
        if body.get("actor_id", ctx["principalNamespace"]) != ctx["principalNamespace"]:
            raise DesktopError("MODEL_AUTH_REQUIRED", 403)
        selected = ctx["warehouseId"] if ctx["warehouseId"] is not None else ctx["workspaceId"]
        if body.get("warehouse_id", selected) not in (selected, None):
            raise DesktopError("MODEL_AUTH_REQUIRED", 403)
        if claims["modelAction"] == "infer":
            snapshot = claims["modelSnapshot"]
            if (
                body.get("job_id") != claims["taskId"]
                or body.get("purpose") != snapshot["purpose"]
                or body.get("selection")
                != {"id": snapshot["modelId"], "revision": snapshot["modelRevision"]}
            ):
                raise DesktopError("MODEL_AUTH_REQUIRED", 403)
        return proof, claims, body

    def _accept(self, proof, body, original, *, lease_id=None):
        value = verify_gateway_model_lease(proof, self.config.gateway_key, int(time.time() * 1000))
        expected = {
            key: original[key]
            for key in (
                "schemaVersion",
                "boxId",
                "boxKeyThumbprint",
                "gatewayId",
                "gatewayGeneration",
                "sessionId",
                "operationId",
                "parentOperationId",
                "bindingId",
                "bindingRevision",
                "principalId",
                "principalSecurityVersion",
                "clientId",
                "ownershipEpoch",
                "applicationId",
                "launchId",
                "resourceId",
                "action",
                "requestId",
                "parentRequestId",
                "serviceContext",
                "taskId",
                "taskKind",
                "taskDigest",
                "modelSnapshot",
                "modelAction",
                "bodySha256",
                "bodyBytes",
                "nativeGateGeneration",
                "gateNonce",
            )
        }
        expected.update(
            relayGeneration=self.generation,
            relayNonce=body["relayNonce"],
            requestDigest=digest(body),
        )
        if lease_id is not None:
            expected["leaseId"] = lease_id
        if original["schemaVersion"] == 2:
            expected["teamDigest"] = original["teamDigest"]
        if any(value[key] != item for key, item in expected.items()):
            raise DataProtocolError("LOCAL_DATA_CONTEXT_CHANGED")
        if value["authorizationVersion"] < original["authorizationVersion"]:
            raise DataProtocolError("LOCAL_DATA_CONTEXT_CHANGED")
        if value["gatewayProofDigest"] != gateway_proof_digest(
            body.get("proof", self._original_proof(original))
        ):
            raise DataProtocolError("LOCAL_DATA_CONTEXT_CHANGED")
        return value

    @staticmethod
    def _original_proof(original):
        return original["_model_proof"]

    async def _lease(self, operation, body, original, *, lease_id=None):
        proof = await self.broker.call(operation, body)
        value = self._accept(proof, body, original, lease_id=lease_id)
        if value["state"] != ("closed" if operation == "model-close" else "active"):
            raise DataProtocolError("LOCAL_DATA_CONTEXT_CHANGED")
        return value

    async def _authorize(self, value, authorization, config):
        raw = encoded(authorization)
        if value["authorizationBodySha256"] != encode(hashlib.sha256(raw).digest()):
            raise DataProtocolError("LOCAL_DATA_BODY_MISMATCH")
        child = verify_gateway_request(
            value["authorizationProof"], self.config.gateway_key, int(time.time() * 1000)
        )
        if (
            child["parentOperationId"] != value["operationId"]
            or child["rawTarget"] != "/api/integration/processing/authorize"
            or child["method"] != "POST"
            or child["audience"] != "semantica"
            or child["bodySha256"] != value["authorizationBodySha256"]
            or child["bodyBytes"] != len(raw)
            or child["serviceContext"]
            != {**value["serviceContext"], "operation": "authorize_processing"}
            or any(
                child[key] != value[key]
                for key in (
                    "principalId",
                    "bindingId",
                    "clientId",
                    "ownershipEpoch",
                    "principalSecurityVersion",
                    "gatewayGeneration",
                    "boxId",
                    "boxKeyThumbprint",
                    "resourceId",
                    "action",
                )
            )
        ):
            raise DataProtocolError("LOCAL_DATA_CONTEXT_CHANGED")
        outgoing = httpx.Request(
            "POST",
            config.service_url + child["rawTarget"],
            content=raw,
            headers={
                "content-type": "application/json",
                "x-centuarai-gateway-proof": value["authorizationProof"],
            },
        )
        outgoing.extensions["timeout"] = {"connect": 2, "read": 10, "write": 10, "pool": 1}
        response = await self.relay.client.send(outgoing, stream=True)
        content = bytearray()
        try:
            async for chunk in response.aiter_bytes():
                content.extend(chunk)
                if len(content) > 65536:
                    raise DesktopError("MODEL_TASK_REVOKED", 403)
        finally:
            await response.aclose()
        try:
            authorized = strict_json(content)
        except (ValueError, UnicodeError):
            raise DesktopError("MODEL_TASK_REVOKED", 403) from None
        if (
            response.status_code != 200
            or not isinstance(authorized, dict)
            or authorized.get("authorized") is not True
        ):
            raise DesktopError("MODEL_TASK_REVOKED", 403)

    async def invoke(self, request):
        if self.closed:
            raise DesktopError("MODEL_AUTH_REQUIRED", 403)
        task = asyncio.current_task()
        self.tasks.add(task)
        try:
            return await self._invoke(request)
        finally:
            self.tasks.discard(task)

    async def _invoke(self, request):
        try:
            peer = ipaddress.ip_address(request.client.host if request.client else "")
            if not (
                peer.is_loopback
                or getattr(peer, "ipv4_mapped", None)
                and peer.ipv4_mapped.is_loopback
            ):
                raise DesktopError("MODEL_AUTH_REQUIRED", 403)
            verified = self._proof(request)
            async with asyncio.timeout(1):
                raw = await bounded_body(request, 512 * 1024)
            proof, claims, body = self._request(request, raw, verified)
            claims["_model_proof"] = proof
            action = claims["modelAction"]
            config = await asyncio.to_thread(
                DesktopConfig.load,
                self.relay.config_file,
                self.relay.service_url,
                self.relay.box_id,
            )
            items, _ = await self.relay._catalog()
            selection = None
            if action != "catalog":
                selected = body.get("selection")
                if not isinstance(selected, dict) or set(selected) != {"id", "revision"}:
                    raise DesktopError("MODEL_INVALID_REQUEST", 422)
                selection = next(
                    (item for item in items if item["id"] == selected["id"] and item["available"]),
                    None,
                )
                if selection is None:
                    raise DesktopError("MODEL_UNAVAILABLE", 409)
                if selection["revision"] != selected["revision"]:
                    raise DesktopError("MODEL_CONFIG_CHANGED", 409)
            authorization = None
            if action == "infer":
                snapshot = claims["modelSnapshot"]
                authorization = {
                    "operation_id": claims["requestId"],
                    "job_id": claims["taskId"],
                    "purpose": snapshot["purpose"],
                    "model_id": snapshot["modelId"],
                    "model_revision": snapshot["modelRevision"],
                    "task_digest": claims["taskDigest"],
                }
                if "inference_options" in body:
                    authorization["inference_options"] = body["inference_options"]
            admit = {
                "proof": proof,
                "bodySha256": claims["bodySha256"],
                "bodyBytes": len(raw),
                "relayGeneration": self.generation,
                "relayNonce": secrets.token_urlsafe(32),
            }
            if authorization is not None:
                admit["authorizationBody"] = authorization
            lease = await self._lease("model-admit", admit, claims)
            lease_id = lease["leaseId"]
            outcome = "denied"
            checks = asyncio.Lock()
            try:

                async def permitted():
                    # Share one check between work and watch; stalled private
                    # callbacks cannot leave external inference running.
                    async with asyncio.timeout(1.5), checks:
                        check = {
                            "leaseId": lease_id,
                            "relayGeneration": self.generation,
                            "relayNonce": secrets.token_urlsafe(32),
                        }
                        if authorization is not None:
                            check["authorizationBody"] = authorization
                        current = await self._lease("model-check", check, claims, lease_id=lease_id)
                        if action == "infer":
                            await self._authorize(current, authorization, config)
                        return current

                if action == "infer":
                    async with asyncio.timeout(1.5):
                        await self._authorize(lease, authorization, config)
                if action == "catalog":
                    result = await self.relay.catalog_result(items, fallback_active=True)
                    await permitted()
                    outcome = "completed"
                    return result
                if self.relay.pending >= 32:
                    raise DesktopError("MODEL_BUSY", 429)
                if action == "check":
                    text = '合成连通性测试，请返回 {"ok":true}。不含用户资料。'
                    schema = {
                        "type": "object",
                        "properties": {"ok": {"type": "boolean", "const": True}},
                        "required": ["ok"],
                        "additionalProperties": False,
                    }
                else:
                    text, schema = body.get("text"), body.get("schema")
                    if (
                        not isinstance(text, str)
                        or not isinstance(schema, dict)
                        or len(text.encode()) > 200000
                    ):
                        raise DesktopError("MODEL_INPUT_TOO_LARGE", 413)
                self.relay.pending += 1
                principal = claims["serviceContext"]["principalNamespace"]
                key = "local-data:" + principal
                limit, count = self.relay.users.get(key, (asyncio.Semaphore(2), 0))
                self.relay.users[key] = limit, count + 1

                async def work():
                    async with limit, self.relay.slots:
                        await permitted()
                        latest, providers = await self.relay._catalog()
                        if not any(
                            item["id"] == selection["id"]
                            and item["revision"] == selection["revision"]
                            and item["available"]
                            for item in latest
                        ):
                            raise DesktopError("MODEL_CONFIG_CHANGED", 409)
                        audit = {
                            "job_id": body.get("job_id"),
                            "purpose": body.get("purpose", "check"),
                            "principal_namespace": principal,
                            "application_id": claims["applicationId"],
                            **(
                                {"max_output_tokens": body["max_output_tokens"]}
                                if "max_output_tokens" in body
                                else {}
                            ),
                        }
                        try:
                            result = await self.relay._generate(
                                providers[selection["provider_id"]],
                                selection,
                                text,
                                schema,
                                audit,
                                ("local-data", principal),
                            )
                        except Exception as exc:
                            from .model_relay import _log_model_failure

                            # Only after the live lease and task have been authorized.
                            # Logging failure must not replace the original diagnostic.
                            with suppress(Exception):
                                _log_model_failure(exc, body.get("job_id"), claims["requestId"])
                            raise
                        await permitted()
                        return result

                async def watch():
                    while True:
                        await permitted()
                        await asyncio.sleep(0.5)

                drained = asyncio.Event()
                drained.set()
                try:
                    async with asyncio.timeout(320):
                        result = await live_request(request, work(), watch(), drained)
                    outcome = "completed"
                    return result
                finally:
                    self.relay.pending -= 1
                    remaining = self.relay.users[key][1] - 1
                    if remaining:
                        self.relay.users[key] = limit, remaining
                    else:
                        self.relay.users.pop(key, None)
            finally:
                close = {
                    "leaseId": lease_id,
                    "relayGeneration": self.generation,
                    "relayNonce": secrets.token_urlsafe(32),
                    "outcome": outcome,
                }
                # Physical close is acknowledged only after work/watch and all
                # provider I/O have drained through live_request's finalizer.
                await self._lease("model-close", close, claims, lease_id=lease_id)
        except DataProtocolError:
            raise DesktopError("MODEL_AUTH_REQUIRED", 403) from None
