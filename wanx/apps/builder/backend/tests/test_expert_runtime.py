import asyncio
import json
from copy import deepcopy
from pathlib import Path
from types import SimpleNamespace
from uuid import uuid4

import pytest

from wanx_studio.contracts import StudioError
from wanx_studio.deployment.expert_runtime import ExpertRuntime, validate_backend
from wanx_studio.store import Store


OWNER = 'wanx:7'
TARGET = {'organizationId': 'personal-test', 'boxId': 'box-test', 'applicationId': 'app-test', 'environment': 'dev'}


class Workspace:
    def __init__(self):
        self.files = {}

    async def aupload_bytes(self, name, content):
        self.files[name] = content

    async def adownload_bytes(self, name):
        return self.files[name]


class Registry:
    def __init__(self):
        self.rows, self.configs, self.workspaces = {}, {}, {}
        self.created, self.cancelled = [], []

    def get_row(self, agent_id):
        return self.rows.get(agent_id)

    def get_config(self, agent_id):
        return self.configs.get(agent_id, {})

    def workspace_for_agent(self, agent_id):
        return self.workspaces.get(agent_id)

    async def create(self, spec, *, defer_bootstrap=False, workspace_initializer=None, before_side_effect=None):
        if before_side_effect:
            before_side_effect()
        assert not defer_bootstrap
        row = SimpleNamespace(agent_id=spec.agent_id, user_id=spec.user_id, is_shared=spec.is_shared, application_id=spec.application_id, template_name=spec.template_name, disabled=False)
        self.rows[spec.agent_id], self.configs[spec.agent_id] = row, deepcopy(spec.config)
        self.workspaces[spec.agent_id] = workspace = Workspace()
        self.created.append(spec)
        if workspace_initializer:
            await workspace_initializer(row, workspace)
        return row

    async def start(self, agent_id):
        assert agent_id in self.rows

    def cancel_stream(self, agent_id, thread_id):
        self.cancelled.append((agent_id, thread_id))


class Threads:
    def __init__(self):
        self.rows = {}

    def create_thread(self, *, agent_id, user_id, channel_type, session_key, title=None, last_active=0, thread_id=None):
        assert thread_id not in self.rows
        self.rows[thread_id] = SimpleNamespace(agent_id=agent_id, user_id=user_id, session_key=session_key)
        return thread_id


@pytest.fixture
async def setup(tmp_path, monkeypatch):
    from octop.infra.agents.experts.catalog import Expert, ExpertSummary
    from octop.infra.gateway.ws.ws_hub import WebSocketHub
    from octop.api.routers.chat.turn import PreparedDashboardTurn, content_parts_from_dashboard_turn
    import octop.api.routers.chat.turn as turns

    root = tmp_path / 'library' / 'general-assistant'
    root.mkdir(parents=True)
    (root / 'manifest.json').write_text('{"id":"general-assistant"}')
    (root / 'SOUL.md').write_text('Synthetic expert identity')
    expert = Expert(ExpertSummary(id='general-assistant', label_zh='合成专家', label_en='Synthetic', description_zh='', description_en=''), files=['SOUL.md'], prompt_files=['SOUL.md'])
    catalog = SimpleNamespace(get=lambda name: expert if name == 'general-assistant' else None, expert_dir=lambda name: root,
                              list_summaries=lambda **kw: [expert.summary])
    registry, threads, hub = Registry(), Threads(), WebSocketHub()
    enqueued, prepared = [], []
    user = SimpleNamespace(id=7, disabled=False, local_data=False, application_id='wanx', locale='zh', is_admin=False)
    users = {7: user}
    server = SimpleNamespace(paths=SimpleNamespace(agent_workspace=lambda aid: tmp_path / 'agents' / aid), expert_catalog=catalog, services=SimpleNamespace(user_repo=SimpleNamespace(get=lambda uid: users.get(uid))), user_manager=SimpleNamespace(get_by_id=lambda uid: users.get(uid)),
                             app_runtime=SimpleNamespace(agent_registry=registry, gateway=SimpleNamespace(ws_hub=hub, thread_registry=threads, channel_manager=SimpleNamespace(enqueue=lambda channel, msg: enqueued.append((channel, msg))))))
    store = Store(tmp_path / 'store')
    sessions, active = {}, {}

    def runtime(owner, token):
        session = sessions.get(token)
        if not session or session['owner'] != owner:
            raise StudioError('RUNTIME_SESSION_EXPIRED', 401)
        binding = active.get(session['deploymentSlot'])
        if not binding or binding['generation'] != session['deploymentGeneration']:
            raise StudioError('UPDATE_REQUIRED', 409)
        return session

    svc = SimpleNamespace(store=store, runtime=runtime, authorize_management=lambda owner: None, model=None,
                          deployment_profile=SimpleNamespace(slot_id=lambda owner, target: 'slot-' + target['environment'], find_binding=lambda owner, slot: active.get(slot)))

    async def prepare_turn(actual_server, *, agent_id, user, turn):
        assert actual_server is server
        assert turn.mcp_servers == [] and turn.skills == [] and turn.knowledge_base_ids == [] and turn.target_agent_ids == []
        assert turn.conversation_mode == 'ask'
        assert not turn.text.lstrip().startswith('/')
        prepared.append(turn)
        return PreparedDashboardTurn(thread_id=turn.thread_id, session_key=turn.session_key, mcp_servers=[], skills=[], model_ref=turn.default_model, inbound_content=content_parts_from_dashboard_turn(turn), composer_context=None, inbound_attachments=[])

    monkeypatch.setattr(turns, 'prepare_dashboard_turn', prepare_turn)
    engine = ExpertRuntime(svc, server)
    template = engine.templates()[0]
    descriptor = {'schemaVersion': 1, 'format': 'wanx-expert-backend-v1', 'template': {k: template[k] for k in ['resourceId', 'version', 'digest']}, 'mode': 'ask'}
    binding = await engine.prepare(OWNER, TARGET, 'project-test', descriptor, lambda: None)
    binding.update(generation=1, operationId=uuid4().hex)
    active[binding['slotApplicationId']] = {'owner': OWNER, 'target': TARGET, 'state': 'active', 'generation': 1, 'expertBinding': binding}
    sessions['token'] = {'owner': OWNER, 'project': 'project-test', 'app': 'app-test', 'environment': 'deployment:dev', 'deploymentSlot': binding['slotApplicationId'], 'deploymentGeneration': 1, 'manifest': {'capabilities': ['foundation']}}
    yield SimpleNamespace(engine=engine, svc=svc, server=server, registry=registry, hub=hub, threads=threads, root=root, descriptor=descriptor, binding=binding, active=active, sessions=sessions, users=users, enqueued=enqueued, prepared=prepared)
    await engine.close()
    store.close()


async def test_prepare_is_private_content_locked_and_idempotent(setup):
    h = setup
    same = await h.engine.prepare(OWNER, TARGET, 'project-test', h.descriptor, lambda: None)
    assert same['agentId'] == h.binding['agentId']
    assert len(h.registry.created) == 1
    assert h.registry.created[0].is_shared is False
    assert h.registry.created[0].knowledge_base_ids == []
    await h.engine.verify(OWNER, h.binding, lambda: None)
    h.registry.configs[h.binding['agentId']]['deployment_expert_marker'] = 'changed'
    with pytest.raises(StudioError, match='EXPERT_BINDING_INVALID'):
        await h.engine.verify(OWNER, h.binding, lambda: None)


async def test_run_uses_real_gateway_shape_and_persists_after_request_returns(setup):
    h = setup
    operation = uuid4().hex
    value = await h.engine.invoke(OWNER, 'token', 'expert.run', {'operationId': operation, 'text': '/not-a-platform-command'})
    assert value['run']['state'] == 'queued'
    assert len(h.enqueued) == 1
    channel, inbound = h.enqueued[0]
    assert inbound.tenant_id == h.binding['agentId']
    assert inbound.metadata['thread_id'] in h.threads.rows
    assert ':deployment:' in h.prepared[0].session_key
    run_id = value['run']['id']
    await h.hub.push_to_thread(inbound.metadata['thread_id'], {'type': 'token', 'content': 'real result'})
    await h.hub.push_to_thread(inbound.metadata['thread_id'], {'type': 'done'})
    result = await h.engine.invoke(OWNER, 'token', 'expert.tasks', {'runId': run_id})
    assert result['run']['state'] == 'succeeded'
    assert result['run']['result'] == 'real result'
    again = await h.engine.invoke(OWNER, 'token', 'expert.run', {'operationId': operation, 'text': '/not-a-platform-command'})
    assert again['run']['id'] == run_id and len(h.enqueued) == 1
    with pytest.raises(StudioError, match='EXPERT_OPERATION_CONFLICT'):
        await h.engine.invoke(OWNER, 'token', 'expert.run', {'operationId': operation, 'text': 'changed'})


def test_backend_schema_rejects_extra_fields_and_mismatched_content_version():
    template = {'resourceId': 'general-assistant', 'version': '0.0.0+sha.' + 'a' * 12, 'digest': 'sha256:' + 'a' * 64}
    value = {'schemaVersion': 1, 'format': 'wanx-expert-backend-v1', 'template': template, 'mode': 'ask'}
    assert validate_backend(value) == value
    for changed in [{**value, 'agentId': 'foreign'}, {**value, 'mode': 'execute'}, {**value, 'template': {**template, 'version': '1.0.0'}}, {**value, 'schemaVersion': True}]:
        with pytest.raises(StudioError, match='EXPERT_BACKEND_INVALID'):
            validate_backend(changed)


async def test_template_digest_covers_manifest_seed_bytes_and_rejects_symlinks(setup):
    h = setup
    first = h.engine.templates()[0]
    (h.root / 'SOUL.md').write_text('Changed seed')
    assert h.engine.templates()[0]['digest'] != first['digest']
    with pytest.raises(StudioError, match='EXPERT_TEMPLATE_CHANGED'):
        await h.engine.prepare(OWNER, TARGET, 'project-test', h.descriptor, lambda: None)
    (h.root / 'SOUL.md').unlink()
    outside = h.root.parent / 'outside.txt'
    outside.write_text('must not escape')
    (h.root / 'SOUL.md').symlink_to(outside)
    assert h.engine.templates() == []


async def test_workspace_drift_is_rejected_before_real_execution(setup):
    h = setup
    h.registry.workspaces[h.binding['agentId']].files['SOUL.md'] = b'user changed'
    with pytest.raises(StudioError, match='EXPERT_WORKSPACE_CHANGED'):
        await h.engine.invoke(OWNER, 'token', 'expert.run', {'operationId': uuid4().hex, 'text': 'hello'})
    assert not h.enqueued


async def test_prepared_private_template_stays_frozen_when_catalog_updates(setup):
    h = setup
    old_digest = h.binding['template']['digest']
    (h.root / 'SOUL.md').write_text('New template release')
    assert h.engine.templates()[0]['digest'] != old_digest
    # The running private workspace is the retained old version, not a live
    # catalog alias. A platform template update cannot silently replace it.
    await h.engine.verify(OWNER, h.binding, lambda: None)
    run = await h.engine.invoke(OWNER, 'token', 'expert.run', {'operationId': uuid4().hex, 'text': 'hello'})
    assert run['run']['state'] == 'queued'


async def test_frozen_inventory_cannot_be_changed_without_template_digest(setup):
    h = setup
    h.binding['seedInventory'][0]['digest'] = 'sha256:' + '0' * 64
    with pytest.raises(StudioError, match='EXPERT_BINDING_INVALID'):
        await h.engine.invoke(OWNER, 'token', 'expert.run', {'operationId': uuid4().hex, 'text': 'hello'})
    assert not h.enqueued


async def test_runtime_rejects_arbitrary_operations_agent_ids_and_foreign_tokens(setup):
    h = setup
    for operation, body in [('expert.run', {'operationId': uuid4().hex, 'text': 'hello', 'agentId': 'foreign'}), ('expert.tasks', {'id': 'foreign'}), ('expert.cancel', {})]:
        with pytest.raises(StudioError, match='EXPERT_INPUT_INVALID'):
            await h.engine.invoke(OWNER, 'token', operation, body)
    with pytest.raises(StudioError, match='EXPERT_OPERATION_DENIED'):
        await h.engine.invoke(OWNER, 'token', 'space.save', {})
    with pytest.raises(StudioError, match='RUNTIME_SESSION_EXPIRED'):
        await h.engine.invoke('wanx:8', 'token', 'expert.tasks', {})
    with pytest.raises(StudioError, match='EXPERT_RUN_NOT_FOUND'):
        await h.engine.invoke(OWNER, 'token', 'expert.tasks', {'runId': uuid4().hex})
    assert not h.enqueued


async def test_request_token_revocation_does_not_stop_admitted_server_run(setup):
    h = setup
    run = (await h.engine.invoke(OWNER, 'token', 'expert.run', {'operationId': uuid4().hex, 'text': 'hello'}))['run']
    session = h.sessions.pop('token')
    inbound = h.enqueued[0][1]
    await h.hub.push_to_thread(inbound.metadata['thread_id'], {'type': 'token', 'content': 'continued without client'})
    await h.hub.push_to_thread(inbound.metadata['thread_id'], {'type': 'done'})
    h.sessions['fresh-token'] = session
    read = await h.engine.invoke(OWNER, 'fresh-token', 'expert.tasks', {'runId': run['id']})
    assert read['run']['state'] == 'succeeded' and read['run']['result'] == 'continued without client'


async def test_directory_runtime_uses_platform_default_without_studio_project_lookup(setup):
    h = setup
    h.svc.model = SimpleNamespace(for_runtime=lambda value: pytest.fail('directory profile must not resolve Studio model IDs'))
    h.sessions['token'].update(project='opaque-directory-context', deploymentProfile='wanx-expert-app-v1')
    # No project row exists in the real Store. An accidental delivery.selection
    # lookup therefore fails with PROJECT_NOT_FOUND instead of being mocked out.
    value = await h.engine.invoke(OWNER, 'token', 'expert.run', {'operationId': uuid4().hex, 'text': 'hello'})
    assert value['run']['state'] == 'queued'
    assert h.prepared[0].default_model is None


async def test_new_generation_can_recover_existing_operation_without_replaying_it(setup):
    h = setup
    operation = uuid4().hex
    run = (await h.engine.invoke(OWNER, 'token', 'expert.run', {'operationId': operation, 'text': 'hello'}))['run']
    before = (await h.engine.invoke(OWNER, 'token', 'expert.tasks', {}))['context']['scopeId']
    slot = h.binding['slotApplicationId']
    h.active[slot]['generation'] = 2
    h.active[slot]['expertBinding']['generation'] = 2
    h.sessions['fresh'] = {**h.sessions['token'], 'deploymentGeneration': 2}
    with pytest.raises(StudioError, match='UPDATE_REQUIRED'):
        await h.engine.invoke(OWNER, 'token', 'expert.run', {'operationId': operation, 'text': 'hello'})
    recovered = await h.engine.invoke(OWNER, 'fresh', 'expert.run', {'operationId': operation, 'text': 'hello'})
    assert recovered['run']['id'] == run['id'] and len(h.enqueued) == 1
    read = await h.engine.invoke(OWNER, 'fresh', 'expert.tasks', {})
    assert read['context']['scopeId'] == before
    assert read['items'][0]['id'] == run['id']


async def test_deployment_admission_blocks_new_runs_but_allows_idempotent_recovery(setup):
    h = setup
    operation = uuid4().hex
    run = (await h.engine.invoke(OWNER, 'token', 'expert.run', {'operationId': operation, 'text': 'hello'}))['run']
    h.svc.deployments = SimpleNamespace(journal=SimpleNamespace(get_environment=lambda target: {'activeOperationId': 'active'}, get_operation=lambda owner, oid: {'state': 'running'}))
    assert (await h.engine.invoke(OWNER, 'token', 'expert.run', {'operationId': operation, 'text': 'hello'}))['run']['id'] == run['id']
    with pytest.raises(StudioError, match='EXPERT_DEPLOYMENT_ACTIVE'):
        await h.engine.invoke(OWNER, 'token', 'expert.run', {'operationId': uuid4().hex, 'text': 'new'})
    assert len(h.enqueued) == 1


async def test_deployment_starting_while_runtime_awaits_cannot_admit_a_late_business_run(setup, monkeypatch):
    h = setup
    started, release = asyncio.Event(), asyncio.Event()
    active = [False]
    h.svc.deployments = SimpleNamespace(journal=SimpleNamespace(get_environment=lambda target: {'activeOperationId': 'active' if active[0] else None}, get_operation=lambda owner, oid: {'state': 'running'}))

    async def start(agent_id):
        started.set()
        await release.wait()

    monkeypatch.setattr(h.registry, 'start', start)
    pending = asyncio.create_task(h.engine.invoke(OWNER, 'token', 'expert.run', {'operationId': uuid4().hex, 'text': 'hello'}))
    await asyncio.wait_for(started.wait(), 2)
    active[0] = True
    release.set()
    with pytest.raises(StudioError, match='EXPERT_DEPLOYMENT_ACTIVE'):
        await pending
    assert not h.enqueued
    assert (await h.engine.invoke(OWNER, 'token', 'expert.tasks', {}))['items'] == []


async def test_dev_prod_bindings_and_results_are_separate(setup):
    h = setup
    operation = uuid4().hex
    dev = (await h.engine.invoke(OWNER, 'token', 'expert.run', {'operationId': operation, 'text': 'hello'}))['run']
    prod_target = {**TARGET, 'environment': 'prod'}
    prod_binding = await h.engine.prepare(OWNER, prod_target, 'project-test', h.descriptor, lambda: None)
    prod_binding.update(generation=1, operationId=uuid4().hex)
    h.active[prod_binding['slotApplicationId']] = {'owner': OWNER, 'target': prod_target, 'generation': 1, 'state': 'active', 'expertBinding': prod_binding}
    h.sessions['prod'] = {**h.sessions['token'], 'deploymentSlot': prod_binding['slotApplicationId'], 'environment': 'deployment:prod'}
    assert prod_binding['agentId'] != h.binding['agentId']
    assert (await h.engine.invoke(OWNER, 'prod', 'expert.tasks', {}))['items'] == []
    with pytest.raises(StudioError, match='EXPERT_RUN_NOT_FOUND'):
        await h.engine.invoke(OWNER, 'prod', 'expert.cancel', {'runId': dev['id']})
    prod = (await h.engine.invoke(OWNER, 'prod', 'expert.run', {'operationId': operation, 'text': 'hello'}))['run']
    assert prod['id'] != dev['id']
    dev_scope = (await h.engine.invoke(OWNER, 'token', 'expert.tasks', {}))['context']['scopeId']
    prod_scope = (await h.engine.invoke(OWNER, 'prod', 'expert.tasks', {}))['context']['scopeId']
    assert dev_scope != prod_scope


async def test_probe_is_durable_idempotent_and_independent_of_runtime_session(setup):
    h = setup
    h.active.clear()
    operation = uuid4().hex
    run = await h.engine.probe(OWNER, h.binding, operation, lambda: None)
    assert run['state'] == 'queued' and h.engine.busy(OWNER, h.binding['slotApplicationId'])
    inbound = h.enqueued[0][1]
    await h.hub.push_to_thread(inbound.metadata['thread_id'], {'type': 'token', 'content': 'WANX_EXPERT_READY'})
    await h.hub.push_to_thread(inbound.metadata['thread_id'], {'type': 'done'})
    recovered = await h.engine.probe(OWNER, h.binding, operation, lambda: None)
    assert recovered['id'] == run['id'] and recovered['state'] == 'succeeded'
    assert not h.engine.busy(OWNER, h.binding['slotApplicationId']) and len(h.enqueued) == 1


async def test_probe_uses_frozen_verification_input_and_never_replays_a_changed_input(setup):
    h = setup
    operation = uuid4().hex
    text = '请只回复 FROZEN_VERIFICATION_OK'
    first = await h.engine.probe(OWNER, h.binding, operation, lambda: None, text=text)
    assert h.prepared[0].text.endswith(text)
    assert 'WANX_EXPERT_READY' not in h.prepared[0].text
    same = await h.engine.probe(OWNER, h.binding, operation, lambda: None, text=text)
    assert same['id'] == first['id'] and len(h.enqueued) == 1
    with pytest.raises(StudioError, match='EXPERT_OPERATION_CONFLICT'):
        await h.engine.probe(OWNER, h.binding, operation, lambda: None, text='changed verification input')
    assert len(h.enqueued) == 1


@pytest.mark.parametrize('text', ['', '   ', 'x' * 4001, ' ' * 4001 + 'x', None, False])
async def test_probe_rejects_missing_or_oversized_verification_input(setup, text):
    h = setup
    with pytest.raises(StudioError, match='EXPERT_INPUT_INVALID'):
        await h.engine.probe(OWNER, h.binding, uuid4().hex, lambda: None, text=text)
    assert not h.enqueued


@pytest.mark.parametrize('frame,code', [({'type': 'error', 'message': 'secret upstream detail'}, 'EXPERT_EXECUTION_FAILED'), ({'type': 'hitl_required'}, 'EXPERT_APPROVAL_REQUIRED'), ({'type': 'done'}, 'EXPERT_EMPTY_RESULT')])
async def test_terminal_gateway_errors_never_become_success_or_expose_raw_detail(setup, frame, code):
    h = setup
    run = (await h.engine.invoke(OWNER, 'token', 'expert.run', {'operationId': uuid4().hex, 'text': 'hello'}))['run']
    await h.hub.push_to_thread(h.enqueued[0][1].metadata['thread_id'], frame)
    result = (await h.engine.invoke(OWNER, 'token', 'expert.tasks', {'runId': run['id']}))['run']
    assert result['state'] == 'failed' and result['errorCode'] == code
    assert 'secret upstream' not in json.dumps(result)


async def test_cancel_only_claims_requested_until_gateway_finishes_and_checks_scope(setup):
    h = setup
    run = (await h.engine.invoke(OWNER, 'token', 'expert.run', {'operationId': uuid4().hex, 'text': 'hello'}))['run']
    cancelled = await h.engine.invoke(OWNER, 'token', 'expert.cancel', {'runId': run['id']})
    assert cancelled['run']['state'] == 'cancel_requested'
    assert h.registry.cancelled == [(h.binding['agentId'], run['id'])]
    await h.hub.push_to_thread(run['id'], {'type': 'done'})
    assert (await h.engine.invoke(OWNER, 'token', 'expert.tasks', {'runId': run['id']}))['run']['state'] == 'cancelled'


async def test_user_revocation_interrupts_callback_and_never_uses_old_request_identity(setup):
    h = setup
    run = (await h.engine.invoke(OWNER, 'token', 'expert.run', {'operationId': uuid4().hex, 'text': 'hello'}))['run']
    h.users[7].disabled = True
    await h.hub.push_to_thread(run['id'], {'type': 'token', 'content': 'must not publish'})
    with pytest.raises(StudioError, match='EXPERT_IDENTITY_REQUIRED'):
        await h.engine.invoke(OWNER, 'token', 'expert.tasks', {'runId': run['id']})
    h.users[7].disabled = False
    result = (await h.engine.invoke(OWNER, 'token', 'expert.tasks', {'runId': run['id']}))['run']
    assert result['state'] == 'interrupted' and result['result'] is None
    assert h.registry.cancelled == [(h.binding['agentId'], run['id'])]


async def test_timeout_is_interrupted_and_detaches_the_box_callback(setup):
    h = setup
    h.engine.run_timeout = 0.01
    run = (await h.engine.invoke(OWNER, 'token', 'expert.run', {'operationId': uuid4().hex, 'text': 'hello'}))['run']
    await asyncio.sleep(0.03)
    result = (await h.engine.invoke(OWNER, 'token', 'expert.tasks', {'runId': run['id']}))['run']
    assert result['state'] == 'interrupted' and result['errorCode'] == 'EXPERT_RUN_TIMEOUT'
    assert not h.hub.has_subscribers(run['id'])
    assert not h.engine.busy(OWNER, h.binding['slotApplicationId'])


@pytest.mark.parametrize('prepare_fails', [False, True])
async def test_timeout_during_preparation_blocks_late_enqueue_and_preserves_terminal_result(setup, monkeypatch, prepare_fails):
    import octop.api.routers.chat.turn as turns
    h = setup
    started, release = asyncio.Event(), asyncio.Event()
    original = turns.prepare_dashboard_turn

    async def delayed_prepare(server, *, agent_id, user, turn):
        started.set()
        await release.wait()
        if prepare_fails:
            raise RuntimeError('synthetic late preparation failure')
        return await original(server, agent_id=agent_id, user=user, turn=turn)

    monkeypatch.setattr(turns, 'prepare_dashboard_turn', delayed_prepare)
    h.engine.run_timeout = 0.01
    pending = asyncio.create_task(h.engine.invoke(OWNER, 'token', 'expert.run', {'operationId': uuid4().hex, 'text': 'hello'}))
    await asyncio.wait_for(started.wait(), 2)
    await asyncio.sleep(0.03)
    before = (await h.engine.invoke(OWNER, 'token', 'expert.tasks', {}))['items'][0]
    assert before['state'] == 'interrupted' and before['errorCode'] == 'EXPERT_RUN_TIMEOUT'
    release.set()
    if prepare_fails:
        with pytest.raises(StudioError, match='EXPERT_START_FAILED'):
            await pending
    else:
        assert (await pending)['run'] == before
    after = (await h.engine.invoke(OWNER, 'token', 'expert.tasks', {'runId': before['id']}))['run']
    assert after == before
    assert not h.enqueued and not h.hub._connections and not h.engine._timers


async def test_close_during_turn_preparation_cancels_unregistered_timer_and_blocks_late_enqueue(setup, monkeypatch):
    import octop.api.routers.chat.turn as turns
    h = setup
    started, release = asyncio.Event(), asyncio.Event()
    original = turns.prepare_dashboard_turn

    async def delayed_prepare(server, *, agent_id, user, turn):
        started.set()
        await release.wait()
        return await original(server, agent_id=agent_id, user=user, turn=turn)

    monkeypatch.setattr(turns, 'prepare_dashboard_turn', delayed_prepare)
    pending = asyncio.create_task(h.engine.invoke(OWNER, 'token', 'expert.run', {'operationId': uuid4().hex, 'text': 'hello'}))
    await asyncio.wait_for(started.wait(), 2)
    # No hub connection exists yet, but a durable queued run and timeout do.
    assert not h.hub._connections
    await asyncio.wait_for(h.engine.close(), 0.2)
    row = h.svc.store.db.execute('SELECT body FROM deployment_expert_runs').fetchone()
    assert json.loads(row[0])['state'] == 'interrupted'

    # Represent a store already closed by the enclosing server. The resumed
    # preparation must not even try another transaction, much less enqueue.
    def closed_transaction():
        pytest.fail('late preparation accessed the closed Store')

    with monkeypatch.context() as patch:
        patch.setattr(h.svc.store, 'transaction', closed_transaction)
        release.set()
        with pytest.raises(StudioError, match='EXPERT_START_FAILED'):
            await pending
    assert not h.enqueued and not h.hub._connections


async def test_crash_snapshot_recovery_marks_unknown_and_never_reenqueues(setup, tmp_path):
    import sqlite3
    h = setup
    run = (await h.engine.invoke(OWNER, 'token', 'expert.run', {'operationId': uuid4().hex, 'text': 'hello'}))['run']
    crash_root = tmp_path / 'crash-copy'
    crash_root.mkdir()
    copy = sqlite3.connect(crash_root / 'studio.sqlite')
    h.svc.store.db.backup(copy)
    copy.close()
    await h.engine.close()
    store = Store(crash_root)
    svc = SimpleNamespace(**{**vars(h.svc), 'store': store})
    reopened = ExpertRuntime(svc, h.server)
    try:
        value = await reopened.invoke(OWNER, 'token', 'expert.tasks', {'runId': run['id']})
        assert value['run']['state'] == 'interrupted'
        assert value['run']['errorCode'] == 'EXPERT_SERVICE_RESTARTED'
        assert len(h.enqueued) == 1
    finally:
        await reopened.close()
        store.close()
