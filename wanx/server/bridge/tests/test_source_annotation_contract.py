import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from test_local_data_routes import context, observed
from wanx_bridge.local_data_protocol import DataProtocolError
from wanx_bridge.local_data_routes import route_policy, validate_staged
from wanx_bridge.semantica.desktop import resolve, prepare, DesktopError
from wanx_bridge.semantica.annotation_contract import validate

PATH='/warehouses/10000000-0000-4000-8000-000000000001/documents/doc1/source-annotation'


def payload():
    return {'operation_id':'annotation_1','expected_document_version_id':'v1','expected_revision':0,
            'source':{'file_id':'a'*32,'space_id':'personal','sha256':'b'*64,'revision':1},
            'tags':['制造业'],'description':'说明','provenance':[],'needs_review':False}


def test_metadata_path_is_finite_scoped_and_binds_operation():
    body=payload()
    assert prepare(resolve('PUT',PATH),'PUT',body,{})==(body,'annotation_1')
    assert prepare(resolve('GET',PATH),'GET',None,{})==(None,None)
    for method,path in [('POST',PATH),('DELETE',PATH),('PUT','/public/key/documents/doc1/source-annotation')]:
        with pytest.raises(DesktopError): resolve(method,path)


@pytest.mark.parametrize('change',[{'workspace_id':'other'},{'actor_id':'another'},
    {'expected_revision':True},{'tags':[' ']},{'tags':['a']*2049},{'description':'a'*2001}])
def test_invalid_or_caller_selected_scope_is_rejected(change):
    with pytest.raises(DesktopError): prepare(resolve('PUT',PATH),'PUT',{**payload(),**change},{})


def test_no_query_selectors_or_read_body():
    with pytest.raises(ValueError): validate('GET',{'anything':True},{})
    with pytest.raises(DesktopError): prepare(resolve('GET',PATH),'GET',None,{'workspace_id':'other'})


def test_annotation_search_uses_existing_private_scoped_route_and_validates_nested_options():
    search = PATH.split('/documents/')[0] + '/search'
    body = {'query':'', 'annotation_search':{'tags':['续约'], 'match':'all'}}
    forwarded, operation = prepare(resolve('POST', search),'POST',body,{})
    assert forwarded['annotation_search'] == body['annotation_search']
    assert forwarded['delivery_mode'] == 'masked'
    assert operation is None
    with pytest.raises(DesktopError):
        prepare(resolve('POST', '/search'),'POST',body,{})
    for invalid in ({'tags':[' ']}, {'tags':['x']*31}, {'match':'none'}, {'workspace_id':'injected'}):
        with pytest.raises(DesktopError):
            prepare(resolve('POST', search),'POST',{'query':'原文','annotation_search':invalid},{})


@pytest.mark.parametrize('method,operation,action', [
    ('GET', 'get_source_annotation', 'read'),
    ('PUT', 'save_source_annotation', 'write'),
])
def test_signed_annotation_route_preserves_personal_warehouse(method, operation, action):
    authority = context('semantica', [action])
    route = route_policy(authority, observed('/api/semantica' + PATH, method))
    assert route['resourceId'] == 'semantica'
    assert route['serviceContext']['warehouseId'] == PATH.split('/')[2]
    assert route['serviceContext']['operation'] == operation
    assert route['action'] == action
    assert route['upstreamPath'] == '/api/integration/documents/doc1/source-annotation'
    assert route['bodyLimit'] == (0 if method == 'GET' else 2 * 1024**2)


def test_signed_annotation_route_requires_personal_scope_and_no_query():
    for path in ('/documents/doc1/source-annotation', PATH + '?limit=1'):
        with pytest.raises(DataProtocolError):
            route_policy(context('semantica'), observed('/api/semantica' + path))
    resource = 'team:knowledge:' + PATH.split('/')[2]
    request = observed('/api/semantica' + PATH)
    request['headers']['dataContext'] = resource
    with pytest.raises(DataProtocolError):
        route_policy({**context(resource), 'team': {'roleId': 'manager', 'permissions': []}}, request)


@pytest.mark.asyncio
async def test_signed_annotation_write_validates_staged_payload():
    request = observed('/api/semantica' + PATH, 'PUT')
    operation = {'route': route_policy(context('semantica'), request), 'observation': request}
    body = json.dumps(payload()).encode()
    staging = SimpleNamespace(length=len(body), read=AsyncMock(return_value=body))
    await validate_staged(None, operation, staging)
    invalid = {**payload(), 'source': {**payload()['source'], 'space_id': 'team'}}
    staging.read.return_value = json.dumps(invalid).encode()
    with pytest.raises(DataProtocolError):
        await validate_staged(None, operation, staging)
