"""Exercise the actual loopback Host, not only the separate desktop router."""
# ruff: noqa: F811
import json
from types import SimpleNamespace

import httpx
import pytest
from test_semantica_host_modeling import env, WAREHOUSE  # noqa: F401
from wanx_bridge.semantica import client as owner_client
from wanx_bridge.semantica import source_preparation_contract as source


@pytest.fixture
async def host(env, monkeypatch):
    state, client, _ = env
    real_client = httpx.AsyncClient

    async def owner(request):
        import base64
        encoded = request.headers['x-semantica-scope']
        claims = json.loads(base64.urlsafe_b64decode(encoded + '=' * (-len(encoded) % 4)))
        state.calls.append((request, claims))
        return httpx.Response(state.response_status, json=state.response)

    monkeypatch.setattr(owner_client, 'httpx', SimpleNamespace(
        AsyncClient=lambda **kw: real_client(transport=httpx.MockTransport(owner), **kw),
        TimeoutException=httpx.TimeoutException, HTTPError=httpx.HTTPError,
    ))
    return state, client


def url(suffix):
    return f'/api/semantica/warehouses/{WAREHOUSE}/workbench/documents/document/{suffix}'


@pytest.mark.parametrize('model,suffix', [
    (source.ConfirmSource, 'source-confirmations'), (source.RetrySourceIndex, 'index-retries'),
])
async def test_local_host_forwards_source_commands_and_replay_identity(host, model, suffix):
    state, client = host
    body = source.EXAMPLES[model]
    state.response = {'receipt': {'confirmation_id': 'confirmation', 'index_status': 'queued'}, 'reused': False}
    for reused in [False, True]:
        state.response['reused'] = reused
        response = await client.post(url(suffix), json=body)
        assert response.status_code == 200, response.text
        assert response.json() == state.response
        request, grant = state.calls[-1]
        assert request.url.path == '/api/integration/workbench/documents/document/' + suffix
        assert json.loads(request.content) == body
        assert grant['actor_id'] == 'wanx:7'
        assert grant['operation_id'] == body['operation_id']
        assert grant['workspace_bindings']
        assert response.headers['cache-control'] == 'no-store'
    assert state.calls[0][1]['workspace_id'] == state.calls[1][1]['workspace_id']


@pytest.mark.parametrize('extra,status', [
    ({'workspace_id': 'other'}, 403), ({'actor_id': 'other'}, 403),
    ({'force': True}, 422), ({'_native_operation_id': 'different'}, 422),
    ({'expected_document_version_id': ''}, 422),
    ({'confirmed': False}, 422), ({'confirmed': 1}, 422), ({'confirmed': 'true'}, 422),
])
async def test_local_host_rejects_invalid_source_commands_before_forwarding(host, extra, status):
    state, client = host
    response = await client.post(url('source-confirmations'), json={**source.EXAMPLES[source.ConfirmSource], **extra})
    assert response.status_code == status, response.text
    assert not state.calls


@pytest.mark.parametrize('code', sorted(source.ERROR_CODES))
async def test_local_host_preserves_safe_source_conflicts(host, code):
    state, client = host
    state.response_status = 409
    state.response = {'code': code, 'detail': 'PRIVATE source text', 'message': 'PRIVATE key'}
    response = await client.post(url('source-confirmations'), json=source.EXAMPLES[source.ConfirmSource])
    assert response.status_code == 409
    assert response.json()['code'] == code
    assert 'PRIVATE' not in response.text


async def test_local_host_denies_permissions_queries_and_unknown_routes(host):
    state, client = host
    body = source.EXAMPLES[source.ConfirmSource]
    assert (await client.post(url('source-confirmations')+'?force=true', json=body)).status_code == 422
    assert (await client.post(url('unknown-source-action'), json=body)).status_code == 404
    assert (await client.post(url('source-confirmations'), json=body, headers={'x-wanx-data-context':'team'})).status_code == 403
    state.allowed = False
    assert (await client.post(url('source-confirmations'), json=body)).status_code == 403
    assert not state.calls
