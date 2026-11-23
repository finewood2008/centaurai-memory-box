"""The portable public DTOs admit no caller-selected deployment authority."""
from copy import deepcopy
import json
from pathlib import Path

from jsonschema import Draft202012Validator
import pytest

CONTRACTS = Path(__file__).resolve().parents[3] / 'personal-client/host-sdk/contracts'


def validator(name):
    value = json.loads((CONTRACTS / 'schemas' / f'expert-app-{name}.v1.schema.json').read_text())
    Draft202012Validator.check_schema(value)
    return Draft202012Validator(value)


@pytest.mark.parametrize('operation,input', [
    ('expert.run', {'operationId': 'a'*32, 'text': 'Hello'}),
    ('expert.tasks', {}), ('expert.tasks', {'runId': 'run-1'}),
    ('expert.cancel', {'runId': 'run-1'}),
    ('data.list', {'collection': 'state', 'offset': 201, 'limit': 200}),
    ('data.get', {'collection': 'state', 'id': 'pending'}),
    ('data.put', {'collection': 'state', 'id': 'pending', 'expectedRevision': 0, 'value': {'json': '{}'}}),
    ('data.delete', {'collection': 'state', 'id': 'pending', 'expectedRevision': 1}),
])
def test_invoke_contract_has_exact_operation_specific_input(operation, input):
    schema = validator('invoke')
    valid = {'operation': operation, 'input': input}
    schema.validate(valid)
    for key in ['owner', 'environment', 'slotApplicationId', 'agentId', 'url', 'launchId']:
        value = deepcopy(valid); value['input'][key] = 'caller-selected'
        assert not schema.is_valid(value)
        assert not schema.is_valid({**valid, key: 'caller-selected'})


def test_invoke_contract_rejects_undeclared_data_and_unsafe_revisions():
    schema = validator('invoke')
    for operation, input in [
        ('expert.run', {'operationId': 'a'*32, 'text': '  '}),
        ('data.get', {'collection': 'other', 'id': 'pending'}),
        ('data.get', {'collection': 'state', 'id': 'pending', 'limit': 1}),
        ('data.list', {'collection': 'state', 'limit': 201}),
        ('data.put', {'collection': 'state', 'id': 'pending', 'expectedRevision': True, 'value': {'json': '{}'}}),
        ('data.put', {'collection': 'state', 'id': 'pending', 'expectedRevision': 9007199254740992, 'value': {'json': '{}'}}),
        ('data.put', {'collection': 'state', 'id': 'pending', 'value': {'json': '{}', 'owner': 'other'}}),
    ]:
        assert not schema.is_valid({'operation': operation, 'input': input})
    validator('context')
    validator('result')


def test_public_catalog_and_openapi_point_to_both_fixed_routes():
    catalog = json.loads((CONTRACTS / 'api-catalog.v1.json').read_text())
    entry = next(item for item in catalog['surfaces'] if item['id'] == 'wanx.expert-app.v1')
    assert entry['version'] == '1.0.0' and entry['features'] == ['context', 'expert', 'data']
    assert entry['status'] == 'ready-for-acceptance'
    source = json.loads((CONTRACTS / 'api.openapi.json').read_text())
    for route in entry['routes']:
        operation = source['paths'][route['path']][route['method'].lower()]
        assert operation['x-wanx-permission'] == 'http.request'
        assert operation['parameters'] == []
