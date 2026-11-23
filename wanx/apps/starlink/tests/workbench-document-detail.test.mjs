import assert from 'node:assert/strict';
import test from 'node:test';
import { SemanticaService } from '../shell/service.mjs';

const warehouse = '10000000-0000-4000-8000-000000000001';
const document = 'synthetic-ready-document';
const detail = {
  document: { id: document, status: 'ready', workspace_id: 'scoped-workspace' },
  version: { id: 'synthetic-version' },
  segments: [], blocks: [], block_count: 0,
  processing: { delivery_status: 'pending' }, segment_next_offset: 0,
};
function setup({ status = 200, value = detail, pending = false } = {}) {
  const requests = [];
  let release;
  const service = new SemanticaService({ host: {
    onSessionInvalidated: () => () => {},
    request: async (path, options) => {
      requests.push({ path, options });
      if (pending) await new Promise(resolve => { release = resolve; });
      const typed = path.startsWith(`/api/semantica/warehouses/${warehouse}/documents/${document}`);
      return new Response(JSON.stringify(typed ? value : { code: 'SEMANTICA_OPERATION_NOT_ALLOWED' }), {
        status: typed ? status : 404, headers: { 'content-type': 'application/json' },
      });
    },
  } });
  return { service, requests, release: () => release() };
}
const input = query => ({ warehouseId: warehouse, url: `/api/documents/${document}${query}`, method: 'GET' });

test('both automatic ready-document reads use the existing warehouse-scoped typed detail DTO', async () => {
  for (const query of ['?workspace_id=default&segment_offset=0&segment_limit=200', '?segment_limit=200', '?segment_limit=200&block_offset=500&block_limit=1']) {
    const { service, requests } = setup();
    assert.deepEqual(await service.call('workbench-request', input(query)), detail);
    assert.equal(requests.length, 1);
    const actual = new URL(requests[0].path, 'http://synthetic.invalid');
    assert.equal(actual.pathname, `/api/semantica/warehouses/${warehouse}/documents/${document}`);
    assert.equal(actual.searchParams.get('segment_limit'), '200');
    assert.equal(actual.searchParams.has('workspace_id'), false);
    assert.equal(requests[0].options.method, 'GET');
    assert.equal(requests[0].options.body, undefined);
  }
});

test('typed document rejections retain definite safe error code and HTTP status', async () => {
  const { service } = setup({ status: 403, value: { code: 'SEMANTICA_RESOURCE_FORBIDDEN', message: 'private server detail' } });
  await assert.rejects(service.call('workbench-request', input('?segment_limit=200')), error => {
    assert.equal(error.code, 'SEMANTICA_RESOURCE_FORBIDDEN');
    assert.equal(error.status, 403);
    assert.equal(error.message.includes('private'), false);
    return true;
  });
});

test('document detail preserves the selected warehouse and rejects late results after selection changes', async () => {
  const fixture = setup({ pending: true });
  const promise = fixture.service.call('workbench-request', input('?segment_offset=200&segment_limit=200'));
  await fixture.service.call('select-warehouse', {});
  fixture.release();
  await assert.rejects(promise, { code: 'WAREHOUSE_CHANGED' });
  assert.equal(fixture.requests[0].path, `/api/semantica/warehouses/${warehouse}/documents/${document}?segment_offset=200&segment_limit=200`);
});

test('only bounded segment and block pagination keys are accepted, without a GET body', async () => {
  for (const query of [
    '?segment_limit=0', '?segment_limit=201', '?segment_limit=-1', '?segment_limit=1.5',
    '?segment_limit=1e2', '?segment_limit=020', '?segment_limit=200&segment_limit=200',
    '?segment_offset=-1', '?segment_offset=2147483648', '?segment_offset=0&segment_offset=0',
    '?block_limit=0', '?block_limit=501', '?block_offset=-1', '?block_offset=2147483648',
    '?block_limit=1&block_limit=1', '?warehouse_id=other', '?actor_id=other', '?offset=0',
  ]) {
    const { service, requests } = setup();
    await assert.rejects(service.call('workbench-request', input(query)), { code: 'INVALID_RESOURCE' });
    assert.equal(requests.length, 0);
  }
  const { service, requests } = setup();
  await assert.rejects(service.call('workbench-request', { ...input('?segment_limit=200'), body: '{}' }), { code: 'INVALID_RESOURCE' });
  assert.equal(requests.length, 0);
});

test('body correction uses the existing scoped operation receipt and preserves its identity', async () => {
  const {service,requests}=setup();
  const value={operation_id:'20000000-0000-4000-8000-000000000002',base_version_id:'v1',segments:[{id:'s1',text:'corrected'}]};
  for(let i=0;i<2;i++) await service.call('workbench-request',{warehouseId:warehouse,url:`/api/documents/${document}/content`,method:'PATCH',body:JSON.stringify(value)});
  for(const request of requests){
    assert.equal(request.path,`/api/semantica/warehouses/${warehouse}/documents/${document}/correction`);
    assert.equal(request.options.method,'POST');
    assert.deepEqual(request.options.body,{operation_id:value.operation_id,payload:{base_version_id:'v1',segments:value.segments}});
  }
  for(const change of [{operation_id:undefined},{workspace_id:'other'},{operation_id:'invalid'}])
    await assert.rejects(service.call('workbench-request',{warehouseId:warehouse,url:`/api/documents/${document}/content`,method:'PATCH',body:JSON.stringify({...value,...change})}),{code:'INVALID_RESOURCE'});
  assert.equal(requests.length,2);
});

test('immutable text ranges stay version-bound and within 65536 characters', async () => {
  const {service,requests}=setup();
  const url=`/api/documents/${document}/text`;
  await service.call('workbench-request',{warehouseId:warehouse,url:url+'?version_id=v1&start=0&end=65536'});
  assert.equal(requests[0].path,`/api/semantica/warehouses/${warehouse}/documents/${document}/text?version_id=v1&start=0&end=65536`);
  for(const query of ['?start=0&end=1','?version_id=v1&start=-1&end=1','?version_id=v1&start=0&end=65537','?version_id=v1&start=3&end=2','?version_id=v1&start=0&end=1&actor_id=other'])
    await assert.rejects(service.call('workbench-request',{warehouseId:warehouse,url:url+query}),{code:'INVALID_RESOURCE'});
  assert.equal(requests.length,1);
});

test('the adapter adds no write, suffix, other resource, encoded ID or cross-warehouse route', async () => {
  for (const change of [
    { method: 'POST', body: '{}' }, { method: 'PUT', body: '{}' },
    { url: `/api/documents/${document}/knowledge?segment_limit=200` },
    { url: '/api/jobs/synthetic-job' },
    { url: '/api/documents/a%2Fb?segment_limit=200' },
    { url: `/api/documents/../documents/${document}?segment_limit=200` },
    { url: `/api/documents/%2e%2e/documents/${document}?segment_limit=200` },
    { url: '/api/warehouses/other/documents/synthetic-ready-document' },
  ]) {
    const { service, requests } = setup();
    await assert.rejects(service.call('workbench-request', { ...input(''), ...change }), { code: 'SEMANTICA_OPERATION_NOT_ALLOWED' });
    assert.equal(requests.length, 1);
    assert.ok(requests[0].path.startsWith(`/api/semantica/warehouses/${warehouse}/workbench/`));
  }
});
