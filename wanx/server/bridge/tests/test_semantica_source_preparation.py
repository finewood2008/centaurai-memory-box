"""Finite scoped source commands, full receipt forwarding and legacy index route."""
# ruff: noqa: F811
import json
import pytest
from test_semantica_desktop_contract import AUTH, BASE, W, claims, desktop  # noqa: F401
from wanx_bridge.semantica import conversation_contract as contract
from wanx_bridge.semantica import source_preparation_contract as source
from wanx_bridge.semantica.desktop import resolve


@pytest.mark.parametrize('model,suffix', [(source.ConfirmSource, 'source-confirmations'), (source.RetrySourceIndex, 'index-retries')])
async def test_source_commands_are_strict_scoped_and_forwarded(desktop, model, suffix):
    client, _, profile, seen, reply, _ = desktop
    url = BASE + W + '/workbench/documents/document/' + suffix
    body = source.EXAMPLES[model]
    for extra in ({'workspace_id':'other'}, {'actor_id':'other'}, {'force':True},
                  {'_native_operation_id':'wrong'}, {'expected_document_version_id':''}):
        result = await client.post(url, headers=AUTH, json={**body, **extra})
        assert result.status_code in (403, 422), result.text
    if model is source.ConfirmSource:
        for invalid in (False, 1, 1.0, 'true'):
            response = await client.post(url, headers=AUTH, json={**body, 'confirmed':invalid})
            assert response.status_code == 422, response.text
    assert not seen
    value = {'receipt': {'confirmation_id':'confirmation', 'index_job_id':'job',
             'index_status':'queued', 'future_field':True}, 'reused':False}
    reply.update(status=202, value=value)
    result = await client.post(url, headers=AUTH, json=body)
    assert result.status_code == 202
    assert result.json() == value
    assert claims(seen[-1])['operation_id'] == body['operation_id']
    for code in source.ERROR_CODES:
        reply.update(status=409, value={'code':code, 'detail':'PRIVATE source'})
        result = await client.post(url, headers=AUTH, json=body)
        assert result.status_code == 409
        assert result.json()['code'] == code
        assert 'PRIVATE' not in result.text
    count = len(seen)
    profile['permissions'] = []
    assert (await client.post(url, headers=AUTH, json=body)).status_code == 403
    assert len(seen) == count


def test_source_documentation_and_existing_whole_index_routes():
    for method, path, _, model, _ in source.ROUTES:
        assert resolve(method, W + path.format(document_id='document'))
        extra = contract.schema_extra(method, path, model, {})
        assert '202' in extra['responses']
        assert '$ref' not in json.dumps(extra)
    # Existing POST was already registered through the workbench regex.
    assert resolve('POST', W + '/workbench/search/indexes')
    assert resolve('GET', W + '/workbench/search/indexes')


async def test_preparation_is_not_filtered_from_material_status(desktop):
    client, _, _, _, reply, _ = desktop
    value = {'document_id':'document', 'preparation':{
        'status':'awaiting_confirmation', 'ready':False,
        'source_review':{'status':'stale'}, 'indexing':{'status':'not_started', 'retryable':False}}}
    reply.update(status=200, value=value)
    result = await client.get(BASE+W+'/workbench/conversations/materials/document', headers=AUTH)
    assert result.status_code == 200
    assert result.json() == value
