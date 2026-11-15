import pytest
from wanx_bridge.platform_sessions import PlatformSessions
from wanx_bridge.config import BridgeAuthError

CLAIMS = dict(boxId='box', ownershipEpoch=1, serviceId='huohua-boxd', userId='user', spaceId='space')

class Runtime:
    async def open(self, key, state=None): return None
    async def close(self, key): return None
    async def storage(self, key): return {'cookies': [], 'origins': []}
    async def tabs(self, key): return []
    async def input(self, key, event): self.event = event
    def ready(self): return True

@pytest.mark.asyncio
async def test_lease_sync_and_isolation(tmp_path):
    clock = [0.0]
    manager = PlatformSessions(tmp_path, Runtime(), clock=lambda: clock[0])
    opened = await manager.dispatch(CLAIMS, 'open', dict(accountBindingId='binding-12345678', accountId=1, platform='tencent'))
    sid = opened['sessionId']
    with pytest.raises(BridgeAuthError):
        await manager.dispatch({**CLAIMS, 'userId': 'other'}, 'state', {'sessionId': sid})
    claimed = await manager.dispatch(CLAIMS, 'claim', dict(sessionId=sid, requestId='request'))
    assert claimed['lease']
    with pytest.raises(BridgeAuthError):
        await manager.dispatch(CLAIMS, 'claim', dict(sessionId=sid, requestId='other'))
    await manager.dispatch(CLAIMS, 'release', dict(sessionId=sid, lease=claimed['lease'], epoch=claimed['epoch']))
    exported = await manager.dispatch(CLAIMS, 'export', dict(sessionId=sid), group='storage')
    assert exported == await manager.dispatch(CLAIMS, 'export', dict(sessionId=sid), group='storage')
    await manager.dispatch(CLAIMS, 'ack', dict(sessionId=sid, syncId=exported['syncId'], revision=exported['revision']), group='storage')
    assert (await manager.dispatch(CLAIMS, 'state', dict(sessionId=sid)))['mode'] == 'readonly'
    await manager.dispatch(CLAIMS, 'claim', dict(sessionId=sid, requestId='again'))
    clock[0] = 61
    assert (await manager.dispatch(CLAIMS, 'state', dict(sessionId=sid)))['mode'] == 'syncing'

@pytest.mark.asyncio
async def test_real_browser_through_single_use_gateway(tmp_path):
    import httpx
    from playwright.async_api import async_playwright
    from test_gateway import live_server
    from test_huohua_gateway import _app_environment
    from websockets.asyncio.client import connect

    app, _ = _app_environment(tmp_path, lambda _: httpx.Response(200))
    manager = app.state.platform_sessions
    manager.root = tmp_path / 'bindings'
    manager.runtime.root = tmp_path / 'profiles'
    claims = {**CLAIMS, 'taskId': 'task'}
    async with live_server(app) as origin:
        if not await manager.runtime.probe():
            pytest.skip('Set WANX_PLATFORM_BROWSER_EXECUTABLE to an installed Chromium executable')
        a = await manager.dispatch(claims, 'open', dict(accountBindingId='binding-real-one', accountId=1, platform='tencent'))
        b = await manager.dispatch(claims, 'open', dict(accountBindingId='binding-real-two', accountId=2, platform='tencent'))
        assert a['sessionId'] != b['sessionId']
        page = manager.runtime.page(a['sessionId'])
        await page.set_content('<input id="text"><input id="file" type="file"><button onclick="document.title=\'clicked\'">Go</button>')
        await page.evaluate("document.addEventListener('keydown', e => window.lastKey = {key:e.key, ctrl:e.ctrlKey, shift:e.shiftKey})")
        await manager.runtime.input(a['sessionId'], {'type': 'keydown', 'key': 'a', 'modifiers': 10})
        assert await page.evaluate('window.lastKey') == {'key': 'a', 'ctrl': True, 'shift': True}
        await manager.runtime.input(a['sessionId'], {'type': 'keyup', 'key': 'a', 'modifiers': 10})
        await page.evaluate("document.addEventListener('click', e => window.lastClick = {ctrl:e.ctrlKey, shift:e.shiftKey})")
        await manager.runtime.input(a['sessionId'], {'type': 'click', 'x': 10, 'y': 10})
        assert await page.evaluate('window.lastClick') == {'ctrl': False, 'shift': False}
        second = await page.context.new_page()
        await second.route('**/*', lambda route: route.fulfill(status=200, content_type='text/html', body='<title>Private URL</title>'))
        await second.goto('https://example.test:8443/public/path?token=secret#private')
        tabs = await manager.runtime.tabs(a['sessionId'])
        assert tabs[-1]['url'] == 'https://example.test:8443/public/path'
        await manager.runtime.input(a['sessionId'], {'type': 'tab_switch', 'tab_id': tabs[0]['id']})
        assert manager.runtime.page(a['sessionId']) == page
        await second.close()
        lease = await manager.dispatch(claims, 'acquire', dict(sessionId=a['sessionId'], taskId='task', attemptId='attempt', requestId='request'), group='automation')
        body = dict(sessionId=a['sessionId'], taskId='task', attemptId='attempt', lease=lease['lease'], epoch=lease['epoch'])
        attached = await manager.dispatch(claims, 'attach', body, group='automation')
        endpoint = origin.replace('http:', 'ws:') + attached['attachPath']
        async with async_playwright() as p:
            browser = await p.chromium.connect_over_cdp(endpoint, headers={'X-Platform-Attach': attached['ticket']})
            remote = browser.contexts[0].pages[0]
            await remote.locator('#text').fill('中文测试')
            upload = tmp_path / 'upload.txt'
            upload.write_text('real attachment')
            await remote.locator('#file').set_input_files(upload)
            await remote.locator('button').click()
            assert await remote.title() == 'clicked'
            assert await remote.locator('#file').evaluate('(node) => node.files[0].name') == 'upload.txt'
            frame = await manager.dispatch(claims, 'frame', {'sessionId': a['sessionId']})
            assert frame['image'].startswith('data:image/jpeg;base64,')
            assert manager.runtime.page(b['sessionId']).url == 'about:blank'
            with pytest.raises(Exception):
                async with connect(endpoint, additional_headers={'X-Platform-Attach': attached['ticket']}):
                    pass
            await manager.dispatch(claims, 'release', {**body, 'completed': True}, group='automation')
        state = await manager.dispatch(claims, 'export', {'sessionId': a['sessionId']}, group='storage')
        assert set(state['storageState']) == {'cookies', 'origins'}

@pytest.mark.asyncio
async def test_automation_timeout_and_durable_pending(tmp_path):
    clock = [0.0]
    runtime = Runtime()
    manager = PlatformSessions(tmp_path, runtime, clock=lambda: clock[0])
    claims = {**CLAIMS, 'taskId': 'task'}
    opened = await manager.dispatch(claims, 'open', dict(accountBindingId='binding-12345678', accountId=1, platform='tencent'))
    sid = opened['sessionId']
    await manager.dispatch(claims, 'acquire', dict(sessionId=sid, taskId='task', attemptId='attempt', requestId='request'), group='automation')
    clock[0] = 61
    result = await manager.dispatch(claims, 'state', {'sessionId': sid})
    assert result['mode'] == 'recovering' and result['needsReview']
    with pytest.raises(BridgeAuthError):
        await manager.dispatch(claims, 'claim', dict(sessionId=sid, requestId='human'))
    await manager.dispatch(claims, 'import', dict(sessionId=sid, expectedRevision=0, storageState={'cookies': [], 'origins': []}), group='storage')
    pending = await manager.dispatch(claims, 'export', {'sessionId': sid}, group='storage')
    restarted = PlatformSessions(tmp_path, runtime)
    assert await restarted.dispatch(claims, 'export', {'sessionId': sid}, group='storage') == pending
    ack = dict(sessionId=sid, syncId=pending['syncId'], revision=pending['revision'])
    await restarted.dispatch(claims, 'ack', ack, group='storage')
    again = PlatformSessions(tmp_path, runtime)
    assert (await again.dispatch(claims, 'ack', ack, group='storage'))['mode'] == 'readonly'


def test_gateway_actions_and_storage_strictness():
    from wanx_bridge.huohua import resolve_capability
    from wanx_bridge.platform_sessions import validate_storage
    assert resolve_capability('browser.platform.storage', 'POST', '/api/browser/platform-sessions/storage/import')
    for capability, path in [('browser.platform', '/api/browser/platform-sessions/storage/export'), ('browser.platform.automation', '/api/browser/platform-sessions/automation/anything')]:
        with pytest.raises(BridgeAuthError):
            resolve_capability(capability, 'POST', path)
    for state in [{'cookies': [], 'origins': [], 'secret': 'x'}, {'cookies': [], 'origins': [{'origin': 'file:///private', 'localStorage': []}]}]:
        with pytest.raises(BridgeAuthError):
            validate_storage(state)

@pytest.mark.asyncio
async def test_task_rotation_keeps_browser_lease_but_revocation_stops_it(tmp_path):
    import httpx
    from test_huohua_gateway import _app_environment
    _, verifier = _app_environment(tmp_path, lambda _: httpx.Response(200))
    parent = verifier.issue_delegated('huohua.workbench', protocol_version=1, box_id='box', user_id='user', space_id='space', scope=['workbench:browser'], upstream_token='upstream', authority={'ownership_epoch': 1})
    issued = verifier.issue_task(parent, task_id='task', scope=['workbench:browser'])
    claims = verifier.verify(issued['access_token'])
    manager = PlatformSessions(tmp_path / 'bindings', Runtime())
    opened = await manager.dispatch(claims, 'open', dict(accountBindingId='binding-12345678', accountId=1, platform='tencent'))
    sid = opened['sessionId']
    validate = lambda: verifier.assert_platform_task_authority(claims)
    acquired = await manager.dispatch(claims, 'acquire', dict(sessionId=sid, taskId='task', attemptId='attempt', requestId='request'), group='automation', validate=validate)
    rotated = verifier.renew_task(issued['access_token'], task_id='task')
    await manager.expire()
    assert manager.records[sid]['mode'] == 'automation'
    await manager.dispatch(verifier.verify(rotated['access_token']), 'heartbeat', dict(sessionId=sid, taskId='task', attemptId='attempt', lease=acquired['lease'], epoch=acquired['epoch']), group='automation', validate=validate)
    verifier.revoke_task(rotated['access_token'], task_id='task')
    await manager.expire()
    assert manager.records[sid]['mode'] == 'recovering'


@pytest.mark.asyncio
async def test_attach_rechecks_lease_after_endpoint_connection(tmp_path):
    runtime = Runtime()
    runtime.endpoint = lambda _: 'ws://127.0.0.1/internal'
    manager = PlatformSessions(tmp_path, runtime)
    claims = {**CLAIMS, 'taskId': 'task'}
    opened = await manager.dispatch(claims, 'open', dict(accountBindingId='binding-12345678', accountId=1, platform='tencent'))
    sid = opened['sessionId']
    acquired = await manager.dispatch(claims, 'acquire', dict(sessionId=sid, taskId='task', attemptId='attempt', requestId='request'), group='automation')
    body = dict(sessionId=sid, taskId='task', attemptId='attempt', lease=acquired['lease'], epoch=acquired['epoch'])
    attached = await manager.dispatch(claims, 'attach', body, group='automation')
    value, _ = await manager.consume_ticket(attached['ticket'])
    await manager.dispatch(claims, 'release', {**body, 'completed': True}, group='automation')
    class Socket:
        async def accept(self):
            raise AssertionError('stale socket must not be accepted')
    with pytest.raises(BridgeAuthError):
        await manager.register_connection(value, Socket())

@pytest.mark.asyncio
@pytest.mark.parametrize('event', [
    {'type': 'click', 'x': float('nan'), 'y': 1},
    {'type': 'click', 'x': 1, 'y': float('inf')},
    {'type': 'click', 'x': -1, 'y': 1},
    {'type': 'click', 'x': 1281, 'y': 1},
    {'type': 'click', 'x': 1, 'y': 1, 'surprise': True},
    {'type': 'type', 'text': 'x' * 16385},
    {'type': 'keydown', 'key': 'a', 'modifiers': 16},
    {'type': 'scroll', 'deltaY': 10001},
    {'type': 'scroll', 'x': 1},
    {'type': 'unknown'},
])
async def test_input_rejects_invalid_event_before_browser_access(tmp_path, event):
    from wanx_bridge.platform_browser_runtime import PlatformBrowserRuntime
    runtime = PlatformBrowserRuntime(tmp_path)
    with pytest.raises(BridgeAuthError, match='PLATFORM_INPUT_INVALID'):
        await runtime.input('not-opened', event)


def test_public_tab_url_redacts_credentials_and_nonweb_content():
    from wanx_bridge.platform_browser_runtime import public_tab_url
    assert public_tab_url('https://user:password@example.test:8443/path?token=secret#private') == 'https://example.test:8443/path'
    assert public_tab_url('data:text/html,private') == 'about:blank'
    assert public_tab_url('file:///private/state') == 'about:blank'
