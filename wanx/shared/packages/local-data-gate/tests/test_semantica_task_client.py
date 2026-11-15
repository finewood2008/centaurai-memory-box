"""Signed broker responses cannot change Semantica's task/model authority."""

from copy import deepcopy
from types import SimpleNamespace
import threading
import time
import unittest
from uuid import UUID, uuid5

from cryptography.hazmat.primitives.asymmetric import ec

from centuarai_local_data_gate import client, protocol as p


class SignedBroker:
    def __init__(self):
        self.key = ec.generate_private_key(ec.SECP256R1())
        thumb = p.digest({'synthetic': 'box'})
        namespace = p.digest({'schemaVersion': 1, 'purpose': 'centuarai.local-data.principal',
            'boxKeyThumbprint': thumb, 'ownershipEpoch': 1, 'principalId': 'principal'})
        workspace = str(uuid5(UUID('8ae54f40-4054-4bba-a2e2-06e1c43d7514'), '["box","semantica","local:' + namespace + '"]'))
        self.config = SimpleNamespace(audience='semantica', gateway_id='gateway', gateway_key=self.key.public_key(),
            box_id='box', box_key_thumbprint=thumb)
        now = int(time.time() * 1000)
        self.claims = dict(schemaVersion=1, purpose='centuarai.local-data.gateway-request', audience='semantica',
            gatewayId='gateway', gatewayGeneration=p.digest({'gateway': 1}), sessionId=p.digest({'session': 1}),
            operationId=p.digest({'operation': 1}), parentOperationId=None, jti=p.digest({'jti': 1}),
            issuedAtMs=now-10, expiresAtMs=now+1500, authorizationVersion=1, principalSecurityVersion=1,
            bindingRevision=1, applicationId='ai.wanx.starlink', launchId=p.digest({'launch': 1}),
            transport='http', method='POST', rawTarget='/api/integration/workbench/conversations/conversation/intents/intent/confirm',
            headers={name: None for name in p.HEADERS}, bodySha256=p.digest({'body': 1}), bodyBytes=100,
            resourceId='semantica', action='write', serviceContext=dict(kind='warehouse', principalNamespace=namespace,
                workspaceId=workspace, warehouseId=None, operation='confirm_material_extraction'),
            boxId='box', boxKeyThumbprint=thumb, ownershipEpoch=1, principalId='principal', bindingId='binding', clientId='client')
        self.proof = p.sign_gateway_request(self.claims, self.key)
        self.generation = p.digest({'native': 1})
        self._tasks_lock, self._task_operations = threading.Lock(), {}
        self.calls, self.task = [], None
        self.mutate = lambda value: value
        self.deny = False

    def lease(self, body, *, task=False, closed=False):
        now = int(time.time() * 1000)
        value = {name: self.claims[name] for name in p.LEASE if name in self.claims}
        value.update(purpose='centuarai.local-data.gateway-lease', nativeGateGeneration=self.generation,
            gateNonce=body['gateNonce'], gatewayProofDigest=p.gateway_proof_digest(self.proof), state='closed' if closed else 'active',
            issuedAtMs=now-5, expiresAtMs=now+750)
        if task:
            value.update(self.task)
            value['operationId'] = p.digest({'task-operation': self.task['taskId']})
        return value

    def call_sync(self, operation, body):
        self.calls.append((operation, deepcopy(body)))
        if self.deny:
            raise p.DataProtocolError('LOCAL_DATA_SESSION_CLOSED')
        if operation == 'check':
            return p.sign_gateway_lease(self.lease(body), self.key)
        if operation == 'semantica-task-start':
            self.task = {name: body[name] for name in ('taskId', 'taskKind', 'taskDigest', 'modelSnapshot')}
        if operation.startswith('semantica-task-'):
            value = self.lease(body, task=True, closed=operation.endswith('close'))
            value.update(purpose='centuarai.local-data.gateway-semantica-task', parentRequestId=self.claims['operationId'],
                boxId=self.claims['boxId'], boxKeyThumbprint=self.claims['boxKeyThumbprint'], serviceContext=deepcopy(self.claims['serviceContext']))
            return p.sign_gateway_semantica_task(self.mutate(value), self.key)
        if operation == 'model-request':
            active_task = self.task is not None and body['operationId'] != self.claims['operationId']
            value = self.lease(body, task=active_task)
            value.update(purpose='centuarai.local-data.gateway-model-request', requestId=p.digest({'request': len(self.calls)}),
                parentRequestId=self.claims['operationId'] if body['modelAction'] == 'infer' else body['operationId'],
                boxId=self.claims['boxId'], boxKeyThumbprint=self.claims['boxKeyThumbprint'],
                serviceContext=deepcopy(self.claims['serviceContext']), taskId=None, taskKind=None, taskDigest=None, modelSnapshot=None,
                modelAction=body['modelAction'], bodySha256=body['bodySha256'], bodyBytes=body['bodyBytes'], requestDigest=p.digest(body))
            if active_task and body['modelAction'] == 'infer':
                value.update(self.task)
            return p.sign_gateway_model_request(self.mutate(value), self.key)
        raise AssertionError(operation)

    async def call(self, operation, body):
        return self.call_sync(operation, body)

    def context(self):
        context = client.GateContext(self.config, self, self.claims, self.proof, self.generation)
        body = context._body()
        context._accept(p.sign_gateway_lease(self.lease(body), self.key), body, {'active'})
        return context


class SemanticaTaskClientTests(unittest.TestCase):
    def setUp(self):
        self.broker = SignedBroker()
        self.context = self.broker.context()
        self.expected = dict(task_id='job-1', kind='extraction', digest=p.digest({'input': 'source-version'}),
            model_snapshot={'modelId': '1:deepseek-flash', 'modelRevision': 'a' * 64, 'purpose': 'extraction'})

    def test_native_model_request_commits_to_exact_bytes_without_legacy_bearer(self):
        raw = b'{}'
        headers = self.context.model_headers('catalog', raw)
        self.assertEqual(set(headers), {'x-centuarai-model-proof', 'content-length'})
        claims = p.verify_gateway_model_request(headers['x-centuarai-model-proof'], self.broker.key.public_key(), int(time.time() * 1000))
        self.assertEqual(claims['bodyBytes'], 2)
        self.assertEqual(claims['bodySha256'], p.encode(__import__('hashlib').sha256(raw).digest()))
        self.assertEqual(claims['modelAction'], 'catalog')
        self.assertIsNone(claims['taskId'])

    def test_signed_broker_cannot_change_model_body_or_request_binding(self):
        for key, changed in [('bodySha256', p.digest({'foreign': True})), ('requestDigest', p.digest({'foreign': True})),
                ('parentRequestId', p.digest({'other-parent': 1}))]:
            with self.subTest(key=key):
                self.broker.mutate = lambda value: dict(value, **{key: changed})
                with self.assertRaises(p.DataProtocolError):
                    self.context.model_headers('catalog', b'{}')

    def test_task_is_bound_to_actual_job_and_restoration_needs_fresh_broker(self):
        task = self.context.start_semantica_task_sync(**self.expected)
        record = task.export_record()
        self.broker.deny = True
        with self.assertRaises(p.DataProtocolError):
            client.GateSemanticaTaskContext.restore(self.broker.config, self.broker, record, **self.expected)
        self.broker.deny = False
        with self.assertRaises(p.DataProtocolError):
            client.GateSemanticaTaskContext.restore(self.broker.config, self.broker, record, **dict(self.expected, task_id='different-job'))
        restored = client.GateSemanticaTaskContext.restore(self.broker.config, self.broker, record, **self.expected)
        self.assertEqual(restored.task_identity['taskId'], 'job-1')
        self.assertEqual(self.broker.calls[-1][0], 'semantica-task-check')
        restored.require_live()
        proof = restored.model_headers('infer', b'{"model_id":"1:deepseek-flash"}')['x-centuarai-model-proof']
        claims = p.verify_gateway_model_request(proof, self.broker.key.public_key(), int(time.time() * 1000))
        self.assertEqual(claims['taskDigest'], self.expected['digest'])
        restored.closed_sync('completed')
        with self.assertRaises(p.DataProtocolError):
            restored.require_live()

    def test_persisted_record_cannot_choose_a_new_verifier_or_parent(self):
        task = self.context.start_semantica_task_sync(**self.expected)
        for extra in ({'gatewayKey': {}}, {'parentGatewayProof': self.broker.proof + 'x'}):
            with self.subTest(extra=extra):
                record = dict(task.export_record(), **extra)
                with self.assertRaises(p.DataProtocolError):
                    client.GateSemanticaTaskContext.restore(self.broker.config, self.broker, record, **self.expected)

    def test_expired_cached_task_lease_has_no_data_authority_until_fresh_check(self):
        task = self.context.start_semantica_task_sync(**self.expected)
        task._deadline = time.monotonic() - 1
        with self.assertRaises(p.DataProtocolError):
            task.check_cached()
        self.broker.deny = True
        with self.assertRaises(p.DataProtocolError):
            task.require_live()
        with self.assertRaises(p.DataProtocolError):
            task.check_cached()
        self.broker.deny = False
        task.require_live()
        task.check_cached()
        task.mark_physical_close_uncertain()
        count = len(self.broker.calls)
        with self.assertRaises(p.DataProtocolError):
            task.require_live()
        self.assertEqual(count, len(self.broker.calls))

    def test_worker_metadata_read_does_not_unfreeze_the_inference_snapshot(self):
        task = self.context.start_semantica_task_sync(**self.expected)
        headers = task.model_headers('catalog', b'{}')
        proof = p.verify_gateway_model_request(headers['x-centuarai-model-proof'], self.broker.key.public_key(), int(time.time() * 1000))
        self.assertIsNone(proof['taskId'])
        self.assertEqual(proof['parentRequestId'], task.claims['operationId'])
        self.assertEqual(task.task_identity['modelSnapshot']['modelId'], '1:deepseek-flash')

    def test_finite_child_job_keeps_the_original_request_and_restores_independently(self):
        parent_args = dict(self.expected, kind='parse', model_snapshot=None)
        parent = self.context.start_semantica_task_sync(**parent_args)
        count = len(self.broker.calls)
        with self.assertRaises(p.DataProtocolError):
            parent.start_semantica_task_sync(**dict(self.expected, task_id='forbidden-extraction'))
        self.assertEqual(count, len(self.broker.calls))
        child_args = dict(self.expected, task_id='index-job', kind='index', model_snapshot=None)
        child = parent.start_semantica_task_sync(**child_args)
        self.assertEqual(child.task_identity['parentRequestId'], self.broker.claims['operationId'])
        restored = client.GateSemanticaTaskContext.restore(self.broker.config, self.broker, child.export_record(), **child_args)
        self.assertEqual(restored.task_identity['taskId'], 'index-job')


if __name__ == '__main__':
    unittest.main()
