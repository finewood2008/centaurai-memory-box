import assert from 'node:assert/strict';
import { test } from 'node:test';
import { correctionRequest, correctionUrl, CorrectionError } from '../src/corrections.ts';
import { requestJson } from '../src/request.ts';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { SemanticaService } from '../../shell/service.mjs';
import { workbenchErrorReply } from '../../shell/workbench-errors.mjs';
import { readWorkbenchReply } from '../../ui/native-workbench.js';

async function embedded(run, request, native = false) {
  const original = { window: globalThis.window, location: globalThis.location, fetch: globalThis.fetch };
  const seen = [];
  const call = async input => { seen.push(input); return request(input); };
  const parent = { starlinkWorkbench: { request: (_source, input) => call(input) } };
  globalThis.window = native ? { semantica: { call: async (_action, input) => {
    try { return {ok: true, value: await call(input)}; }
    catch (reason) { return {ok: false, ...reason}; }
  } } } : { parent };
  globalThis.location = { search: native ? '?native=1' : '?native=1&embedded=1' };
  globalThis.fetch = async () => { throw Error('Failed to fetch'); };
  try { await run(seen); }
  finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
    }
  }
}

test('correction draft requests use the selected embedded warehouse Host instead of file fetch', async () => {
  await embedded(async seen => {
    const body = { operation_id: 'same-operation' };
    const url = correctionUrl('default', 'document');
    assert.deepEqual(await correctionRequest(url, new AbortController().signal, body), { draft_id: 'draft', revision: 1 });
    assert.equal(seen.length, 2);
    assert.match(seen[0].url, /\/sessions\?/);
    assert.deepEqual(seen[1], { url, method: 'POST', body: JSON.stringify(body), editor: {session: 'synthetic-editor-session-123', generation: '0'} });
  }, input => input.url.includes('/sessions?') ? {editor_session: 'synthetic-editor-session-123'} : { draft_id: 'draft', revision: 1 });
});

for (const native of [false, true]) {
  test(`correction conflicts retain code and HTTP status through ${native ? 'native' : 'embedded'} transport`, async () => {
    await embedded(async () => {
      await assert.rejects(correctionRequest(correctionUrl('default', 'document', '/draft/save'), new AbortController().signal, {}),
        error => error instanceof CorrectionError && error.status === 409 && error.code === 'CORRECTION_REVISION_CONFLICT');
    }, () => { throw { message: '草稿已变化', code: 'CORRECTION_REVISION_CONFLICT', status: 409 }; }, native);
  });
}

test('permission refusal is definite while a lost correction response remains uncertain', async () => {
  for (const [problem, status] of [
    [{ message: '没有权限', code: 'SEMANTICA_RESOURCE_FORBIDDEN', status: 403 }, 403],
    [{ message: '连接中断', code: 'SEMANTICA_CONNECTION_FAILED' }, 0],
  ]) {
    await embedded(async () => {
      await assert.rejects(correctionRequest(correctionUrl('default', 'document'), new AbortController().signal, {}),
        error => error instanceof CorrectionError && error.code === problem.code && error.status === status);
    }, () => { throw problem; });
  }
});

test('cancelled correction requests cannot commit a late Host response or start when already cancelled', async () => {
  const controller = new AbortController(); controller.abort();
  await embedded(async seen => {
    await assert.rejects(correctionRequest(correctionUrl('default', 'document'), controller.signal), { name: 'AbortError' });
    assert.equal(seen.length, 0);
  }, () => ({}));
  let release;
  let started;
  const sent = new Promise(resolve => { started = resolve; });
  const active = new AbortController();
  await embedded(async () => {
    const pending = correctionRequest(correctionUrl('default', 'document'), active.signal, { operation_id: 'same-operation' });
    await sent;
    active.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    release({ draft_id: 'late-draft' });
  }, () => new Promise(resolve => { release = resolve; started(); }));
});

test('shared restore requests preserve definite rejection status without treating a timeout as 4xx', async () => {
  for (const [problem, status] of [[{ code: 'CORRECTION_DRAFT_EXISTS', status: 409 }, 409], [{ code: 'SEMANTICA_SERVICE_TIMEOUT', status: 408 }, 0]]) {
    await embedded(async seen => {
      await assert.rejects(requestJson('/api/knowledge-releases/release/documents/document/restore?workspace_id=default',
        { method: 'POST', body: JSON.stringify({ operation_id: 'same-restore' }) }), error => error.status === status && error.code === problem.code);
      assert.equal(seen[0].method, 'POST');
    }, () => { throw problem; });
  }
});
test('malformed native refusal metadata cannot turn an unknown result into a definite 4xx', async () => {
  await embedded(async () => {
    await assert.rejects(correctionRequest(correctionUrl('default', 'document'), new AbortController().signal, {}),
      error => error.code === 'SEMANTICA_INVALID_RESPONSE' && error.status === 0);
  }, () => { throw { status: 409 }; }, true);
});

test('editor sessions reach scoped draft reads and writes through the desktop service', async () => {
  const operations = [];
  const token = 'synthetic-flow-editor-session-123';
  const service = new SemanticaService({host: {
    onSessionInvalidated: () => () => {},
    request: async (path, options) => {
      operations.push({path, body: options.body});
      let value;
      if (path.split('?')[0].endsWith('/sessions')) value = {editor_session: token};
      else {
        assert.deepEqual(options.body._native_editor, {session: token, generation: path.includes('/_correction_read') || path.split('?')[0].endsWith('/save') ? '2' : '0'});
        assert.ok(!path.includes(token));
        if (path.includes('/_correction_read')) {
          assert.equal(options.method, 'POST');
          assert.equal(options.body.path, '/api/documents/flow-document/corrections/flow-draft/items');
          assert.deepEqual(options.body.query, {revision: '1'});
          value = {items: [], total: 0};
        } else value = {draft_id: 'flow-draft', revision: 1, status: 'editing', lease_generation: 2};
      }
      return new Response(JSON.stringify(value));
    },
  }});
  await embedded(async () => {
    const signal = new AbortController().signal;
    await correctionRequest(correctionUrl('default', 'flow-document'), signal, {operation_id:'flow-open'});
    await correctionRequest(correctionUrl('default', 'flow-document','/flow-draft/items',{revision:1}), signal);
    await correctionRequest(correctionUrl('default', 'flow-document','/flow-draft/save'), signal, {operation_id:'flow-save',expected_revision:1});
    await requestJson('/api/knowledge-releases/release-a/documents/flow-document/restore?workspace_id=default', {
      method: 'POST', signal, headers: {'X-Correction-Session': token, 'X-Correction-Generation': '0'},
      body: JSON.stringify({operation_id: 'restore-flow', confirmed: true, preview_digest: 'synthetic'}),
    });
  }, input => service.call('workbench-request', {...input,warehouseId:'selected-warehouse'}));
  assert.equal(operations.length, 5);
});

test('correction errors survive the real service, safe IPC reply and preload before reaching the embedded frame', async () => {
  let preload;
  const operations = [];
  const service = new SemanticaService({ host: {
    onSessionInvalidated: () => () => {},
    request: async (path, options) => {
      operations.push({ path, body: options.body });
      return new Response(JSON.stringify({ code: 'CORRECTION_REVISION_CONFLICT', detail: 'private backend diagnostic' }), { status: 409 });
    },
  } });
  const { createPanelBridge } = await import('../../ui/panel-bridge.mjs');
  preload = createPanelBridge({call: async (_source, action, input) => {
      try { return { ok: true, value: await service.call(action, input) }; }
      catch (error) {
        const reply = workbenchErrorReply(error);
        assert.deepEqual(Object.keys(reply).sort(), ['code', 'message', 'ok', 'status']);
        assert.equal(JSON.stringify(reply).includes('private backend'), false);
        return JSON.parse(JSON.stringify(reply));
      }
    } }, {});
  await embedded(async () => {
    await assert.rejects(correctionRequest(correctionUrl('default', 'document', '/draft/save'), new AbortController().signal,
      { operation_id: 'unchanged-retry', expected_revision: 3 }), error => error instanceof CorrectionError
        && error.status === 409 && error.code === 'CORRECTION_REVISION_CONFLICT' && !error.message.includes('private'));
  }, async input => {
    let reply;
    try { reply = structuredClone(await preload.call('workbench-request', { ...input, warehouseId: 'selected-warehouse' })); }
    catch (error) { throw new Error(error.message); }
    return readWorkbenchReply(reply);
  });
  assert.equal(operations.length, 1);
  assert.equal(operations[0].path, '/api/semantica/warehouses/selected-warehouse/workbench/documents/document/corrections/draft/save');
  assert.equal(operations[0].body.operation_id, 'unchanged-retry');
  assert.equal(operations[0].body._native_operation_id, 'unchanged-retry');
});
