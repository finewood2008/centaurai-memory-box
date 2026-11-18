import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';
import { SemanticaService } from '../shell/service.mjs';
import { workbenchErrorReply } from '../shell/workbench-errors.mjs';
import { readWorkbenchReply } from '../ui/native-workbench.js';

function service(response) {
  return new SemanticaService({ host: {
    onSessionInvalidated: () => () => {},
    request: async () => response(),
  } });
}
const input = { warehouseId: 'warehouse-a', url: '/api/documents/document/corrections/draft/save?workspace_id=default', method: 'POST',
  body: JSON.stringify({ operation_id: 'same-save', expected_revision: 1 }) };

test('correction reads preserve editor session through the scoped signed envelope', async () => {
  const svc = service(() => { throw Error('unexpected transport'); });
  const calls = [];
  svc.api = async (endpoint, options) => { calls.push({endpoint, ...options}); return {leases: []}; };
  const editor = {session: 'synthetic-editor-session-123', generation: '2'};
  const reply = await svc.call('workbench-request', {warehouseId: 'warehouse-a',
    url: '/api/documents/document/corrections/leases?workspace_id=foreign', editor});
  assert.deepEqual(reply, {leases: []});
  assert.equal(calls.length, 1);
  assert.equal(calls[0].endpoint, '/warehouses/warehouse-a/workbench/_correction_read');
  assert.equal(calls[0].method, 'POST');
  assert.deepEqual(calls[0].body._native_editor, editor);
  assert.equal(calls[0].body.path, '/api/documents/document/corrections/leases');
  assert.deepEqual(calls[0].body.query, {});
  assert.match(calls[0].body._native_operation_id, /^[0-9a-f-]{36}$/);
});

test('missing sessions have a specific recovery message without exposing server text', () => {
  const reply = workbenchErrorReply({code:'CORRECTION_SESSION_REQUIRED',status:409,message:'private'});
  assert.match(reply.message, /编辑会话/);
  assert.match(reply.message, /更新/);
  assert.equal(reply.message.includes('private'), false);
});

test('unsupported operations and dependent relations have actionable public messages', () => {
  for (const [code, expected] of [
    ['INVALID_RESOURCE', /星图客户端/],
    ['SEMANTICA_OPERATION_NOT_ALLOWED', /万象服务/],
    ['CORRECTION_RELATIONS_REQUIRE_ACTION', /关联关系/],
  ]) {
    const reply = workbenchErrorReply({code, status: 409, message: 'private server detail'});
    assert.equal(reply.code, code);
    assert.match(reply.message, expected);
    assert.equal(reply.message.includes('private'), false);
  }
});

test('editor metadata is confined to correction endpoints and cannot inject headers', async () => {
  const svc = service(() => { throw Error('must not send'); });
  for (const editor of [null, {session:'short',generation:'1'},
    {session:'synthetic-editor-session-123',generation:'1',authorization:'forged'},
    {session:'synthetic-editor-session-123',generation:1}]) {
    await assert.rejects(svc.call('workbench-request',{...input,editor}), e=>e.code==='INVALID_RESOURCE');
  }
  await assert.rejects(svc.call('workbench-request',{...input,url:'/api/ontologies',
    editor:{session:'synthetic-editor-session-123',generation:'1'}}), e=>e.code==='INVALID_RESOURCE');
});

test('workbench correction errors keep definite rejection code/status without exposing server detail', async () => {
  const svc = service(() => new Response(JSON.stringify({ code: 'CORRECTION_REVISION_CONFLICT', detail: 'private backend diagnostic' }), { status: 409 }));
  await assert.rejects(svc.call('workbench-request', input), error => {
    assert.equal(error.code, 'CORRECTION_REVISION_CONFLICT');
    assert.equal(error.status, 409);
    assert.equal(error.publicMessage.includes('private'), false);
    return true;
  });
});

test('connection loss never becomes a definite HTTP refusal and non-workbench errors keep their existing policy', async () => {
  const lost = service(() => { throw Error('private transport diagnostic'); });
  await assert.rejects(lost.call('workbench-request', input), error => error.code === 'SEMANTICA_CONNECTION_FAILED' && !error.status);
  const svc = service(() => new Response(JSON.stringify({ code: 'CORRECTION_REVISION_CONFLICT', detail: 'private' }), { status: 409 }));
  await assert.rejects(svc.api('/documents'), error => error.code === 'SEMANTICA_REQUEST_FAILED' && !error.status && !error.publicMessage);
});

test('the panel bridge returns cloneable workbench refusal metadata', async () => {
  let reply = { ok: false, code: 'CORRECTION_REVISION_CONFLICT', message: '草稿已变化，请刷新后重试', status: 409 };
  const { createPanelBridge } = await import('../ui/panel-bridge.mjs');
  const bridge = createPanelBridge({call: async () => reply}, {});
  // Electron copies Error objects without custom properties; normal data survives.
  const call = async (...args) => {
    try { return structuredClone(await bridge.call(...args)); }
    catch (error) { throw new Error(error.message); }
  };
  assert.deepEqual(await call('workbench-request', input), reply);
  reply = { ok: false, code: 'SEMANTICA_SERVICE_TIMEOUT' };
  assert.deepEqual(await call('workbench-request', input), reply);
  reply = { ok: false, code: 'CORRECTION_REVISION_CONFLICT', status: 409 };
  await assert.rejects(bridge.call('documents', {}), error => !error.status);
});

test('workbench IPC metadata never exposes arbitrary server messages or mislabels uncertain failures as 4xx', () => {
  for (const error of [
    { code: 'CORRECTION_REVISION_CONFLICT', status: '409' },
    { code: 'SEMANTICA_SERVICE_TIMEOUT', status: 408 },
    { code: 'SEMANTICA_CONNECTION_FAILED', status: 403 },
    { code: 'CORRECTION_REVISION_CONFLICT', status: 200 },
  ]) {
    const reply = workbenchErrorReply({ ...error, message: 'private backend diagnostic', publicMessage: 'private stack', stack: 'private stack' });
    assert.equal(reply.status, 0);
    assert.equal(JSON.stringify(reply).includes('private'), false);
  }
  assert.equal(workbenchErrorReply({ code: 'private malformed code', status: 409 }).code, 'SEMANTICA_REQUEST_FAILED');
});
test('malformed workbench envelopes remain uncertain protocol failures even when they contain a 4xx number', () => {
  for (const reply of [{status: 409}, {ok: false, status: 409}, {ok: false, code: 'invalid code', status: 403}])
    assert.throws(() => readWorkbenchReply(reply), error => error.code === 'SEMANTICA_INVALID_RESPONSE' && error.status === 0);
});

for (const [code, expected, status] of [
  ['ONTOLOGY_SUGGESTION_EXPIRED', /已过期.*重新生成/, 409],
  ['ONTOLOGY_CONTEXT_TOO_SMALL', /上下文预算.*减少选择/, 422],
  ['ONTOLOGY_MODEL_TIMEOUT', /生成超时/, 504],
  ['RELEASE_NOT_FOUND', /刷新版本列表/, 404],
  ['RELEASE_DOCUMENT_UNAVAILABLE', /已删除或不可访问/, 404],
  ['RESTORE_PREVIEW_STALE', /重新预览并确认/, 409],
]) test(`owner error ${code} survives service and IPC with a fixed recovery hint`, async () => {
  const svc = service(() => new Response(JSON.stringify({code, message: 'private backend diagnostic'}), {status}));
  await assert.rejects(svc.call('workbench-request', input), error => {
    const reply = workbenchErrorReply(error);
    assert.equal(reply.code, code);
    assert.equal(reply.status, status);
    assert.match(reply.message, expected);
    assert.equal(JSON.stringify(reply).includes('private'), false);
    assert.throws(() => readWorkbenchReply(reply), received => received.code === code && received.status === status);
    return true;
  });
});

test('adapter timeouts retain an uncertain result and never instruct a blind repeat', async () => {
  const svc = service(() => new Response(JSON.stringify({code:'SEMANTICA_SERVICE_TIMEOUT'}), {status:504}));
  await assert.rejects(svc.call('workbench-request', input), error => {
    const reply = workbenchErrorReply(error);
    assert.equal(reply.code, 'SEMANTICA_SERVICE_TIMEOUT');
    assert.equal(reply.status, 0);
    assert.match(reply.message, /先刷新核对操作结果/);
    return true;
  });
});
