"""Standard expert HTTP is an exact managed application capability."""
import pytest

from centuarai_local_data_gate.native_policy import MIB, check_octop_request, classify_octop
from centuarai_local_data_gate.protocol import DataProtocolError

SLOT = 'ai.wanx.selfmade.' + 'a' * 32
OTHER = 'ai.wanx.selfmade.' + 'b' * 32
ROUTES = [('GET', '/api/wanx-expert-app/v1/context', 'read', 0),
          ('POST', '/api/wanx-expert-app/v1/invoke', 'execute', MIB)]


@pytest.mark.parametrize('method,path,action,limit', ROUTES)
def test_exact_standard_routes_keep_the_verified_application_resource(method, path, action, limit):
    resource = 'team:application:' + SLOT
    expected = {'family': 'company-runtime', 'resourceId': resource, 'action': action, 'bodyLimit': limit}
    assert classify_octop(method, path, 'http', SLOT, resource) == expected
    scope = {'type': 'http', 'method': method, 'path': path, 'raw_path': path.encode(), 'query_string': b''}
    claims = {'audience': 'octop', 'applicationId': SLOT, 'action': action, 'bodyBytes': limit,
              'resourceId': resource, 'headers': {'dataContext': resource},
              'serviceContext': {'clipboardScope': None}, 'team': {'permissions': []}}
    assert check_octop_request(scope, claims) == expected
    for wrong in ['team:application:' + OTHER, 'team:management', 'wanx']:
        with pytest.raises(DataProtocolError):
            classify_octop(method, path, 'http', SLOT, wrong)
        with pytest.raises(DataProtocolError):
            check_octop_request(scope, {**claims, 'resourceId': wrong})
    with pytest.raises(DataProtocolError):
        check_octop_request(scope, {**claims, 'bodyBytes': limit + 1})


@pytest.mark.parametrize('method,path,action,limit', ROUTES)
def test_standard_routes_reject_management_audiences_and_aliases(method, path, action, limit):
    for application in ['wanx-host', 'ai.wanx.studio', 'centaurai.wanx.ai-browser', 'ordinary.app']:
        with pytest.raises(DataProtocolError):
            classify_octop(method, path, 'http', application)
    for target in [path + '?', path + '?environment=prod', path + '?slot=' + OTHER,
                   path + '/', path.replace('/v1/', '/v2/'), path.replace('context', '%63ontext')]:
        if target == path:
            continue
        with pytest.raises(DataProtocolError):
            classify_octop(method, target, 'http', SLOT)
    for verb in ['HEAD', 'PUT', 'DELETE', 'OPTIONS', 'POST' if method == 'GET' else 'GET']:
        with pytest.raises(DataProtocolError):
            classify_octop(verb, path, 'http', SLOT)
    with pytest.raises(DataProtocolError):
        classify_octop(method, path, 'websocket', SLOT)
