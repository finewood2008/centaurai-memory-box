"""Finite broker-attested Semantica task and model wire contracts.

These functions validate shape and bindings, never grant authority. A receiver
must verify the gateway signature and obtain a fresh broker admission as well.
The original admitted native request remains the source of every capability.
"""

from __future__ import annotations

import hashlib
import json
import re
from types import MappingProxyType
from uuid import UUID, uuid5

from . import protocol as p

MAX_MODEL_BODY_BYTES = 512 * 1024
WORKSPACE_NAMESPACE = UUID("8ae54f40-4054-4bba-a2e2-06e1c43d7514")
TASK_KINDS = frozenset(
    {"parse", "dialogue", "change", "extraction", "publication", "retraction", "index", "sensitive"}
)
MODEL_TASK_PURPOSES = {
    "dialogue": "extraction",
    "change": "extraction",
    "extraction": "extraction",
    "sensitive": "sensitive",
}
SEMANTICA_DERIVATIONS = MappingProxyType(
    {
        "parse": frozenset({"index", "sensitive"}),
        "extraction": frozenset({"publication"}),
        "publication": frozenset({"index", "sensitive"}),
        "index": frozenset({"sensitive"}),
    }
)
TASK_FIELDS = {"taskId", "taskKind", "taskDigest", "modelSnapshot"}
CONTEXT_FIELDS = {"boxId", "boxKeyThumbprint", "parentRequestId", "serviceContext"}
MODEL_REQUEST_FIELDS = (
    CONTEXT_FIELDS
    | TASK_FIELDS
    | {
        "requestId",
        "modelAction",
        "bodySha256",
        "bodyBytes",
        "requestDigest",
    }
)
MODEL_LEASE_FIELDS = MODEL_REQUEST_FIELDS | {
    "leaseId",
    "relayGeneration",
    "relayNonce",
    "authorizationProof",
    "authorizationBodySha256",
}


def _uuid(value):
    p.need(type(value) is str)
    try:
        p.need(str(UUID(value)) == value)
    except (ValueError, AttributeError, TypeError):
        raise p.DataProtocolError() from None


def validate_task_transition(parent_kind, child_kind, depth):
    """Allow only bounded automatic work already implied by a parent task."""
    p.need(type(depth) is int and (1 <= depth <= 2 or depth == 3 and parent_kind == "index"
                                 and child_kind == "sensitive"), "LOCAL_DATA_SCOPE_DENIED")
    p.need(
        type(parent_kind) is str
        and type(child_kind) is str
        and child_kind in SEMANTICA_DERIVATIONS.get(parent_kind, frozenset()),
        "LOCAL_DATA_SCOPE_DENIED",
    )


def _workspace(box_id, resource):
    return str(
        uuid5(
            WORKSPACE_NAMESPACE, json.dumps([box_id, "semantica", resource], separators=(",", ":"))
        )
    )


def warehouse_workspace(box_id, namespace, ownership_epoch, resource_id, warehouse_id):
    """Derive a workspace from verified authority, never a caller workspace ID."""
    p.token(box_id)
    p.digest32(namespace)
    p.integer(ownership_epoch)
    if resource_id == "semantica":
        resource = "local:" + namespace
        default = _workspace(box_id, resource)
        if warehouse_id is None:
            return default
        _uuid(warehouse_id)
        return (
            default
            if warehouse_id == default
            else _workspace(box_id, resource + ":warehouse:" + warehouse_id)
        )
    p.need(
        type(resource_id) is str and resource_id.startswith("team:knowledge:"),
        "LOCAL_DATA_SCOPE_DENIED",
    )
    selected = resource_id[len("team:knowledge:") :]
    _uuid(selected)
    p.need(warehouse_id == selected, "LOCAL_DATA_SCOPE_DENIED")
    return _workspace(box_id, "team:" + str(ownership_epoch) + ":knowledge:" + selected)


def validate_warehouse_context(value):
    ctx = value["serviceContext"]
    p.fields(ctx, {"kind", "principalNamespace", "workspaceId", "warehouseId", "operation"})
    p.need(ctx["kind"] == "warehouse")
    p.token(ctx["operation"])
    expected = p.principal_namespace(
        value["boxKeyThumbprint"], value["ownershipEpoch"], value["principalId"]
    )
    p.need(ctx["principalNamespace"] == expected, "LOCAL_DATA_CONTEXT_CHANGED")
    workspace = warehouse_workspace(
        value["boxId"], expected, value["ownershipEpoch"], value["resourceId"], ctx["warehouseId"]
    )
    p.need(ctx["workspaceId"] == workspace, "LOCAL_DATA_CONTEXT_CHANGED")
    if value["resourceId"].startswith("team:knowledge:"):
        p.need(value["schemaVersion"] == 2, "LOCAL_DATA_SCOPE_DENIED")


def validate_model_snapshot(value, *, task_kind=None):
    """A frozen selected model is bound to one finite task purpose."""
    if task_kind is not None:
        p.need(type(task_kind) is str and task_kind in TASK_KINDS)
        if task_kind not in MODEL_TASK_PURPOSES:
            p.need(value is None)
            return
        if task_kind == "sensitive" and value is None:
            # A deterministic/regex-only scan may run without a model. The
            # model-request validator separately forbids infer without a snapshot.
            return
    p.fields(value, {"modelId", "modelRevision", "purpose"})
    p.need(
        type(value["modelId"]) is str
        and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}", value["modelId"]) is not None
    )
    p.need(
        type(value["modelRevision"]) is str
        and re.fullmatch(r"[a-f0-9]{64}", value["modelRevision"]) is not None
    )
    p.need(value["purpose"] in ("extraction", "sensitive"))
    if task_kind is not None:
        p.need(value["purpose"] == MODEL_TASK_PURPOSES[task_kind], "LOCAL_DATA_SCOPE_DENIED")


def _base(value, purpose, extra, *, states):
    version = value.get("schemaVersion") if type(value) is dict else None
    team = {"teamDigest"} if version == 2 else set()
    p.fields(value, p.LEASE | team | extra)
    p._base(value, purpose, versions=(1, 2))
    lease = {name: value[name] for name in p.LEASE | team}
    lease["purpose"] = "centuarai.local-data.gateway-lease"
    p.validate_gateway_lease(lease)
    p._identity(value)
    p.need(
        value["audience"] == "semantica" and value["parentOperationId"] is None,
        "LOCAL_DATA_SCOPE_DENIED",
    )
    p.need(value["state"] in states, "LOCAL_DATA_CONTEXT_CHANGED")
    p.digest32(value["parentRequestId"])
    validate_warehouse_context(value)


def _task(value):
    p.token(value["taskId"])
    p.digest32(value["taskDigest"])
    p.need(type(value["taskKind"]) is str and value["taskKind"] in TASK_KINDS)
    validate_model_snapshot(value["modelSnapshot"], task_kind=value["taskKind"])


def validate_gateway_semantica_task(value):
    _base(
        value, "gateway-semantica-task", CONTEXT_FIELDS | TASK_FIELDS, states={"active", "closed"}
    )
    _task(value)


def _model_request(value):
    p.digest32(value["requestId"])
    p.digest32(value["requestDigest"])
    p.digest32(value["bodySha256"])
    p.integer(value["bodyBytes"], zero=True)
    p.need(value["bodyBytes"] <= MAX_MODEL_BODY_BYTES, "LOCAL_DATA_BODY_TOO_LARGE")
    p.need(value["modelAction"] in ("catalog", "check", "infer"))
    if value["modelAction"] == "infer":
        _task(value)
        p.need(value["modelSnapshot"] is not None, "LOCAL_DATA_SCOPE_DENIED")
    else:
        p.need(all(value[name] is None for name in TASK_FIELDS), "LOCAL_DATA_SCOPE_DENIED")
        p.need(value["parentRequestId"] == value["operationId"], "LOCAL_DATA_CONTEXT_CHANGED")


def validate_gateway_model_request(value):
    _base(value, "gateway-model-request", MODEL_REQUEST_FIELDS, states={"active"})
    _model_request(value)


def validate_gateway_model_lease(value):
    _base(value, "gateway-model-lease", MODEL_LEASE_FIELDS, states={"active", "closed"})
    _model_request(value)
    for name in ("leaseId", "relayGeneration", "relayNonce"):
        p.digest32(value[name])
    proof, body_hash = value["authorizationProof"], value["authorizationBodySha256"]
    p.need((proof is None) == (body_hash is None))
    if proof is not None:
        # The receiver/native gate verifies this separately signed child proof.
        # It is opaque here; the outer lease binds the exact bytes and body hash.
        p.need(
            value["modelAction"] == "infer" and value["state"] == "active",
            "LOCAL_DATA_SCOPE_DENIED",
        )
        p.need(
            type(proof) is str
            and proof.isascii()
            and len(proof) <= p.MAX_PROOF_BYTES
            and re.fullmatch(r"[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+", proof) is not None
        )
        p.digest32(body_hash)


def validate_model_body_binding(claims, raw):
    """Check original bytes only after the caller has verified the proof."""
    p.need(type(raw) is bytes and len(raw) <= MAX_MODEL_BODY_BYTES, "LOCAL_DATA_BODY_TOO_LARGE")
    p.need(
        claims["bodyBytes"] == len(raw)
        and claims["bodySha256"] == p.encode(hashlib.sha256(raw).digest()),
        "LOCAL_DATA_BODY_MISMATCH",
    )


def model_request_body(operation_id, native_generation, model_action, raw, gate_nonce):
    """Build the finite native UDS request; this helper itself grants nothing."""
    for value in (operation_id, native_generation, gate_nonce):
        p.digest32(value)
    p.need(model_action in ("catalog", "check", "infer"))
    p.need(type(raw) is bytes and len(raw) <= MAX_MODEL_BODY_BYTES, "LOCAL_DATA_BODY_TOO_LARGE")
    return {
        "operationId": operation_id,
        "nativeGateGeneration": native_generation,
        "gateNonce": gate_nonce,
        "modelAction": model_action,
        "bodySha256": p.encode(hashlib.sha256(raw).digest()),
        "bodyBytes": len(raw),
    }


def validate_model_authorization_body(body, claims):
    """Bind a native job callback to the signed task and selected model."""
    p.need(
        claims["modelAction"] == "infer" and claims["modelSnapshot"] is not None,
        "LOCAL_DATA_SCOPE_DENIED",
    )
    names = {"operation_id", "job_id", "purpose", "model_id", "model_revision", "task_digest"}
    p.need(type(body) is dict and set(body) in (names, names | {"inference_options"}))
    expected = {
        "operation_id": claims["requestId"],
        "job_id": claims["taskId"],
        "purpose": claims["modelSnapshot"]["purpose"],
        "model_id": claims["modelSnapshot"]["modelId"],
        "model_revision": claims["modelSnapshot"]["modelRevision"],
        "task_digest": claims["taskDigest"],
    }
    p.need(
        all(body[name] == value for name, value in expected.items()), "LOCAL_DATA_CONTEXT_CHANGED"
    )
    if "inference_options" in body:
        p.fields(body["inference_options"], {"thinking_mode"})
        p.need(body["inference_options"]["thinking_mode"] in ("auto", "on", "off"))
