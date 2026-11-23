"""Broker-owned Semantica jobs and one-use private model request capabilities.

Only the broker's kernel-authenticated Semantica peer may create a task or a
model request. The native WANX model listener consumes that request separately;
neither a persisted task proof nor an HTTP header grants fresh authority.
"""

from __future__ import annotations

import copy
import hashlib
import json
import secrets

from ..local_data_protocol import (
    digest,
    digest32,
    encode,
    fields,
    gateway_proof_digest,
    need,
    token,
)

TASK_ROUTES = {
    "parse": {"upload_document", "commit_import"},
    "dialogue": {"send_conversation_message", "analyze_material", "retry_conversation_turn"},
    "change": {"generate_material_change", "generate_modeling_suggestions"},
    "extraction": {
        "confirm_material_extraction",
        "retry_material_extraction",
        "reextract_document",
        "execute_modeling_rules",
        "retry_modeling_rule_execution",
        "start_material_processing",
        "confirm_material_processing",
        "retry_workbench_job",
    },
    "publication": {"submit_correction_draft", "retry_correction_publication", "retry_workbench_job"},
    "retraction": {"correct_document", "retry_workbench_job", "retry_job"},
    "index": {"build_index", "confirm_material_source", "retry_material_source_index", "start_material_processing", "retry_workbench_job"},
    "sensitive": {
        "preview_sensitive",
        "save_sensitive_settings",
        "retry_job",
        "retry_workbench_job",
        "search_knowledge",
        "search_workspaces",
        "get_evidence",
        "get_document",
        "get_document_text",
        "get_document_blob",
        "get_graph",
        "owner_graph",
    },
}
CATALOG_ROUTES = set().union(*TASK_ROUTES.values()) | {
    "workbench_status",
    "get_sensitive_settings",
    "read_processing",
    "model_catalog",
    "save_processing",
    "check_processing",
    "plan_material_extraction",
    "get_modeling_suggestion_context",
    "get_onboarding",
    "save_onboarding",
    "create_onboarding_warehouse",
    "get_material_intent",
    "prepare_material_goal",
    "get_material_change_context",
    "get_status",
    "get_capabilities",
    "create_material_intent",
}
NATIVE = {"operationId", "nativeGateGeneration", "gateNonce"}


def _copy(value):
    return copy.deepcopy(value)


def _id():
    return secrets.token_urlsafe(32)


class SemanticaModelAuthority:
    def __init__(self, sessions):
        self.sessions = sessions
        self.requests = {}
        self.leases = {}

    def _task(self, operation):
        return operation["constraints"].get("semanticaTask")

    def _source(self, operation, body, audience, now, mono):
        s = self.sessions
        need(audience == "semantica", "LOCAL_DATA_FORBIDDEN")
        s._native_match(operation, body, audience, now, mono)
        need(
            operation["nativeState"] == "active"
            and operation["parentOperationId"] is None
            and operation["route"]["serviceContext"].get("kind") == "warehouse",
            "LOCAL_DATA_SCOPE_DENIED",
        )

    def _task_payload(self, operation, body, state, now, mono):
        s = self.sessions
        task = self._task(operation)
        need(task is not None, "LOCAL_DATA_SCOPE_DENIED")
        return {
            **s._lease_payload(operation, body, state, now, mono),
            "purpose": "centuarai.local-data.gateway-semantica-task",
            "boxId": s.box_id,
            "boxKeyThumbprint": s.box_key_thumbprint,
            **_copy(task),
        }

    async def _sign_task(self, payload):
        s = self.sessions
        need(s.gateway_semantica_task_signer is not None, "LOCAL_DATA_UNAVAILABLE")
        signed = s.gateway_semantica_task_signer(payload)
        if payload["state"] != "closed":
            now, mono = s._now()
            async with s._lock:
                s._op_live(s._operations.get(payload["operationId"]), now, mono)
                need(now < payload["expiresAtMs"], "LOCAL_DATA_SESSION_EXPIRED")
        return signed

    async def task_start(self, body, *, audience):
        from centuarai_local_data_gate.semantica_models import (
            validate_model_snapshot,
            validate_task_transition,
        )

        fields(body, NATIVE | {"taskId", "taskKind", "taskDigest", "modelSnapshot"})
        token(body["taskId"])
        digest32(body["taskDigest"])
        need(
            type(body["taskKind"]) is str and body["taskKind"] in TASK_ROUTES,
            "LOCAL_DATA_SCOPE_DENIED",
        )
        validate_model_snapshot(body["modelSnapshot"], task_kind=body["taskKind"])
        s = self.sessions
        await s.assert_live(body["operationId"], minimum_cache_ms=750)
        now, mono = s._now()
        async with s._lock:
            parent = s._operations.get(body["operationId"])
            self._source(parent, body, audience, now, mono)
            ancestor = self._task(parent)
            depth = parent["constraints"].get("semanticaTaskDepth", 0)
            if ancestor is None:
                need(
                    parent["route"]["serviceContext"]["operation"] in TASK_ROUTES[body["taskKind"]],
                    "LOCAL_DATA_SCOPE_DENIED",
                )
            else:
                if ancestor["taskKind"] == "extraction" and body["taskKind"] == "publication":
                    need(parent["route"]["serviceContext"]["operation"] in {
                        "start_material_processing", "confirm_material_processing", "retry_workbench_job",
                    }, "LOCAL_DATA_SCOPE_DENIED")
                validate_task_transition(ancestor["taskKind"], body["taskKind"], depth + 1)
            tasks = [
                op
                for op in s._operations.values()
                if self._task(op) is not None and s._reserved(op)
            ]
            need(
                len(tasks) < 32 and sum(op["sessionId"] == parent["sessionId"] for op in tasks) < 4,
                "LOCAL_DATA_CAPACITY",
            )
            need(
                not any(self._task(op)["taskId"] == body["taskId"] for op in tasks),
                "LOCAL_DATA_REPLAY",
            )
            observation = {
                **parent["observation"],
                "bodyBytes": 0,
                "bodySha256": encode(hashlib.sha256(b"").digest()),
            }
            task = s._reserve_operation(
                s._sessions[parent["sessionId"]],
                parent["context"],
                parent["route"],
                observation,
                now,
                mono,
            )
            task.update(
                state="active",
                nativeState="active",
                nativeGeneration=body["nativeGateGeneration"],
                gatewayFinished=True,
                gatewayTransportClosed=True,
                proofDigest=parent["proofDigest"],
                gatewayProof=parent["gatewayProof"],
            )
            task["constraints"]["semanticaTask"] = {
                "parentRequestId": ancestor["parentRequestId"]
                if ancestor
                else parent["operationId"],
                **{
                    key: _copy(body[key])
                    for key in ("taskId", "taskKind", "taskDigest", "modelSnapshot")
                },
                "serviceContext": _copy(parent["route"]["serviceContext"]),
            }
            task["constraints"]["semanticaTaskDepth"] = depth + 1 if ancestor else 0
            task["constraints"]["semanticaParentTask"] = parent["operationId"] if ancestor else None
            task["requiredGrants"] = [
                {
                    "resourceId": parent["route"]["resourceId"],
                    "actions": [parent["route"]["action"]],
                }
            ]
            s.effects.operation(task)
            payload = self._task_payload(task, body, "active", now, mono)
        return await self._sign_task(payload)

    async def task_check(self, body, *, audience):
        fields(body, NATIVE)
        s = self.sessions
        await s.assert_live(body["operationId"], minimum_cache_ms=750)
        now, mono = s._now()
        async with s._lock:
            operation = s._operations.get(body["operationId"])
            self._source(operation, body, audience, now, mono)
            payload = self._task_payload(operation, body, "active", now, mono)
        return await self._sign_task(payload)

    async def task_close(self, body, *, audience):
        fields(body, NATIVE | {"outcome"})
        need(
            type(body["outcome"]) is str
            and body["outcome"] in {"completed", "cancelled", "denied", "outcome-unknown"}
        )
        s = self.sessions
        now, mono = s._now()
        async with s._lock:
            operation = s._operations.get(body["operationId"])
            need(
                audience == "semantica"
                and operation is not None
                and operation["nativeGeneration"] == body["nativeGateGeneration"]
                and self._task(operation) is not None,
                "LOCAL_DATA_FORBIDDEN",
            )
            s._native_nonce(operation, body["gateNonce"], now)
            operation.update(nativeState="closed", nativeClosed=True)
            events = s._close_op_locked(operation, body["outcome"])
            s.effects.operation(operation)
            payload = self._task_payload(operation, body, "closed", now, mono)
        await s._notify(events)
        return await self._sign_task(payload)

    def _prune(self, now):
        self.requests = {key: value for key, value in self.requests.items() if value["end"] > now}
        # Active model leases are retained until the native listener confirms
        # physical closure; revocation cannot silently free occupied capacity.
        self.leases = {
            key: value
            for key, value in self.leases.items()
            if not value.get("closed") or value["end"] > now
        }

    async def model_request(self, body, *, audience):
        fields(body, NATIVE | {"modelAction", "bodySha256", "bodyBytes"})
        digest32(body["bodySha256"])
        need(
            type(body["modelAction"]) is str
            and body["modelAction"] in {"catalog", "check", "infer"}
        )
        need(type(body["bodyBytes"]) is int and 0 < body["bodyBytes"] <= 512 * 1024)
        s = self.sessions
        need(s.gateway_model_request_signer is not None, "LOCAL_DATA_UNAVAILABLE")
        await s.assert_live(body["operationId"], minimum_cache_ms=750)
        now, mono = s._now()
        async with s._lock:
            parent = s._operations.get(body["operationId"])
            self._source(parent, body, audience, now, mono)
            task = self._task(parent)
            action = body["modelAction"]
            if action == "infer":
                need(
                    task is not None and task["modelSnapshot"] is not None,
                    "LOCAL_DATA_SCOPE_DENIED",
                )
            elif action == "check":
                need(
                    task is None
                    and parent["route"]["serviceContext"]["operation"] == "check_processing",
                    "LOCAL_DATA_SCOPE_DENIED",
                )
            else:
                need(
                    task is not None
                    or parent["route"]["serviceContext"]["operation"] in CATALOG_ROUTES,
                    "LOCAL_DATA_SCOPE_DENIED",
                )
            self._prune(now)
            need(len(self.requests) < 128, "LOCAL_DATA_CAPACITY")
            request_id = _id()
            payload = {
                **s._lease_payload(parent, body, "active", now, mono),
                "purpose": "centuarai.local-data.gateway-model-request",
                "boxId": s.box_id,
                "boxKeyThumbprint": s.box_key_thumbprint,
                "requestId": request_id,
                "parentRequestId": task["parentRequestId"]
                if task and action == "infer"
                else parent["operationId"],
                "serviceContext": _copy(parent["route"]["serviceContext"]),
                **{
                    key: _copy(task[key]) if task and action == "infer" else None
                    for key in ("taskId", "taskKind", "taskDigest", "modelSnapshot")
                },
                "modelAction": action,
                "bodySha256": body["bodySha256"],
                "bodyBytes": body["bodyBytes"],
                "requestDigest": digest(body),
            }
            signed = s.gateway_model_request_signer(payload)
            self.requests[request_id] = {
                "operationId": parent["operationId"],
                "payload": payload,
                "proof": signed,
                "end": payload["expiresAtMs"],
                "consumed": False,
                "nativeGeneration": body["nativeGateGeneration"],
            }
        return signed

    def _relay_nonce(self, lease, body):
        digest32(body["relayNonce"])
        need(body["relayGeneration"] == lease["relayGeneration"], "LOCAL_DATA_CONTEXT_CHANGED")
        need(body["relayNonce"] not in lease["nonces"], "LOCAL_DATA_REPLAY")
        need(len(lease["nonces"]) < 4096, "LOCAL_DATA_CAPACITY")
        lease["nonces"].add(body["relayNonce"])

    def _model_effect(self, lease, *, closed=False):
        value = lease["effect"]
        if closed:
            value.update(state="closed", nativeClosed=True)
        self.sessions.effects.operation(value)

    def _authorization(self, lease, body, parent, now, mono):
        authorization = body.get("authorizationBody")
        if authorization is None:
            return None
        request = lease["request"]["payload"]
        need(request["modelAction"] == "infer", "LOCAL_DATA_SCOPE_DENIED")
        fields(
            authorization,
            {"operation_id", "job_id", "purpose", "model_id", "model_revision", "task_digest"}
            | ({"inference_options"} if "inference_options" in authorization else set()),
        )
        selection = request["modelSnapshot"]
        need(
            authorization["operation_id"] == request["requestId"]
            and authorization["job_id"] == request["taskId"]
            and authorization["purpose"] == selection["purpose"]
            and authorization["model_id"] == selection["modelId"]
            and authorization["model_revision"] == selection["modelRevision"]
            and authorization["task_digest"] == request["taskDigest"],
            "LOCAL_DATA_SCOPE_DENIED",
        )
        if "inference_options" in authorization:
            fields(authorization["inference_options"], {"thinking_mode"})
            need(authorization["inference_options"]["thinking_mode"] in {"auto", "on", "off"})
        raw = json.dumps(
            authorization, sort_keys=True, separators=(",", ":"), ensure_ascii=False
        ).encode()
        need(len(raw) <= 4096)
        observation = {
            "transport": "http",
            "method": "POST",
            "rawTarget": "/api/integration/processing/authorize",
            "headers": {
                name: "application/json" if name == "contentType" else None
                for name in parent["observation"]["headers"]
            },
            "bodySha256": encode(hashlib.sha256(raw).digest()),
            "bodyBytes": len(raw),
        }
        route = {
            **_copy(parent["route"]),
            "bodyLimit": 4096,
            "upstreamPath": observation["rawTarget"],
            "serviceContext": {
                **_copy(parent["route"]["serviceContext"]),
                "operation": "authorize_processing",
            },
        }
        child = self.sessions._reserve_operation(
            self.sessions._sessions[parent["sessionId"]],
            parent["context"],
            route,
            observation,
            now,
            mono,
            parent=parent["operationId"],
        )
        child["state"] = "active"
        return child, observation

    async def _model_payload(self, lease, body, state, *, authorize=False):
        s = self.sessions
        now, mono = s._now()
        async with s._lock:
            parent = s._operations.get(lease["request"]["operationId"])
            source = lease["request"]["payload"]
            need(parent is not None or state == "closed", "LOCAL_DATA_SESSION_EXPIRED")
            if state != "closed":
                s._op_live(parent, now, mono)
                need(
                    parent["nativeState"] == "active"
                    and parent["nativeGeneration"] == lease["request"]["nativeGeneration"],
                    "LOCAL_DATA_CONTEXT_CHANGED",
                )
            native = {
                "nativeGateGeneration": source["nativeGateGeneration"],
                "gateNonce": source["gateNonce"],
            }
            if parent is None:
                from ..local_data_protocol import LEASE

                base = {key: source[key] for key in LEASE}
                base.update(state="closed", issuedAtMs=now, expiresAtMs=now + 1000)
                if "teamDigest" in source:
                    base["teamDigest"] = source["teamDigest"]
            else:
                base = s._lease_payload(parent, native, state, now, mono)
            payload = {
                **base,
                **{
                    key: _copy(source[key])
                    for key in (
                        "boxId",
                        "boxKeyThumbprint",
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
                    )
                },
                "purpose": "centuarai.local-data.gateway-model-lease",
                "gatewayProofDigest": gateway_proof_digest(lease["request"]["proof"]),
                "leaseId": lease["leaseId"],
                "relayGeneration": lease["relayGeneration"],
                "relayNonce": body["relayNonce"],
                "requestDigest": digest(body),
                "authorizationProof": None,
                "authorizationBodySha256": None,
            }
            callback = self._authorization(lease, body, parent, now, mono) if authorize else None
        if callback:
            payload["authorizationProof"] = await s.gateway_request(
                callback[0]["operationId"], callback[1]
            )
            payload["authorizationBodySha256"] = callback[1]["bodySha256"]
        need(s.gateway_model_lease_signer is not None, "LOCAL_DATA_UNAVAILABLE")
        return s.gateway_model_lease_signer(payload)

    async def model_admit(self, body, *, audience):
        fields(
            body,
            {"proof", "bodySha256", "bodyBytes", "relayGeneration", "relayNonce"}
            | ({"authorizationBody"} if "authorizationBody" in body else set()),
        )
        need(audience == "octop", "LOCAL_DATA_FORBIDDEN")
        digest32(body["relayGeneration"])
        digest32(body["relayNonce"])
        s = self.sessions
        now, _ = s._now()
        need(s.gateway_model_request_verifier is not None, "LOCAL_DATA_UNAVAILABLE")
        claims = s.gateway_model_request_verifier(body["proof"], now)
        await s.assert_live(claims["operationId"], minimum_cache_ms=750)
        now, mono = s._now()
        async with s._lock:
            self._prune(now)
            record = self.requests.get(claims["requestId"])
            need(
                record is not None and record["proof"] == body["proof"] and not record["consumed"],
                "LOCAL_DATA_REPLAY",
            )
            need(
                record["end"] > now and claims["gatewayGeneration"] == s.generation,
                "LOCAL_DATA_SESSION_EXPIRED",
            )
            need(
                body["bodySha256"] == claims["bodySha256"]
                and body["bodyBytes"] == claims["bodyBytes"],
                "LOCAL_DATA_BODY_MISMATCH",
            )
            parent = s._operations.get(claims["operationId"])
            s._op_live(parent, now, mono)
            need(parent["nativeState"] == "active", "LOCAL_DATA_SESSION_EXPIRED")
            need(len(self.leases) < 128, "LOCAL_DATA_CAPACITY")
            record["consumed"] = True
            lease = {
                "leaseId": _id(),
                "relayGeneration": body["relayGeneration"],
                "request": record,
                "nonces": {body["relayNonce"]},
                "end": now + 1000,
                "closed": False,
            }
            # A backend worker finishing is not proof that this separate model
            # listener has drained its provider socket. Keep independent
            # physical evidence until model-close acknowledges that drain.
            lease["effect"] = {
                "operationId": lease["leaseId"],
                "sessionId": parent["sessionId"],
                "parentOperationId": parent["operationId"],
                "context": _copy(parent["context"]),
                "route": {"audience": "octop"},
                "nativeGeneration": body["relayGeneration"],
                "nativeClosed": False,
                "gatewayFinished": True,
                "gatewayTransportClosed": True,
                "state": "active",
            }
            self.leases[lease["leaseId"]] = lease
            self._model_effect(lease)
        try:
            return await self._model_payload(lease, body, "active", authorize=True)
        except BaseException:
            # Admission has not been delivered and no inference can have
            # started. Burn the request but release this undelivered lease.
            async with s._lock:
                self._model_effect(lease, closed=True)
                self.leases.pop(lease["leaseId"], None)
            raise

    async def model_check(self, body, *, audience):
        fields(
            body,
            {"leaseId", "relayGeneration", "relayNonce"}
            | ({"authorizationBody"} if "authorizationBody" in body else set()),
        )
        need(audience == "octop", "LOCAL_DATA_FORBIDDEN")
        digest32(body["leaseId"])
        digest32(body["relayGeneration"])
        lease = self.leases.get(body["leaseId"])
        need(lease is not None and not lease["closed"], "LOCAL_DATA_SESSION_CLOSED")
        await self.sessions.assert_live(lease["request"]["operationId"], minimum_cache_ms=750)
        async with self.sessions._lock:
            self._relay_nonce(lease, body)
        return await self._model_payload(lease, body, "active", authorize=True)

    async def model_close(self, body, *, audience):
        fields(body, {"leaseId", "relayGeneration", "relayNonce", "outcome"})
        need(
            audience == "octop"
            and type(body["outcome"]) is str
            and body["outcome"] in {"completed", "cancelled", "denied", "outcome-unknown"},
            "LOCAL_DATA_FORBIDDEN",
        )
        digest32(body["leaseId"])
        digest32(body["relayGeneration"])
        lease = self.leases.get(body["leaseId"])
        need(lease is not None and not lease["closed"], "LOCAL_DATA_SESSION_CLOSED")
        async with self.sessions._lock:
            self._relay_nonce(lease, body)
            lease.update(closed=True, end=self.sessions._now()[0] + 1000)
            self._model_effect(lease, closed=True)
        return await self._model_payload(lease, body, "closed")
