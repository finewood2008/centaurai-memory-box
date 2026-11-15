"""Existing quick-create route publishes schema metadata without losing fields."""
import json

import pytest

from test_semantica_desktop_contract import desktop, AUTH, BASE, WAREHOUSE
from test_semantica_host_modeling import env
from wanx_bridge.semantica.client import SemanticaClient

SUMMARY = {'id': 'ontology-1', 'version_number': 1, 'name': 'General v1',
           'status': 'published', 'template_id': 'personal_general', 'template_version': 1,
           'entity_type_count': 16, 'relation_type_count': 18}
RECEIPT = {'id': WAREHOUSE, 'name': 'Notes', 'current_ontology': SUMMARY}


async def test_quick_create_replay_and_summary_passthrough(desktop):
    client, auth, profile, seen, reply, app = desktop
    reply['value'] = RECEIPT
    body = {'operation_id': 'quick-1', 'name': 'Notes', 'description': ''}
    for _ in range(2):
        response = await client.post(BASE + '/warehouses', headers=AUTH, json=body)
        assert response.status_code == 200, response.text
        assert response.json() == RECEIPT
        assert response.headers['cache-control'] == 'no-store'
        assert seen[-1].url.path == '/api/integration/warehouses'
        assert json.loads(seen[-1].content) == body
    response = await client.get(BASE + '/warehouses/' + WAREHOUSE, headers=AUTH)
    assert response.json()['current_ontology'] == SUMMARY
    schema = app.openapi()['paths'][BASE + '/warehouses']['post']
    properties = schema['requestBody']['content']['application/json']['schema']['properties']
    assert set(properties) == {'name', 'description', 'operation_id'}
    assert 'current_ontology' in schema['description']


@pytest.mark.parametrize('extra,status', [({'template_id': 'arbitrary'}, 422), ({'workspace_id': 'foreign'}, 403)])
async def test_quick_creation_rejects_template_and_scope_injection(desktop, extra, status):
    client, _, _, seen, _, _ = desktop
    response = await client.post(BASE + '/warehouses', headers=AUTH,
                                 json={'operation_id': 'quick-1', 'name': 'Notes', **extra})
    assert response.status_code == status
    assert not seen


async def test_quick_creation_keeps_auth_and_owner_errors(desktop):
    client, _, profile, seen, reply, _ = desktop
    profile['permissions'] = []
    response = await client.post(BASE + '/warehouses', headers=AUTH,
                                 json={'operation_id': 'quick-1', 'name': 'Notes'})
    assert response.status_code == 403
    assert not seen
    profile['permissions'] = ['knowledge_bases']
    reply.update(status=409, value={'code': 'WAREHOUSE_NAME_CONFLICT', 'message': 'duplicate'})
    response = await client.post(BASE + '/warehouses', headers=AUTH,
                                 json={'operation_id': 'quick-1', 'name': 'Notes'})
    assert response.status_code == 409
    assert response.json()['code'] == 'WAREHOUSE_NAME_CONFLICT'


async def test_host_registration_preserves_existing_permission_and_response(env, monkeypatch):
    state, client, app = env
    calls = []

    async def request(self, method, path, **kwargs):
        calls.append((method, path, kwargs))
        return RECEIPT

    monkeypatch.setattr(SemanticaClient, 'request', request)
    body = {'operation_id': 'quick-1', 'name': 'Notes'}
    response = await client.post(BASE + '/warehouses', json=body)
    assert response.status_code == 200, response.text
    assert response.json() == RECEIPT
    assert calls[0][0:2] == ('POST', '/warehouses')
    assert calls[0][2]['payload'] == body
    assert 'post' in app.openapi()['paths'][BASE + '/warehouses']
    state.allowed = False
    response = await client.post(BASE + '/warehouses', json=body)
    assert response.status_code == 403
    assert len(calls) == 1
