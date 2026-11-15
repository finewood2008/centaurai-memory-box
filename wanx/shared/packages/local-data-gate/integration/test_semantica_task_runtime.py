"""Shared client interoperability with the actual signed Bridge task broker.

Run with server/bridge and server/bridge/tests on PYTHONPATH. The real broker,
authority executor, signatures and shared client run on separate event-loop
threads. Only kernel peer transport is replaced by the fixed audience adapter.
"""
from copy import deepcopy
import asyncio
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from test_semantica_model_authority import native_source

from centuarai_local_data_gate.client import BrokerClient, GateContext, GateSemanticaTaskContext
from centuarai_local_data_gate import protocol as wire


class RuntimeBroker:
    def __init__(self, runtime, harness):
        self.runtime, self.harness = runtime, harness
        self.config = SimpleNamespace(audience='semantica', gateway_id=harness.service.gateway_id,
            gateway_key=wire.public_jwk(harness.gateway))
        self._tasks_lock = threading.Lock()
        self._task_operations = {}

    def call_sync(self, operation, body):
        service = self.harness.service
        handlers = {
            'check': service.native_check,
            'closed': service.native_closed,
            'observe': service.native_observe,
            'semantica-task-start': service.semantica_models.task_start,
            'semantica-task-check': service.semantica_models.task_check,
            'semantica-task-close': service.semantica_models.task_close,
        }
        return self.runtime(handlers[operation](body, audience='semantica'))

    async def call(self, operation, body):
        return await asyncio.to_thread(self.call_sync, operation, body)


class RuntimeTaskRestorationTests(unittest.TestCase):
    def setUp(self):
        self.loop = asyncio.new_event_loop()
        self.thread = threading.Thread(target=self.loop.run_forever, daemon=True)
        self.thread.start()
        self.harness, self.source = self.runtime(native_source(None))
        self.clock_patch = patch('centuarai_local_data_gate.client.time.time',
            lambda: self.harness.clock.wall / 1000)
        self.clock_patch.start()
        self.config = SimpleNamespace(audience='semantica', gateway_id=self.harness.service.gateway_id,
            gateway_key=wire.public_jwk(self.harness.gateway), box_id=self.harness.view['boxId'],
            box_key_thumbprint=self.harness.view['boxKeyThumbprint'])
        self.broker = RuntimeBroker(self.runtime, self.harness)
        operation = self.harness.service._operations[self.source['operationId']]
        claims = wire.verify_gateway_request(operation['gatewayProof'], self.config.gateway_key,
            self.harness.clock.wall)
        self.context = GateContext(self.config, self.broker, claims, operation['gatewayProof'],
            operation['nativeGeneration'])
        body = self.context._body()
        self.context._accept(self.broker.call_sync('check', body), body, {'active'})

    def runtime(self, coroutine):
        return asyncio.run_coroutine_threadsafe(coroutine, self.loop).result(timeout=5)

    def tearDown(self):
        try:
            self.runtime(self.harness.service.close())
            self.runtime(self.loop.shutdown_default_executor())
        finally:
            self.clock_patch.stop()
            self.loop.call_soon_threadsafe(self.loop.stop)
            self.thread.join(timeout=5)
            self.loop.close()

    @staticmethod
    def descriptor(kind):
        return dict(task_id=kind + '-job', kind=kind,
            digest=wire.digest({'kind': kind, 'immutable_source_version': 'v1'}), model_snapshot=None)

    def hierarchy(self):
        parse = self.context.start_semantica_task_sync(**self.descriptor('parse'))
        index = parse.start_semantica_task_sync(**self.descriptor('index'))
        sensitive = index.start_semantica_task_sync(**self.descriptor('sensitive'))
        return parse, index, sensitive

    def finish_source(self):
        body = {**self.context._body(), 'outcome': 'completed'}
        self.broker.call_sync('closed', body)
        self.runtime(self.harness.service.finish_operation(self.source['operationId'], transport_closed=True))

    def test_multilevel_export_restore_survives_closed_parents_and_obeys_revocation(self):
        parse, index, sensitive = self.hierarchy()
        record = sensitive.export_record()
        self.assertEqual(sensitive.task_identity['parentRequestId'], self.source['operationId'])
        index.closed_sync('completed')
        parse.closed_sync('completed')
        self.finish_source()
        restarted_broker = RuntimeBroker(self.runtime, self.harness)
        restored = GateSemanticaTaskContext.restore(self.config, restarted_broker, record,
            **self.descriptor('sensitive'))
        restored.require_live()
        self.assertEqual(restored.task_identity['parentRequestId'], self.source['operationId'])
        self.assertEqual(restored.native_generation, sensitive.native_generation)
        self.harness.view['status'] = 'revoked'
        self.harness.clock.advance(1001)
        with self.assertRaises(wire.DataProtocolError):
            restored.require_live()
        with self.assertRaises(wire.DataProtocolError):
            GateSemanticaTaskContext.restore(self.config, restarted_broker, record,
                **self.descriptor('sensitive'))
        restored.closed_sync('denied')

    def test_immediate_parent_substitution_cannot_replace_original_signed_root(self):
        parse, index, sensitive = self.hierarchy()
        record = sensitive.export_record()
        changed = wire.verify_gateway_semantica_task(record['taskProof'], self.config.gateway_key, None)
        changed['parentRequestId'] = index.claims['operationId']
        tampered = dict(record, taskProof=wire.sign_gateway_semantica_task(changed, self.harness.gateway))
        with self.assertRaises(wire.DataProtocolError):
            GateSemanticaTaskContext.restore(self.config, self.broker, tampered,
                **self.descriptor('sensitive'))
        with self.assertRaises(wire.DataProtocolError):
            GateSemanticaTaskContext.restore(self.config, self.broker, record,
                **dict(self.descriptor('sensitive'), digest=wire.digest({'changed_source': True})))
        closed = deepcopy(record)
        sensitive.closed_sync('completed')
        with self.assertRaises(wire.DataProtocolError):
            GateSemanticaTaskContext.restore(self.config, self.broker, closed,
                **self.descriptor('sensitive'))
        index.closed_sync('completed')
        parse.closed_sync('completed')

    def test_new_process_inventory_cannot_hide_restored_old_generation_task(self):
        parse, index, sensitive = self.hierarchy()
        record = sensitive.export_record()
        index.closed_sync('completed')
        parse.closed_sync('completed')
        self.finish_source()
        restarted = RuntimeBroker(self.runtime, self.harness)
        restored = GateSemanticaTaskContext.restore(self.config, restarted, record,
            **self.descriptor('sensitive'))
        self.harness.service.effects.audiences = frozenset({'semantica'})
        self.harness.service.gateway_observation_signer = lambda payload: wire.sign_gateway_observation(
            payload, self.harness.gateway)
        new_generation = wire.digest({'new_process': 1})
        accepted = self.runtime(BrokerClient.observe(restarted, new_generation, ()))
        self.assertFalse(accepted)
        # Observation is closure evidence, not job authorization. The old
        # generation retains exact task checks until explicit physical close.
        restored.require_live()
        restored.closed_sync('completed')
        self.assertTrue(self.runtime(BrokerClient.observe(restarted, new_generation, ())))


if __name__ == '__main__':
    unittest.main()
