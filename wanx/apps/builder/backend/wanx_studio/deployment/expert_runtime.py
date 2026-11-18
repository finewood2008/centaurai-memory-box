"""Box-held expert execution for a frozen application/environment binding.

Only trusted deployment preparation supplies a template or instance. Renderer
calls contain business text and an idempotency key, never an agent or route.
"""
from __future__ import annotations

import asyncio
from contextvars import Context
from copy import deepcopy
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import time
from uuid import uuid4

from jsonschema import Draft7Validator

from ..contracts import StudioError
from ..upgrade_guard import background_lock
from .contracts import canonicalize_json

PROFILE = 'wanx-expert-app-v1'
_SCHEMA = Draft7Validator(json.loads((Path(__file__).parent / 'schemas' / 'expert-backend.schema.json').read_text()))
_HEX = re.compile(r'^[a-f0-9]{32}$')
_OWNER = re.compile(r'^wanx:([1-9][0-9]*)$')
_PATH = re.compile(r'^[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)*$')
_TERMINAL = frozenset({'succeeded', 'failed', 'cancelled', 'interrupted'})
_PUBLIC = ('id', 'state', 'text', 'result', 'errorCode', 'createdAt', 'updatedAt')
_MAX_RESULT = 1024 * 1024
_MAX_SEED = 16 * 1024 * 1024


def _sha(value):
    return 'sha256:' + hashlib.sha256(canonicalize_json(value).encode()).hexdigest()


def validate_backend(value):
    try:
        value = json.loads(canonicalize_json(value))
        if not _SCHEMA.is_valid(value):
            raise ValueError()
        if value['template']['version'] != '0.0.0+sha.' + value['template']['digest'][7:19]:
            raise ValueError()
    except (ValueError, TypeError, StudioError):
        raise StudioError('EXPERT_BACKEND_INVALID', 422) from None
    return value


class ExpertRuntime:
    def __init__(self, svc, server, *, clock=time.time, run_timeout=300, authority=None):
        self.svc, self.server, self.clock = svc, server, clock
        self.authority=authority
        self.registry = server.app_runtime.agent_registry
        self.gateway = server.app_runtime.gateway
        self.catalog = server.expert_catalog
        self.closed, self.run_timeout = False, run_timeout
        self._connections, self._timers, self._prepare_locks = {}, {}, {}
        self._upgrade_locks = {}
        with self.svc.store.transaction():
            self.svc.store.db.execute('CREATE TABLE IF NOT EXISTS deployment_expert_runs(id TEXT PRIMARY KEY, owner TEXT NOT NULL, scope TEXT NOT NULL, operation_id TEXT NOT NULL, input_digest TEXT NOT NULL, body TEXT NOT NULL, UNIQUE(owner,scope,operation_id))')
            for row in self.svc.store.db.execute('SELECT body FROM deployment_expert_runs').fetchall():
                run = json.loads(row[0])
                if run['state'] not in _TERMINAL:
                    run.update(state='interrupted', errorCode='EXPERT_SERVICE_RESTARTED', updatedAt=self.clock())
                    self._save(run)

    def _user(self, owner):
        match = _OWNER.fullmatch(owner) if isinstance(owner, str) else None
        if self.closed or not match:
            raise StudioError('EXPERT_IDENTITY_REQUIRED', 403)
        if self.authority:
            try:self.authority(owner)
            except Exception:raise StudioError('EXPERT_IDENTITY_REQUIRED',403) from None
        uid = int(match[1])
        row = self.server.services.user_repo.get(uid)
        user = self.server.user_manager.get_by_id(uid)
        if row is None or getattr(row, 'disabled', False) or user is None or getattr(user, 'disabled', False) or getattr(user, 'local_data', False):
            raise StudioError('EXPERT_IDENTITY_REQUIRED', 403)
        return user

    def _snapshot(self, resource_id):
        expert = self.catalog.get(resource_id) if self.catalog else None
        if expert is None:
            raise StudioError('EXPERT_TEMPLATE_UNAVAILABLE', 409)
        root = Path(self.catalog.expert_dir(resource_id))
        names = sorted(set(['manifest.json', *expert.files]))
        if len(names) > 512:
            raise StudioError('EXPERT_TEMPLATE_UNAVAILABLE', 409)
        files, total = {}, 0
        try:
            if root.is_symlink() or not root.is_dir():
                raise ValueError()
            for name in names:
                if not isinstance(name, str) or not _PATH.fullmatch(name) or any(part in {'.', '..'} for part in name.split('/')):
                    raise ValueError()
                path = root
                for part in name.split('/'):
                    path = path / part
                    if path.is_symlink():
                        raise ValueError()
                fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
                with os.fdopen(fd, 'rb') as stream:
                    info = os.fstat(stream.fileno())
                    if not stat.S_ISREG(info.st_mode) or info.st_size > _MAX_SEED:
                        raise ValueError()
                    content = stream.read(_MAX_SEED + 1)
                total += len(content)
                if total > _MAX_SEED or len(content) != info.st_size:
                    raise ValueError()
                files[name] = content
        except (OSError, ValueError, TypeError):
            raise StudioError('EXPERT_TEMPLATE_UNAVAILABLE', 409) from None
        # This inventory includes binary seed bytes via their SHA, and the exact
        # manifest bytes. Display-only lazy catalog readers silently skip files.
        inventory = self._inventory(resource_id, files)
        digest = _sha(inventory)
        template = {'resourceId': resource_id, 'version': '0.0.0+sha.' + digest[7:19], 'digest': digest}
        return expert, template, files

    @staticmethod
    def _inventory(resource_id, files):
        return {'format': 'wanx-expert-template-content-v1', 'resourceId': resource_id,
                'files': [{'path': name, 'digest': 'sha256:' + hashlib.sha256(content).hexdigest(), 'sizeBytes': len(content)} for name, content in sorted(files.items())]}

    def _frozen_inventory(self, binding):
        rows = binding.get('seedInventory')
        if not isinstance(rows, list) or not 1 <= len(rows) <= 512:
            raise StudioError('EXPERT_BINDING_INVALID', 409)
        names, total = [], 0
        for row in rows:
            if not isinstance(row, dict) or set(row) != {'path', 'digest', 'sizeBytes'} or not isinstance(row['path'], str) or not _PATH.fullmatch(row['path']) or any(part in {'.', '..'} for part in row['path'].split('/')) or not isinstance(row['digest'], str) or not re.fullmatch(r'sha256:[a-f0-9]{64}', row['digest']) or type(row['sizeBytes']) is not int or row['sizeBytes'] < 0:
                raise StudioError('EXPERT_BINDING_INVALID', 409)
            names.append(row['path'])
            total += row['sizeBytes']
        if names != sorted(set(names)) or 'manifest.json' not in names or total > _MAX_SEED or _sha({'format': 'wanx-expert-template-content-v1', 'resourceId': binding['template']['resourceId'], 'files': rows}) != binding['template']['digest']:
            raise StudioError('EXPERT_BINDING_INVALID', 409)
        return rows

    def templates(self):
        result = []
        if self.closed or not self.catalog:
            return result
        for summary in self.catalog.list_summaries():
            try:
                _, template, _ = self._snapshot(summary.id)
            except StudioError:
                continue
            result.append({**template, 'name': summary.label_zh or summary.label_en or summary.id})
        return result

    def _expected_paths(self, agent_id):
        from octop.infra.agents.workspace.dir import scoped_workspace_dir_str
        return {'type': 'filesystem', 'root_dir': str(self.server.paths.agent_workspace(agent_id)), 'virtual_mode': True}, scoped_workspace_dir_str(agent_id)

    def _binding(self, owner, target, project_id, descriptor):
        marker = _sha([owner, target, project_id, descriptor])
        return {'schemaVersion': 1, 'profile': PROFILE, 'owner': owner, 'target': deepcopy(target), 'projectId': project_id,
                'slotApplicationId': self.svc.deployment_profile.slot_id(owner, target), 'descriptorDigest': _sha(descriptor),
                'template': deepcopy(descriptor['template']), 'agentId': 'wxdep' + marker[7:39], 'marker': marker}

    def _assert_agent(self, owner, binding):
        user = self._user(owner)
        descriptor = validate_backend({'schemaVersion': 1, 'format': 'wanx-expert-backend-v1', 'template': binding['template'], 'mode': 'ask'})
        expected = self._binding(owner, binding['target'], binding['projectId'], descriptor)
        if any(binding.get(key) != value for key, value in expected.items()):
            raise StudioError('EXPERT_BINDING_INVALID', 409)
        self._frozen_inventory(binding)
        row = self.registry.get_row(binding['agentId'])
        config = self.registry.get_config(binding['agentId'])
        backend, workspace = self._expected_paths(binding['agentId'])
        if row is None or row.user_id != user.id or row.is_shared or row.application_id != 'wanx' or row.template_name != binding['template']['resourceId'] or getattr(row, 'disabled', False) or config.get('deployment_expert_marker') != binding['marker'] or config.get('deployment_expert_descriptor') != binding['descriptorDigest'] or config.get('backend') != backend or config.get('workspace_dir') != workspace or config.get('skill_package_ids') or config.get('knowledge_base_ids') or config.get('mcp_servers'):
            raise StudioError('EXPERT_BINDING_INVALID', 409)
        return user

    async def prepare(self, owner, target, project_id, descriptor, guard):
        lock = await background_lock(self.svc.store.root) if os.name == 'posix' else None
        try:
            return await self._prepare(owner, target, project_id, descriptor, guard)
        finally:
            if lock:
                lock.close()

    async def _prepare(self, owner, target, project_id, descriptor, guard):
        descriptor = validate_backend(descriptor)
        self._user(owner)
        binding = self._binding(owner, target, project_id, descriptor)
        lock = self._prepare_locks.setdefault(binding['agentId'], asyncio.Lock())
        async with lock:
            guard()
            expert, template, files = self._snapshot(descriptor['template']['resourceId'])
            if template != descriptor['template']:
                raise StudioError('EXPERT_TEMPLATE_CHANGED', 409)
            binding['seedInventory'] = self._inventory(template['resourceId'], files)['files']
            if self.registry.get_row(binding['agentId']) is None:
                from octop.infra.agents.experts.catalog import build_create_spec_from_expert, WORKSPACE_MANIFEST_PATH
                backend, workspace_dir = self._expected_paths(binding['agentId'])
                spec = build_create_spec_from_expert(expert_id=template['resourceId'], expert=expert, user_id=self._user(owner).id,
                    name=(expert.summary.label_zh or expert.summary.label_en or template['resourceId'])[:60] + ' · ' + binding['marker'][7:23],
                    agent_id=binding['agentId'], config_extra={'backend': backend, 'workspace_dir': workspace_dir,
                    'deployment_expert_marker': binding['marker'], 'deployment_expert_descriptor': binding['descriptorDigest']},
                    skill_package_ids=[], knowledge_base_ids=[], mcp_servers=[])

                async def initialize(row, workspace):
                    for name, content in files.items():
                        guard()
                        await workspace.aupload_bytes(WORKSPACE_MANIFEST_PATH if name == 'manifest.json' else name, content)
                        guard()

                # Do not hold Store transactions across any AgentManager await.
                await self.registry.create(spec, workspace_initializer=initialize, before_side_effect=guard)
            await self.verify(owner, binding, guard)
        return binding

    async def verify(self, owner, binding, guard):
        guard()
        self._assert_agent(owner, binding)
        from octop.infra.agents.experts.catalog import WORKSPACE_MANIFEST_PATH
        workspace = self.registry.workspace_for_agent(binding['agentId'])
        if workspace is None:
            raise StudioError('EXPERT_RUNTIME_UNAVAILABLE', 409)
        for row in self._frozen_inventory(binding):
            guard()
            name = row['path']
            try:
                actual = await workspace.adownload_bytes(WORKSPACE_MANIFEST_PATH if name == 'manifest.json' else name)
            except (OSError, KeyError, ValueError):
                raise StudioError('EXPERT_WORKSPACE_CHANGED', 409) from None
            if not isinstance(actual, bytes) or len(actual) != row['sizeBytes'] or 'sha256:' + hashlib.sha256(actual).hexdigest() != row['digest']:
                raise StudioError('EXPERT_WORKSPACE_CHANGED', 409)
        guard()
        self._assert_agent(owner, binding)

    def _runtime_binding(self, owner, token):
        raw_session=getattr(self.svc,'runtime_sessions',{}).get(token,{})
        if raw_session.get('standardExpertContract'):
            from .standard_runtime import assert_session
            session=assert_session(self.svc,owner,token)
        else:
            self.svc.authorize_management(owner)
            session=self.svc.runtime(owner,token)
        binding = self.svc.deployment_profile.find_binding(owner, session.get('deploymentSlot'))
        expert = binding.get('expertBinding') if binding else None
        from .standard_client import is_standard,RUNTIME_CONTRACT
        standard=is_standard(binding.get('base')) if binding else False
        allowed=('http.request' in session['manifest']['capabilities'] and session.get('standardExpertContract')==RUNTIME_CONTRACT) if standard else 'foundation' in session['manifest']['capabilities']
        if not allowed or not expert or binding['state'] != 'active' or binding['owner'] != owner or binding['generation'] != session.get('deploymentGeneration') or expert.get('generation') != session.get('deploymentGeneration') or expert['target'] != binding['target'] or expert['target']['applicationId'] != session['app'] or 'deployment:' + expert['target']['environment'] != session['environment']:
            raise StudioError('EXPERT_BINDING_INVALID', 409)
        self._assert_agent(owner, expert)
        return session, deepcopy(expert)

    def _read(self, run_id):
        row = self.svc.store.db.execute('SELECT body FROM deployment_expert_runs WHERE id=?', (run_id,)).fetchone()
        return json.loads(row[0]) if row else None

    def _save(self, run):
        self.svc.store.db.execute('INSERT INTO deployment_expert_runs VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body',
            (run['id'], run['owner'], run['scope'], run['operationId'], run['inputDigest'], json.dumps(run, ensure_ascii=False)))

    @staticmethod
    def _public(run):
        return {key: deepcopy(run[key]) for key in _PUBLIC}

    def _scope(self, owner, binding, purpose):
        # A saved operation ID may survive an application upgrade. Reusing it
        # returns the admitted run; generation must never turn it into a replay.
        return _sha([owner, binding['target'], binding['slotApplicationId'], purpose])

    def _owned_run(self, owner, binding, run_id):
        if not isinstance(run_id, str) or not _HEX.fullmatch(run_id):
            raise StudioError('EXPERT_INPUT_INVALID', 422)
        run = self._read(run_id)
        if not run or run['owner'] != owner or run['scope'] != self._scope(owner, binding, 'run'):
            raise StudioError('EXPERT_RUN_NOT_FOUND', 404)
        return run

    def _admit_business_run(self, owner, binding, purpose):
        if purpose != 'run':
            return
        journal = getattr(getattr(self.svc, 'deployments', None), 'journal', None)
        if journal:
            environment = journal.get_environment(binding['target'])
            operation_id = environment.get('activeOperationId')
            if operation_id:
                operation = journal.get_operation(owner, operation_id)
                if operation['state'] not in {'succeeded', 'rejected', 'failed_recovered', 'failed_degraded', 'recovery_required'}:
                    raise StudioError('EXPERT_DEPLOYMENT_ACTIVE', 409)

    async def invoke(self, owner, token, operation, body):
        if self.closed:
            raise StudioError('EXPERT_RUNTIME_UNAVAILABLE', 409)
        session, binding = self._runtime_binding(owner, token)
        guard = lambda: self._runtime_binding(owner, token)
        if not isinstance(body, dict):
            raise StudioError('EXPERT_INPUT_INVALID', 422)
        if operation == 'expert.run':
            if set(body) != {'operationId', 'text'} or not isinstance(body['operationId'], str) or not _HEX.fullmatch(body['operationId']) or not isinstance(body['text'], str) or not body['text'].strip() or len(body['text']) > 12000:
                raise StudioError('EXPERT_INPUT_INVALID', 422)
            return {'run': await self._start(owner, binding, body['operationId'], body['text'], 'run', guard, session)}
        if operation == 'expert.tasks':
            if set(body) not in (set(), {'runId'}):
                raise StudioError('EXPERT_INPUT_INVALID', 422)
            with self.svc.store.transaction():
                guard()
                context = {'scopeId': self._scope(owner, binding, 'run')[7:]}
                if body:
                    return {'run': self._public(self._owned_run(owner, binding, body['runId'])), 'context': context}
                rows = self.svc.store.db.execute('SELECT body FROM deployment_expert_runs WHERE owner=? AND scope=? ORDER BY rowid DESC LIMIT 50', (owner, self._scope(owner, binding, 'run'))).fetchall()
                return {'items': [self._public(json.loads(row[0])) for row in rows], 'context': context}
        if operation == 'expert.cancel':
            if set(body) != {'runId'}:
                raise StudioError('EXPERT_INPUT_INVALID', 422)
            with self.svc.store.transaction():
                guard()
                run = self._owned_run(owner, binding, body['runId'])
                if run['state'] not in _TERMINAL:
                    if run['binding']['marker'] != binding['marker']:
                        raise StudioError('EXPERT_BINDING_INVALID', 409)
                    run.update(state='cancel_requested', updatedAt=self.clock())
                    self._save(run)
            if run['state'] == 'cancel_requested':
                self.registry.cancel_stream(run['binding']['agentId'], run['threadId'])
            return {'run': self._public(run)}
        raise StudioError('EXPERT_OPERATION_DENIED', 403)

    def _model_ref(self, session):
        # Directory releases have an opaque deployment context, not a mutable
        # Studio project. Their first profile uses the platform's live default.
        if session is None or session.get('deploymentProfile') == PROFILE or self.svc.model is None:
            return None
        from ..delivery import selection
        selected = selection(self.svc, session)
        if selected is None:
            return None
        pair = self.svc.model.for_runtime(selected).resolve()
        if pair is None:
            raise StudioError('RUNTIME_MODEL_UNAVAILABLE', 409)
        return pair[0].id + '/' + pair[1].id

    async def probe(self, owner, binding, operation_id, guard, *, text='请只回复 WANX_EXPERT_READY'):
        if not isinstance(operation_id, str) or not _HEX.fullmatch(operation_id) or not isinstance(text, str) or not text.strip() or len(text) > 4000:
            raise StudioError('EXPERT_INPUT_INVALID', 422)
        return await self._start(owner, binding, operation_id, text, 'probe', guard, None)

    async def _start(self, owner, binding, operation_id, text, purpose, guard, session):
        lock = await background_lock(self.svc.store.root) if os.name == 'posix' else None
        try:
            return await self._start_guarded(owner, binding, operation_id, text, purpose, guard, session)
        finally:
            if lock:
                lock.close()

    async def _start_guarded(self, owner, binding, operation_id, text, purpose, guard, session):
        if type(binding.get('generation')) is not int or binding['generation'] < 1:
            raise StudioError('EXPERT_BINDING_INVALID', 409)
        scope, input_digest = self._scope(owner, binding, purpose), _sha({'text': text})
        with self.svc.store.transaction():
            guard()
            self._assert_agent(owner, binding)
            old = self.svc.store.db.execute('SELECT body,input_digest FROM deployment_expert_runs WHERE owner=? AND scope=? AND operation_id=?', (owner, scope, operation_id)).fetchone()
            if old:
                if old[1] != input_digest:
                    raise StudioError('EXPERT_OPERATION_CONFLICT', 409)
                return self._public(json.loads(old[0]))
            self._admit_business_run(owner, binding, purpose)
        await self.verify(owner, binding, guard)
        if self.closed:
            raise StudioError('EXPERT_RUNTIME_UNAVAILABLE', 409)
        await self.registry.start(binding['agentId'])
        if self.closed:
            raise StudioError('EXPERT_RUNTIME_UNAVAILABLE', 409)
        model_ref = self._model_ref(session)
        from octop.api.routers.chat.models import ChatTurnBody
        from octop.api.routers.chat.turn import prepare_dashboard_turn, build_dashboard_inbound
        from octop.infra.gateway.ws import WS_CHANNEL_ID
        from octop.infra.gateway.threads import ThreadRegistry
        run_id = uuid4().hex
        run = {'id': run_id, 'owner': owner, 'scope': scope, 'operationId': operation_id, 'inputDigest': input_digest,
               'purpose': purpose, 'binding': deepcopy(binding), 'generation': binding['generation'], 'threadId': run_id,
               'state': 'queued', 'text': text, 'result': None, 'errorCode': None, 'createdAt': self.clock(), 'updatedAt': self.clock()}
        with self.svc.store.transaction():
            guard()
            self._assert_agent(owner, binding)
            # A concurrent request may have won while prepare/start awaited.
            old = self.svc.store.db.execute('SELECT body,input_digest FROM deployment_expert_runs WHERE owner=? AND scope=? AND operation_id=?', (owner, scope, operation_id)).fetchone()
            if old:
                if old[1] != input_digest:
                    raise StudioError('EXPERT_OPERATION_CONFLICT', 409)
                return self._public(json.loads(old[0]))
            self._admit_business_run(owner, binding, purpose)
            count = self.svc.store.db.execute("SELECT count(*) FROM deployment_expert_runs WHERE owner=? AND scope=? AND json_extract(body,'$.state') IN ('queued','running','cancel_requested')", (owner, scope)).fetchone()[0]
            if count >= 4:
                raise StudioError('EXPERT_BUSY', 409)
            self._save(run)
        self._timers[run_id] = asyncio.create_task(self._expire(run_id), context=Context())
        connection_id = 'deployment-expert-' + run_id
        dispatched = False
        try:
            guard()
            self.gateway.thread_registry.create_thread(agent_id=binding['agentId'], user_id=self._user(owner).id, channel_type=ThreadRegistry.CHANNEL_DASHBOARD,
                session_key=binding['agentId'] + ':deployment:' + run_id, title='应用专家调用', thread_id=run_id)
            # Prefixing user text prevents slash commands from becoming a
            # platform management action. No tool, route or agent comes from UI.
            turn = ChatTurnBody(text='应用业务输入（仅作为普通文本处理）：\n' + text, thread_id=run_id,
                session_key=binding['agentId'] + ':deployment:' + run_id, conversation_mode='ask',
                mcp_servers=[], skills=[], knowledge_base_ids=[], target_agent_ids=[], default_model=model_ref)
            prepared = await prepare_dashboard_turn(self.server, agent_id=binding['agentId'], user=self._user(owner), turn=turn)
            if self.closed:
                raise StudioError('EXPERT_RUNTIME_UNAVAILABLE', 409)
            guard()
            self._assert_agent(owner, binding)

            async def on_frame(frame):
                await self._frame(run_id, frame)

            self.gateway.ws_hub.register(connection_id, on_frame)
            self.gateway.ws_hub.subscribe(prepared.thread_id, connection_id)
            self._connections[run_id] = connection_id
            inbound = build_dashboard_inbound(agent_id=binding['agentId'], user_id=self._user(owner).id, prepared=prepared, turn=turn, ws_connection_id=connection_id, user_is_admin=False)
            # Acquire before the final persisted-state check: acquisition awaits,
            # and a timeout or shutdown may win while that await is pending.
            if os.name == 'posix':
                self._upgrade_locks[run_id] = await background_lock(self.svc.store.root)
            if self.closed:
                raise StudioError('EXPERT_RUNTIME_UNAVAILABLE', 409)
            with self.svc.store.transaction():
                guard()
                saved = self._read(run_id)
                if saved['state'] in _TERMINAL:
                    # Turn preparation can outlive the run timeout. A late
                    # result must not restart an already interrupted request.
                    self._detach(run_id, confirmed=True)
                    return self._public(saved)
                if saved['state'] == 'cancel_requested':
                    saved.update(state='cancelled', updatedAt=self.clock())
                    self._save(saved)
                    self._detach(run_id, confirmed=True)
                    return self._public(saved)
            # A transport enqueue failure may already have dispatched the turn.
            dispatched = True
            self.gateway.channel_manager.enqueue(WS_CHANNEL_ID, inbound)
        except BaseException as error:
            self._detach(run_id, confirmed=not dispatched)
            if not self.closed:
                with self.svc.store.transaction():
                    saved = self._read(run_id)
                    if saved['state'] not in _TERMINAL:
                        saved.update(state='failed', errorCode='EXPERT_START_FAILED', updatedAt=self.clock())
                        self._save(saved)
            if isinstance(error, asyncio.CancelledError):
                raise
            raise StudioError('EXPERT_START_FAILED', 409) from None
        return self._public(run)

    def _live_run(self, run):
        self._assert_agent(run['owner'], run['binding'])
        if run['purpose'] == 'run':
            binding = self.svc.deployment_profile.find_binding(run['owner'], run['binding']['slotApplicationId'])
            current = binding.get('expertBinding') if binding else None
            if not current or binding.get('state') != 'active' or current.get('marker') != run['binding']['marker'] or binding.get('generation') != run['generation']:
                raise StudioError('EXPERT_BINDING_INVALID', 409)
        else:
            operation_id = run['binding'].get('operationId')
            journal = getattr(getattr(self.svc, 'deployments', None), 'journal', None)
            if operation_id and journal:
                operation = journal.get_operation(run['owner'], operation_id)
                if operation['target'] != run['binding']['target'] or operation['state'] in {'rejected', 'failed_recovered', 'failed_degraded', 'recovery_required', 'compensating'}:
                    raise StudioError('EXPERT_BINDING_INVALID', 409)

    async def _frame(self, run_id, frame):
        if self.closed or not isinstance(frame, dict):
            return
        terminal = False
        cancel = None
        with self.svc.store.transaction():
            run = self._read(run_id)
            if not run or frame.get('thread_id', run['threadId']) != run['threadId']:
                return
            if run['state'] in _TERMINAL:
                if frame.get('type') in {'done', 'error'}:
                    self._detach(run_id, confirmed=True)
                return
            try:
                self._live_run(run)
            except StudioError:
                run.update(state='interrupted', errorCode='EXPERT_BINDING_CHANGED')
                terminal = True
            kind = frame.get('type')
            if not terminal and kind == 'token' and isinstance(frame.get('content'), str):
                result = (run['result'] or '') + frame['content']
                if len(result.encode()) > _MAX_RESULT:
                    run.update(state='failed', errorCode='EXPERT_RESULT_TOO_LARGE')
                    terminal = True
                else:
                    run['result'] = result
                    if run['state'] != 'cancel_requested':
                        run['state'] = 'running'
            elif not terminal and kind == 'error':
                run.update(state='failed', errorCode='EXPERT_EXECUTION_FAILED')
                terminal = True
            elif not terminal and kind in {'hitl_required', 'approval_required'}:
                run.update(state='failed', errorCode='EXPERT_APPROVAL_REQUIRED')
                terminal = True
            elif not terminal and kind == 'done':
                if run['state'] == 'cancel_requested':
                    run.update(state='cancelled', errorCode=None)
                elif run['result']:
                    run.update(state='succeeded', errorCode=None)
                else:
                    run.update(state='failed', errorCode='EXPERT_EMPTY_RESULT')
                terminal = True
            if run['state'] == 'cancel_requested' and kind == 'token':
                cancel = (run['binding']['agentId'], run['threadId'])
            elif terminal and run['state'] in {'failed', 'interrupted'} and kind != 'done':
                cancel = (run['binding']['agentId'], run['threadId'])
            run['updatedAt'] = self.clock()
            self._save(run)
        if cancel:
            self.registry.cancel_stream(*cancel)
        if terminal:
            self._detach(run_id, confirmed=kind in {'done', 'error'})

    def _detach(self, run_id, *, confirmed=False):
        lock = self._upgrade_locks.get(run_id)
        # Timeout, cancellation signals and local errors do not prove that the
        # gateway stopped. Retain its subscription and lock for a late terminal
        # frame, or until process exit. OTA must fail closed in that interval.
        if not lock or confirmed:
            if lock:
                self._upgrade_locks.pop(run_id).close()
            connection = self._connections.pop(run_id, None)
            if connection:
                self.gateway.ws_hub.unregister(connection)
        timer = self._timers.pop(run_id, None)
        if timer and timer is not asyncio.current_task():
            timer.cancel()

    async def _expire(self, run_id):
        try:
            await asyncio.sleep(self.run_timeout)
            with self.svc.store.transaction():
                run = self._read(run_id)
                if not run or run['state'] in _TERMINAL:
                    return
                run.update(state='interrupted', errorCode='EXPERT_RUN_TIMEOUT', updatedAt=self.clock())
                self._save(run)
            self.registry.cancel_stream(run['binding']['agentId'], run['threadId'])
            self._detach(run_id)
        except asyncio.CancelledError:
            pass

    def busy(self, owner, slot):
        self._user(owner)
        with self.svc.store.lock:
            for run_id in self._upgrade_locks:
                run = self._read(run_id)
                if run and run['owner'] == owner and run['binding']['slotApplicationId'] == slot:
                    return True
            return self.svc.store.db.execute("SELECT 1 FROM deployment_expert_runs WHERE owner=? AND json_extract(body,'$.binding.slotApplicationId')=? AND json_extract(body,'$.state') IN ('queued','running','cancel_requested') LIMIT 1", (owner, slot)).fetchone() is not None

    async def close(self):
        if self.closed:
            return
        self.closed = True
        timers = list(self._timers.values())
        # Timers are created before turn preparation awaits. A pending prepare
        # has no connection yet, so detaching only registered connections misses
        # its timer and would make shutdown wait for the entire run timeout.
        for timer in timers:
            timer.cancel()
        for run_id in set(self._connections) | set(self._upgrade_locks):
            self._detach(run_id)
        self._timers.clear()
        if timers:
            await asyncio.gather(*timers, return_exceptions=True)
        with self.svc.store.transaction():
            for row in self.svc.store.db.execute('SELECT body FROM deployment_expert_runs').fetchall():
                run = json.loads(row[0])
                if run['state'] not in _TERMINAL:
                    run.update(state='interrupted', errorCode='EXPERT_SERVICE_RESTARTED', updatedAt=self.clock())
                    self._save(run)
