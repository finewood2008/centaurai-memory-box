"""The actual onboarding/model-selection envelopes remain finite and scoped."""
import unittest


class BootstrapContractTests(unittest.TestCase):
    def contract(self):
        from centuarai_local_data_gate import semantica_bootstrap
        return semantica_bootstrap

    def test_empty_start_onboarding_and_warehouse_commands(self):
        contract = self.contract()
        cases = [
            ('/modeling/onboarding', {'operation_id': 'save', 'expected_revision': 0,
                'answers': {'warehouse_name': '测试仓', 'background': '软件验收', 'flow_step': 'confirm'}}, 'save_onboarding'),
            ('/modeling/onboarding/profile-1/warehouse', {'operation_id': 'create', 'expected_revision': 1,
                'name': '测试仓', 'purpose': '合成材料验收'}, 'create_onboarding_warehouse'),
            ('/warehouses', {'operation_id': 'create', 'name': '测试仓', 'description': ''}, 'create_warehouse'),
        ]
        for path, body, operation in cases:
            with self.subTest(path=path):
                self.assertEqual(contract.operation_name('POST', path), operation)
                self.assertEqual(contract.validate_body('POST', path, body), body['operation_id'])

    def test_literal_warehouse_runtime_is_a_read_not_a_warehouse_identifier(self):
        contract = self.contract()
        self.assertEqual(contract.operation_name('GET', '/warehouses/runtime'), 'get_warehouse_runtime')
        contract.validate_query('GET', '/warehouses/runtime', {})
        self.assertIsNone(contract.validate_body('GET', '/warehouses/runtime', None))
        self.assertEqual(contract.resource_ids('GET', '/warehouses/runtime'), {})
        self.assertIsNone(contract.operation_name('POST', '/warehouses/runtime'))
        for query in ({'warehouse_id': 'other'}, {'path': '/settings'}):
            with self.subTest(query=query):
                with self.assertRaises(ValueError):
                    contract.validate_query('GET', '/warehouses/runtime', query)
        with self.assertRaises(ValueError):
            contract.validate_body('GET', '/warehouses/runtime', {'actor_id': 'other'})

    def test_initial_suggestion_and_model_check_shapes(self):
        contract = self.contract()
        root = '/modeling/warehouses/10000000-0000-4000-8000-000000000001'
        body = {'operation_id': 'answers', 'expected_revision': 0, 'onboarding_revision': 1,
            'answers': {'purpose': '核对材料中的任职关系'}}
        self.assertEqual(contract.validate_body('POST', root + '/answer-confirmations', body), 'answers')
        check = {'operation_id': 'check', 'mode': 'manual', 'extraction': '1:deepseek-flash',
            'inference_options': {'thinking_mode': 'auto'}, 'cloud_confirmations': ['1:deepseek-flash']}
        self.assertEqual(contract.validate_body('POST', '/processing/check', check), 'check')
        for extra in ({'actor_id': 'other'}, {'permissions': ['write']}, {'owner_view': True}):
            with self.subTest(extra=extra):
                with self.assertRaises(ValueError):
                    contract.validate_body('POST', '/processing/check', dict(check, **extra))

    def test_model_save_cannot_smuggle_a_new_unchecked_model_or_credentials(self):
        contract = self.contract()
        body = {'operation_id': 'save', 'expected_revision': 0, 'check_id': 'check-1'}
        self.assertEqual(contract.validate_body('PUT', '/processing', body), 'save')
        for extra in ({'extraction': 'other'}, {'api_key': 'secret'}, {'inference_options': {'thinking_mode': 'on'}}):
            with self.subTest(extra=extra):
                with self.assertRaises(ValueError):
                    contract.validate_body('PUT', '/processing', dict(body, **extra))

    def test_private_callbacks_and_unrelated_owner_apis_stay_unregistered(self):
        contract = self.contract()
        for method, path in [('POST', '/processing/authorize'), ('GET', '/settings/models'),
                ('POST', '/warehouses/id/delete'), ('GET', '/warehouses/id/keys'),
                ('POST', '/warehouses/imports'), ('POST', '/modeling/execute')]:
            with self.subTest(method=method, path=path):
                self.assertIsNone(contract.operation_name(method, path))

    def test_selection_is_a_reference_that_must_match_verified_route_context(self):
        contract = self.contract()
        selected = '10000000-0000-4000-8000-000000000001'
        body = {'operation_id': 'save', 'expected_revision': 0, 'warehouse_id': selected}
        contract.validate_selection(body, {}, selected)
        with self.assertRaises(ValueError):
            contract.validate_selection(body, {}, '20000000-0000-4000-8000-000000000001')
        with self.assertRaises(ValueError):
            contract.validate_selection(body, {}, None)

    def test_untyped_json_values_are_rejected_without_validator_type_errors(self):
        contract = self.contract()
        cases = [
            ('/modeling/onboarding', {'operation_id': 'save', 'expected_revision': 0, 'answers': {}, 'status': []}),
            ('/modeling/onboarding', {'operation_id': 'save', 'expected_revision': 0, 'answers': {'flow_mode': {}}}),
            ('/processing/check', {'operation_id': 'check', 'extraction': 'model', 'mode': []}),
            ('/processing/check', {'operation_id': 'check', 'extraction': 'model', 'inference_options': {'thinking_mode': {}}}),
            ('/processing/check', {'operation_id': 'check', 'extraction': None}),
        ]
        for path, body in cases:
            with self.subTest(path=path, body=body):
                with self.assertRaises(ValueError):
                    contract.validate_body('POST', path, body)

    def test_rename_is_a_finite_metadata_command_with_an_explicit_warehouse(self):
        contract = self.contract()
        warehouse = '10000000-0000-4000-8000-000000000001'
        path = '/warehouses/' + warehouse
        body = {'name': '🌟' * 60, 'operation_id': 'rename-stable'}
        self.assertEqual(contract.operation_name('PATCH', path), 'rename_warehouse')
        self.assertEqual(contract.resource_ids('PATCH', path, body), {'warehouse_id': warehouse})
        self.assertEqual(contract.validate_body('PATCH', path, body), 'rename-stable')
        contract.validate_query('PATCH', path, {})
        for invalid in ({'name': ''}, {'name': ' '}, {'name': '🌟' * 61}, {'name': 'x\n'},
                {'name': '\x7fx'}, {'name': 'x\x85'}, {'description': 'overwrite'},
                {'warehouse_id': warehouse}, {'workspace_id': 'other'}, {'actor_id': 'other'}):
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                contract.validate_body('PATCH', path, {**body, **invalid})
        for method, target in [('PUT', path), ('POST', path), ('PATCH', '/warehouses'), ('PATCH', '/warehouses/../settings')]:
            self.assertIsNone(contract.operation_name(method, target))
        with self.assertRaises(ValueError):
            contract.validate_query('PATCH', path, {'warehouse_id': warehouse})


if __name__ == '__main__':
    unittest.main()
