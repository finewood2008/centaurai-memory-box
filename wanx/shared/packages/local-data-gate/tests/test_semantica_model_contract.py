"""Strict model/task proof contracts, including actual ES256 wire verification."""

import hashlib
import json
import unittest
from copy import deepcopy
from uuid import UUID, uuid5

from centuarai_local_data_gate import protocol
from centuarai_local_data_gate import semantica_models as contract
from cryptography.hazmat.primitives.asymmetric import ec

NOW = 1_000_000
NS = UUID("8ae54f40-4054-4bba-a2e2-06e1c43d7514")
SELECTED = "22222222-2222-4222-8222-222222222222"


def digest(name):
    return protocol.encode(hashlib.sha256(name.encode()).digest())


def expected_workspace(box, namespace, epoch=1, warehouse=None, team=False):
    resource = "team:" + str(epoch) + ":knowledge:" + warehouse if team else "local:" + namespace
    default = str(uuid5(NS, json.dumps([box, "semantica", resource], separators=(",", ":"))))
    if not team and warehouse not in (None, default):
        return str(
            uuid5(
                NS,
                json.dumps(
                    [box, "semantica", resource + ":warehouse:" + warehouse], separators=(",", ":")
                ),
            )
        )
    return default


def base(kind, *, team=False, warehouse=None):
    thumbprint = digest("box-key")
    principal = protocol.principal_namespace(thumbprint, 1, "principal-1")
    if team:
        warehouse = warehouse or SELECTED
    value = {
        "schemaVersion": 2 if team else 1,
        "purpose": "centuarai.local-data." + kind,
        "audience": "semantica",
        "gatewayId": "gateway-80",
        "boxId": "box-80",
        "boxKeyThumbprint": thumbprint,
        "gatewayGeneration": digest("gateway-boot"),
        "nativeGateGeneration": digest("semantica-boot"),
        "gateNonce": digest("gate-nonce"),
        "sessionId": digest("session"),
        "operationId": digest("operation"),
        "parentOperationId": None,
        "gatewayProofDigest": digest("source-proof"),
        "state": "active",
        "ownershipEpoch": 1,
        "authorizationVersion": 2,
        "principalSecurityVersion": 3,
        "bindingId": "binding-1",
        "bindingRevision": 4,
        "principalId": "principal-1",
        "clientId": "client-1",
        "applicationId": "centaurai.wanx.semantica",
        "launchId": digest("launch"),
        "resourceId": "team:knowledge:" + warehouse if team else "semantica",
        "action": "execute" if team else "write",
        "issuedAtMs": NOW,
        "expiresAtMs": NOW + 1000,
        "parentRequestId": digest("parent-request"),
        "serviceContext": {
            "kind": "warehouse",
            "principalNamespace": principal,
            "workspaceId": expected_workspace("box-80", principal, warehouse=warehouse, team=team),
            "warehouseId": warehouse,
            "operation": "confirm_material_extraction",
        },
        "taskId": "33333333-3333-4333-8333-333333333333",
        "taskKind": "extraction",
        "taskDigest": digest("frozen-task"),
        "modelSnapshot": {
            "modelId": "1:org/model",
            "modelRevision": "a" * 64,
            "purpose": "extraction",
        },
    }
    if team:
        value["teamDigest"] = digest("team-context")
    return value


def request(*, action="infer", team=False, warehouse=None):
    value = base("gateway-model-request", team=team, warehouse=warehouse)
    value.update(
        requestId=digest("model-request"),
        modelAction=action,
        bodySha256=digest("body"),
        bodyBytes=37,
        requestDigest=digest("native-request-body"),
    )
    if action != "infer":
        for name in ("taskId", "taskKind", "taskDigest", "modelSnapshot"):
            value[name] = None
        value["parentRequestId"] = value["operationId"]
    return value


def lease(**kwargs):
    value = request(**kwargs)
    value.update(
        purpose="centuarai.local-data.gateway-model-lease",
        leaseId=digest("model-lease"),
        relayGeneration=digest("relay-boot"),
        relayNonce=digest("relay-nonce"),
        authorizationProof=None,
        authorizationBodySha256=None,
    )
    return value


class ModelCapabilityContractTests(unittest.TestCase):
    def denied(self, validator, value):
        with self.assertRaises(protocol.DataProtocolError):
            validator(value)

    def test_all_personal_and_team_workspaces_are_derived_from_verified_identity(self):
        for team, warehouse in ((False, None), (False, SELECTED), (True, SELECTED)):
            value = base("gateway-semantica-task", team=team, warehouse=warehouse)
            contract.validate_gateway_semantica_task(value)
            self.assertEqual(
                contract.warehouse_workspace(
                    value["boxId"],
                    value["serviceContext"]["principalNamespace"],
                    value["ownershipEpoch"],
                    value["resourceId"],
                    warehouse,
                ),
                value["serviceContext"]["workspaceId"],
            )
            for field in ("principalNamespace", "workspaceId"):
                wrong = deepcopy(value)
                wrong["serviceContext"][field] = (
                    digest("other") if field == "principalNamespace" else SELECTED
                )
                self.denied(contract.validate_gateway_semantica_task, wrong)

    def test_default_personal_warehouse_alias_has_the_same_workspace(self):
        value = base("gateway-semantica-task")
        default = value["serviceContext"]["workspaceId"]
        value["serviceContext"]["warehouseId"] = default
        contract.validate_gateway_semantica_task(value)

    def test_task_kind_freezes_the_only_permitted_model_purpose(self):
        for kind in ("parse", "publication", "index"):
            value = base("gateway-semantica-task")
            value.update(taskKind=kind, modelSnapshot=None)
            contract.validate_gateway_semantica_task(value)
            value["modelSnapshot"] = base("gateway-semantica-task")["modelSnapshot"]
            self.denied(contract.validate_gateway_semantica_task, value)
        for kind, purpose in (
            ("dialogue", "extraction"),
            ("change", "extraction"),
            ("extraction", "extraction"),
            ("sensitive", "sensitive"),
        ):
            value = base("gateway-semantica-task")
            value["taskKind"] = kind
            value["modelSnapshot"]["purpose"] = purpose
            contract.validate_gateway_semantica_task(value)
            value["modelSnapshot"]["purpose"] = (
                "sensitive" if purpose == "extraction" else "extraction"
            )
            self.denied(contract.validate_gateway_semantica_task, value)

    def test_catalog_and_check_cannot_borrow_a_durable_task(self):
        for action in ("catalog", "check"):
            good = request(action=action)
            contract.validate_gateway_model_request(good)
            for name in ("taskId", "taskKind", "taskDigest", "modelSnapshot"):
                wrong = deepcopy(good)
                wrong[name] = request()[name]
                self.denied(contract.validate_gateway_model_request, wrong)
        for name in ("taskId", "taskKind", "taskDigest", "modelSnapshot"):
            wrong = request()
            wrong[name] = None
            self.denied(contract.validate_gateway_model_request, wrong)

    def test_cpu_only_sensitive_task_does_not_grant_model_inference(self):
        task = base("gateway-semantica-task")
        task.update(taskKind="sensitive", modelSnapshot=None)
        contract.validate_gateway_semantica_task(task)
        key = ec.generate_private_key(ec.SECP256R1())
        proof = protocol._sign(task, key, "gateway-semantica-task")
        self.assertIsNone(
            protocol._verify(proof, key.public_key(), "gateway-semantica-task", NOW + 1)[
                "modelSnapshot"
            ]
        )
        infer = request()
        infer.update(taskKind="sensitive", modelSnapshot=None)
        self.denied(contract.validate_gateway_model_request, infer)
        callback = {
            "operation_id": infer["requestId"],
            "job_id": infer["taskId"],
            "purpose": "sensitive",
            "model_id": "1:model",
            "model_revision": "a" * 64,
            "task_digest": infer["taskDigest"],
        }
        self.denied(
            lambda value: contract.validate_model_authorization_body(callback, value), infer
        )

    def test_unknown_authority_fields_audience_and_noncanonical_values_are_rejected(self):
        good = request()
        mutations = [
            dict(good, actor_id="wanx:1"),
            dict(good, audience="octop"),
            dict(good, parentOperationId=digest("child")),
            dict(good, state="staging"),
            dict(good, expiresAtMs=NOW + 1001),
            dict(good, issuedAtMs=True),
            dict(good, bodyBytes=True),
            dict(good, bodyBytes=512 * 1024 + 1),
            dict(good, requestId="not-a-digest"),
            dict(good, schemaVersion=3),
            dict(good, modelAction="arbitrary-proxy"),
            dict(good, resourceId="wanx"),
        ]
        for changed in mutations:
            self.denied(contract.validate_gateway_model_request, changed)
        for key in ("modelRevision", "modelId", "purpose"):
            changed = deepcopy(good)
            changed["modelSnapshot"][key] = {
                "modelRevision": "A" * 64,
                "modelId": "1:model?token=secret",
                "purpose": "arbitrary",
            }[key]
            self.denied(contract.validate_gateway_model_request, changed)

    def test_callback_pair_is_opaque_bounded_and_only_belongs_to_active_inference(self):
        good = lease()
        good.update(
            authorizationProof="e30.e30." + "a" * 86, authorizationBodySha256=digest("callback")
        )
        contract.validate_gateway_model_lease(good)
        for mutation in (
            {"authorizationProof": None},
            {"authorizationBodySha256": None},
            {"authorizationProof": "not-a-proof"},
            {"authorizationProof": "a" * 16385},
            {"state": "closed"},
        ):
            changed = deepcopy(good)
            changed.update(mutation)
            self.denied(contract.validate_gateway_model_lease, changed)
        for action in ("catalog", "check"):
            changed = lease(action=action)
            changed.update(
                authorizationProof=good["authorizationProof"],
                authorizationBodySha256=digest("callback"),
            )
            self.denied(contract.validate_gateway_model_lease, changed)
        closed = lease()
        closed["state"] = "closed"
        contract.validate_gateway_model_lease(closed)

    def test_utf8_body_is_bound_byte_for_byte_not_reencoded(self):
        raw = '{"text":"林澈在哪任职？"}'.encode()
        good = request()
        good.update(bodySha256=protocol.encode(hashlib.sha256(raw).digest()), bodyBytes=len(raw))
        contract.validate_model_body_binding(good, raw)
        self.denied(lambda value: contract.validate_model_body_binding(good, value), raw + b" ")
        self.denied(lambda value: contract.validate_model_body_binding(good, value), raw.decode())

    def test_native_request_builder_commits_original_bytes_and_finite_action(self):
        raw = b'{"action":"catalog","owner":"private"}'
        value = contract.model_request_body(
            digest("operation"), digest("native-boot"), "catalog", raw, digest("nonce")
        )
        self.assertEqual(
            set(value),
            {
                "operationId",
                "nativeGateGeneration",
                "gateNonce",
                "modelAction",
                "bodySha256",
                "bodyBytes",
            },
        )
        self.assertEqual(value["bodySha256"], protocol.encode(hashlib.sha256(raw).digest()))
        self.assertEqual(value["bodyBytes"], len(raw))
        self.denied(
            lambda action: contract.model_request_body(
                digest("operation"), digest("native-boot"), action, raw, digest("nonce")
            ),
            "proxy",
        )
        self.denied(
            lambda body: contract.model_request_body(
                digest("operation"), digest("native-boot"), "catalog", body, digest("nonce")
            ),
            b"x" * (512 * 1024 + 1),
        )

    def test_native_callback_cannot_change_job_actor_purpose_or_model_snapshot(self):
        claims = request()
        body = {
            "operation_id": claims["requestId"],
            "job_id": claims["taskId"],
            "purpose": "extraction",
            "model_id": claims["modelSnapshot"]["modelId"],
            "model_revision": claims["modelSnapshot"]["modelRevision"],
            "task_digest": claims["taskDigest"],
            "inference_options": {"thinking_mode": "auto"},
        }
        contract.validate_model_authorization_body(body, claims)
        mutations = [
            dict(body, owner="wanx:1"),
            dict(body, actor_id="wanx:1"),
            dict(body, operation_id=digest("other-request")),
            dict(body, job_id="other-job"),
            dict(body, purpose="sensitive"),
            dict(body, model_id="2:other/model"),
            dict(body, model_revision="b" * 64),
            dict(body, task_digest=digest("changed-source")),
            dict(body, inference_options={"thinking_mode": True}),
            dict(body, inference_options={"thinking_mode": "on", "owner": "other"}),
        ]
        for changed in mutations:
            self.denied(
                lambda value: contract.validate_model_authorization_body(value, claims), changed
            )
        native_catalog = request(action="catalog")
        self.denied(
            lambda value: contract.validate_model_authorization_body(body, value), native_catalog
        )

    def test_identity_epoch_and_team_warehouse_changes_cannot_rebind_a_task(self):
        good = base("gateway-semantica-task", team=True)
        for name, value in (
            ("boxId", "another-box"),
            ("boxKeyThumbprint", digest("another-box-key")),
            ("principalId", "another-principal"),
            ("ownershipEpoch", 2),
        ):
            changed = deepcopy(good)
            changed[name] = value
            self.denied(contract.validate_gateway_semantica_task, changed)
        changed = deepcopy(good)
        changed["serviceContext"]["warehouseId"] = "44444444-4444-4444-8444-444444444444"
        self.denied(contract.validate_gateway_semantica_task, changed)
        changed = deepcopy(good)
        del changed["teamDigest"]
        self.denied(contract.validate_gateway_semantica_task, changed)

    def test_real_es256_wire_types_reject_wrong_key_type_and_expiry(self):
        key = ec.generate_private_key(ec.SECP256R1())
        other = ec.generate_private_key(ec.SECP256R1())
        for kind, value in (
            ("gateway-semantica-task", base("gateway-semantica-task")),
            ("gateway-model-request", request()),
            ("gateway-model-lease", lease()),
        ):
            with self.subTest(kind=kind):
                proof = protocol._sign(value, key, kind)
                self.assertEqual(protocol._verify(proof, key.public_key(), kind, NOW + 1), value)
                self.denied(
                    lambda p, kind=kind: protocol._verify(p, other.public_key(), kind, NOW + 1),
                    proof,
                )
                self.denied(
                    lambda p, kind=kind: protocol._verify(p, key.public_key(), kind, NOW + 1000),
                    proof,
                )
                wrong = (
                    "gateway-model-lease"
                    if kind != "gateway-model-lease"
                    else "gateway-model-request"
                )
                self.denied(
                    lambda p, wrong=wrong: protocol._verify(p, key.public_key(), wrong, NOW + 1),
                    proof,
                )

    def test_derived_tasks_only_follow_the_finite_non_escalating_worker_graph(self):
        expected = {
            "parse": {"index", "sensitive"},
            "extraction": {"publication"},
            "publication": {"index", "sensitive"},
            "index": {"sensitive"},
        }
        self.assertEqual(
            {key: set(value) for key, value in contract.SEMANTICA_DERIVATIONS.items()}, expected
        )
        for parent in contract.TASK_KINDS:
            for child in contract.TASK_KINDS:
                for depth in (1, 2):
                    if child in expected.get(parent, set()):
                        contract.validate_task_transition(parent, child, depth)
                    else:
                        self.denied(
                            lambda pair, depth=depth: contract.validate_task_transition(
                                pair[0], pair[1], depth
                            ),
                            (parent, child),
                        )
        for depth in (0, -1, True, 3, 100, "1", None):
            self.denied(
                lambda value: contract.validate_task_transition("parse", "index", value), depth
            )
        contract.validate_task_transition("index", "sensitive", 3)
        self.denied(lambda value: contract.validate_task_transition("extraction", "publication", value), 3)


if __name__ == "__main__":
    unittest.main()
