"""Security and compatibility examples at the shared native transport seam."""

from copy import deepcopy
import unittest

from centuarai_local_data_gate import starlink_workbench as contract


BASE = '/workbench/conversations/conversation-1'
INTENT = BASE + '/intents/intent-1'
CORRECTION = '/workbench/documents/document-1/corrections'
EDITOR = {'session': 's' * 32, 'generation': '1'}
DIGEST = 'a' * 64


def command(**values):
    return {'_native_operation_id': 'test-operation', 'operation_id': 'test-operation', **values}


class MaterialTransportContractTests(unittest.TestCase):
    def test_material_inventory_static_routes_precede_conversation_ids(self):
        base='/workbench/conversations/materials'
        self.assertEqual(contract.operation_name('GET',base),'list_material_workflows')
        self.assertEqual(contract.operation_name('GET',base+'/document-1'),'get_material_workflow')
        contract.validate_query('GET',base,{'offset':'0','limit':'50'})
        contract.validate_query('GET',base+'/document-1',{})
        for query in ({'limit':'51'},{'workspace_id':'foreign'},{'intent_offset':'1'}):
            with self.assertRaises(ValueError):contract.validate_query('GET',base,query)
        self.assertIsNone(contract.operation_name('POST',base+'/document-1'))

    def test_real_conversation_material_command_envelopes_are_admitted(self):
        cases = [
            ('/workbench/conversations', command(scenario='material'), 'create_conversation'),
            (BASE + '/messages', command(expected_revision=1, content='材料中的任职公司是什么？'), 'send_conversation_message'),
            (BASE + '/intents', command(expected_revision=1, document_id='document-1'), 'create_material_intent'),
            (INTENT + '/analyze', command(document_version_id='version-1'), 'analyze_material'),
            (INTENT + '/goal', command(expected_revision=1, expected_conversation_revision=2, goal='核对任职关系', instructions='', confirmed=True), 'prepare_material_goal'),
            (INTENT + '/confirm', command(expected_revision=1, expected_conversation_revision=2, plan_digest=DIGEST, confirmed=True), 'confirm_material_extraction'),
            (INTENT + '/change-context', {'_native_operation_id': 'test-operation'}, 'get_material_change_context'),
            (INTENT + '/change-proposals', command(context_digest=DIGEST, instruction='仅修改目标'), 'generate_material_change'),
            (INTENT + '/change-proposals/proposal-1/read', {'_native_operation_id': 'test-operation'}, 'read_material_change'),
            (INTENT + '/change-proposals/proposal-1/apply', command(proposal_digest=DIGEST, confirmed=True), 'apply_material_change'),
            (INTENT + '/review-plan', {'_native_operation_id': 'test-operation', '_native_editor': EDITOR}, 'preview_material_review'),
            (INTENT + '/review', command(expected_revision=1, plan_digest=DIGEST, confirmed=True, _native_editor=EDITOR), 'merge_material_review'),
        ]
        for path, body, operation in cases:
            with self.subTest(path=path):
                self.assertEqual(contract.operation_name('POST', path), operation)
                contract.validate_query('POST', path, {})
                self.assertEqual(contract.validate_body('POST', path, body), 'test-operation')

    def test_ontology_change_conversation_preserves_operation_identity(self):
        path = '/workbench/conversations'
        for scenario in ('material', 'onboarding', 'change'):
            with self.subTest(scenario=scenario):
                body = command(scenario=scenario)
                self.assertEqual(contract.validate_body('POST', path, body), 'test-operation')
                self.assertEqual(contract.resource_ids('POST', path, body), {})

    def test_ontology_change_conversation_does_not_admit_unknown_scenarios_or_authority(self):
        path = '/workbench/conversations'
        bodies = [command(scenario=value) for value in ('unknown', '', None, 1)]
        bodies += [command(scenario='change', **mutation) for mutation in (
            {'workspace_id': 'foreign'}, {'actor_id': 'other'},
            {'_native_operation_id': 'different'}, {'confirmed': True},
        )]
        for body in bodies:
            with self.subTest(body=body), self.assertRaises(ValueError):
                contract.validate_body('POST', path, body)

    def test_editor_publication_and_fixed_read_envelopes_are_admitted(self):
        cases = [
            (CORRECTION + '/sessions', command(), 'create_correction_session'),
            (CORRECTION + '/draft-1/claim', command(expected_revision=1, _native_editor=EDITOR), 'claim_correction_draft'),
            (CORRECTION + '/draft-1/save', command(expected_revision=1, upserts=[], remove_ids=[], _native_editor=EDITOR), 'save_correction_draft'),
            (CORRECTION + '/draft-1/submit', command(expected_revision=1, _native_editor=EDITOR), 'submit_correction_draft'),
            ('/workbench/_correction_read', {'_native_operation_id': 'test-operation', '_native_editor': EDITOR,
                'path': '/api/documents/document-1/corrections/draft-1/preview', 'query': {'revision': '1'}}, 'correction_read'),
        ]
        for path, body, operation in cases:
            with self.subTest(path=path):
                self.assertEqual(contract.operation_name('POST', path), operation)
                self.assertEqual(contract.validate_body('POST', path, body), 'test-operation')

    def test_required_editor_commands_keep_strict_domain_revision_fields(self):
        # The legacy HTTP adapter may defer DTO errors to Semantica; required
        # transport admission must still reject these incomplete commands.
        for action in ('claim', 'release', 'heartbeat'):
            with self.subTest(action=action):
                with self.assertRaises(ValueError):
                    contract.validate_body('POST', CORRECTION + '/draft-1/' + action,
                        command(_native_editor=EDITOR))

    def test_resource_bindings_are_explicit_and_do_not_come_from_envelope_authority(self):
        path = INTENT + '/change-proposals/proposal-1/apply'
        self.assertEqual(contract.resource_ids('POST', path, command(proposal_digest=DIGEST, confirmed=True)),
            {'conversation_id': 'conversation-1', 'intent_id': 'intent-1', 'proposal_id': 'proposal-1'})
        body = {'_native_operation_id': 'test-operation', '_native_editor': EDITOR,
            'path': '/api/documents/document-1/corrections/draft-1/items/item-1', 'query': {'revision': '1'}}
        self.assertEqual(contract.resource_ids('POST', '/workbench/_correction_read', body),
            {'document_id': 'document-1', 'draft_id': 'draft-1', 'item_id': 'item-1'})

    def test_authority_operation_identity_and_confirmation_mutations_are_rejected(self):
        path = INTENT + '/change-proposals/proposal-1/apply'
        good = command(proposal_digest=DIGEST, confirmed=True)
        bad = [dict(good, actor_id='other'), dict(good, workspace_id='other'),
            dict(good, warehouseId='other'), dict(good, operation_id='different'),
            dict(good, confirmed='true'), dict(good, proposal_digest='A' * 64),
            dict(good, _native_editor={'session': 's' * 32, 'generation': '1', 'actor_id': 'other'})]
        for body in bad:
            with self.subTest(body=body):
                with self.assertRaises(ValueError):
                    contract.validate_body('POST', path, body)

    def test_fixed_correction_read_cannot_turn_into_a_proxy_or_choose_a_warehouse(self):
        base = {'_native_operation_id': 'test-operation', '_native_editor': EDITOR,
            'path': '/api/documents/document-1/corrections/draft-1/items', 'query': {'revision': '1'}}
        mutations = [dict(base, path='/api/settings'), dict(base, path='http://localhost/api/documents/x/corrections'),
            dict(base, path='/api/documents/document-1/corrections/../jobs'),
            dict(base, path='/api/documents/document-1/corrections/draft-1/submit'),
            dict(base, query={'workspace_id': 'other', 'revision': '1'}),
            dict(base, query={'revision': '1', 'limit': '51'}), dict(base, query={'revision': 'true'}),
            dict(base, _native_editor={'session': 'short', 'generation': '1'}),
            dict(base, _native_editor={'session': 's' * 32, 'generation': 1})]
        for body in mutations:
            with self.subTest(body=body):
                with self.assertRaises(ValueError):
                    contract.validate_body('POST', '/workbench/_correction_read', body)

    def test_read_pages_remain_bounded_and_cannot_select_another_scope(self):
        contract.validate_query('GET', BASE + '/messages', {'after_sequence': '0', 'limit': '100'})
        for query in ({'limit': '101'}, {'limit': '01'}, {'workspace_id': 'other'}, {'after_sequence': '-1'}):
            with self.subTest(query=query):
                with self.assertRaises(ValueError):
                    contract.validate_query('GET', BASE + '/messages', query)
        for method, path in [('DELETE', BASE), ('POST', BASE + '/execute'), ('GET', BASE + '/%2e%2e'), ('GET', BASE + '/unknown')]:
            with self.subTest(method=method, path=path):
                self.assertIsNone(contract.operation_name(method, path))
                with self.assertRaises(ValueError):
                    contract.validate_query(method, path, {})

    def test_actual_material_result_lookup_is_one_scoped_read(self):
        path = '/workbench/knowledge/runs/run-1'
        self.assertEqual(contract.operation_name('GET', path), 'get_knowledge_run')
        contract.validate_query('GET', path, {})
        self.assertIsNone(contract.validate_body('GET', path, None))
        self.assertEqual(contract.resource_ids('GET', path), {'run_id': 'run-1'})
        self.assertIsNone(contract.operation_name('POST', path))
        for query in ({'workspace_id': 'other'}, {'document_id': 'other'}, {'limit': '200'}):
            with self.subTest(query=query):
                with self.assertRaises(ValueError):
                    contract.validate_query('GET', path, query)

    def test_business_schema_property_names_do_not_become_transport_authority(self):
        schema = {'entity_types': [{'name': '测试', 'properties': [{'name': 'workspace_id', 'type': 'string'}]}]}
        body = {'_native_operation_id': 'test-operation', 'name': '测试', 'schema': schema}
        self.assertEqual(contract.validate_body('POST', '/workbench/ontologies', body), 'test-operation')
        copied = deepcopy(body)
        copied['workspace_id'] = 'other'
        with self.assertRaises(ValueError):
            contract.validate_body('POST', '/workbench/ontologies', copied)


if __name__ == '__main__':
    unittest.main()
