"""Signed callback output diagnostics expose schema paths, never source values."""
import json
import logging

import httpx
import pytest
from test_semantica_model_relay import PATH, TEAM_OWNER, call, signed
from test_semantica_model_relay import relay as _relay

relay = _relay
SCHEMA = {"type": "object", "required": ["entities"], "additionalProperties": False,
          "properties": {"entities": {"type": "array", "items": {
              "type": "object", "required": ["confidence"], "additionalProperties": False,
              "properties": {"confidence": {"type": "number", "maximum": 1}}}}}}


@pytest.mark.parametrize('value,validator,path', [
    ({'entities': [{'confidence': 'PRIVATE_VALUE'}]}, 'type', '/entities/0/confidence'),
    ({'entities': [{}]}, 'required', '/entities/0/confidence'),
    ({'entities': [{'confidence': 2}]}, 'maximum', '/entities/0/confidence'),
    ({'entities': [], 'PRIVATE_KEY': 'PRIVATE_VALUE'}, 'additionalProperties', ''),
    ([], 'type', ''),
])
async def test_schema_error_callback(relay, value, validator, path, caplog):
    relay.output['choices'][0]['message']['content'] = json.dumps(value)
    with caplog.at_level(logging.WARNING, logger='wanx_bridge.semantica.model_relay'):
        response = await call(relay, schema=SCHEMA)
    assert response.status_code == 502
    assert response.json()['code'] == 'MODEL_INVALID_OUTPUT'
    detail = response.json()['output_diagnostic']
    assert detail['kind'] == 'schema_validation'
    assert detail['validator'] == validator and detail['field_path'] == path
    assert detail['source'] == 'bridge'
    assert 'PRIVATE' not in response.text
    assert 'PRIVATE' not in caplog.text
    event = next(json.loads(r.getMessage()) for r in caplog.records
                 if r.name == 'wanx_bridge.semantica.model_relay')
    assert event['outputDiagnostic'] == detail


@pytest.mark.parametrize('kind', ['invalid_json', 'truncated', 'invalid_response', 'response_too_large'])
async def test_output_categories_are_distinct(relay, kind):
    if kind == 'invalid_json':
        relay.output['choices'][0]['message']['content'] = '{PRIVATE'
    elif kind == 'truncated':
        relay.output['choices'][0]['finish_reason'] = 'length'
    elif kind == 'invalid_response':
        relay.output = {'PRIVATE': 'PRIVATE'}
    else:
        async def huge(request):
            return httpx.Response(200, content=b'P' * (1024 * 1024 + 1))
        relay.handler = huge
    response = await call(relay, schema=SCHEMA)
    assert response.status_code == 502
    assert response.json()['output_diagnostic']['kind'] == kind
    assert 'PRIVATE' not in response.text


@pytest.mark.parametrize('has_detail', [True, False])
async def test_core_callback_sanitizes_details_and_keeps_legacy_errors(relay, has_detail):
    relay.core_status = 502
    relay.core_result = {'code': 'MODEL_INVALID_OUTPUT'}
    if has_detail:
        relay.core_result['output_diagnostic'] = {
            'version': 1, 'source': 'upstream', 'kind': 'schema_validation',
            'field_path': '/entities/0/PRIVATE', 'validator': 'type', 'message': 'PRIVATE',
            'instance': 'PRIVATE'}
    body = {'owner': TEAM_OWNER, 'actor_id': 'wanx:7', 'action': 'infer',
            'selection': {'id': 'core:model', 'revision': 'core-revision'},
            'job_id': 'team-job', 'purpose': 'extraction', 'text': 'synthetic', 'schema': SCHEMA}
    response = await relay.client.post(PATH, **signed(body))
    assert response.status_code == 502
    assert response.json()['code'] == 'MODEL_INVALID_OUTPUT'
    assert 'PRIVATE' not in response.text
    if has_detail:
        assert response.json()['output_diagnostic']['field_path'] == '/entities/0/*'
    else:
        assert 'output_diagnostic' not in response.json()


@pytest.mark.parametrize('choices', [None, [], [None], [42], "PRIVATE", {"0": {}}])
async def test_malformed_choices_are_controlled_output_failures(relay, choices):
    relay.output['choices'] = choices
    response = await call(relay, schema=SCHEMA)
    assert response.status_code == 502
    assert response.json()['code'] == 'MODEL_INVALID_OUTPUT'
    assert response.json()['output_diagnostic']['kind'] == 'invalid_response'
    assert 'PRIVATE' not in response.text


@pytest.mark.parametrize('value', [[], None, 42, "PRIVATE"])
async def test_loose_schema_does_not_allow_non_object_model_output(relay, value):
    relay.output['choices'][0]['message']['content'] = json.dumps(value)
    response = await call(relay, schema={})
    assert response.status_code == 502
    assert response.json()['output_diagnostic']['validator'] == 'type'
    assert 'PRIVATE' not in response.text


@pytest.mark.parametrize('status', [401, 429, 503])
async def test_large_http_error_is_not_misclassified_as_model_output(relay, status, caplog):
    async def fail(request):
        return httpx.Response(status, content=b'P' * (1024 * 1024 + 1))
    relay.handler = fail
    with caplog.at_level(logging.WARNING, logger='wanx_bridge.semantica.model_relay'):
        response = await call(relay)
    assert response.status_code == 502
    assert response.json()['code'] == 'MODEL_CALL_FAILED'
    assert 'output_diagnostic' not in response.json()
    event = next(json.loads(r.getMessage()) for r in caplog.records
                 if r.name == 'wanx_bridge.semantica.model_relay')
    assert event['upstreamStatus'] == status
    assert event['category'] == 'upstream_http'


async def test_truncation_log_has_actual_budget_and_safe_reason(relay, caplog):
    relay.output['choices'][0]['finish_reason'] = 'length'
    relay.output['choices'][0]['message']['content'] = 'PRIVATE'
    with caplog.at_level(logging.WARNING, logger='wanx_bridge.semantica.model_relay'):
        response = await call(relay, max_output_tokens=1024)
    assert response.status_code == 502
    event = next(json.loads(r.getMessage()) for r in caplog.records
                 if r.name == 'wanx_bridge.semantica.model_relay')
    assert event['outputDiagnostic']['kind'] == 'truncated'
    assert event['outputMetadata']['finish_reason'] == 'length'
    assert event['outputMetadata']['max_output_tokens'] == 1024
    assert event['outputMetadata']['requested_output_tokens'] == 1024
    assert 'PRIVATE' not in caplog.text


async def test_upstream_cannot_invent_log_counters(relay, caplog):
    relay.output['choices'][0].update(finish_reason='length', response_bytes=987,
                                     json_error_position=654, max_output_tokens=1)
    with caplog.at_level(logging.WARNING, logger='wanx_bridge.semantica.model_relay'):
        response = await call(relay, max_output_tokens=1024)
    assert response.status_code == 502
    event = next(json.loads(r.getMessage()) for r in caplog.records
                 if r.name == 'wanx_bridge.semantica.model_relay')
    assert event['outputMetadata'] == {
        'finish_reason': 'length', 'max_output_tokens': 1024, 'requested_output_tokens': 1024}


async def test_team_forwarding_keeps_diagnostics_but_drops_log_only_metadata(relay):
    relay.core_status = 502
    relay.core_result = {
        "code": "MODEL_INVALID_OUTPUT",
        "output_diagnostic": {"version": 1, "source": "bridge", "kind": "truncated", "field_path": ""},
        "output_metadata": {"max_output_tokens": 4096, "finish_reason": "length"},
        "outputMetadata": {"private": "PRIVATE"},
    }
    response = await relay.client.post(PATH, **signed({"action": "infer", "owner": TEAM_OWNER}))
    assert response.status_code == 502
    assert response.json()["output_diagnostic"]["kind"] == "truncated"
    assert "outputMetadata" not in response.json() and "output_metadata" not in response.json()
    assert "PRIVATE" not in response.text
