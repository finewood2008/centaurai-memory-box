import assert from 'node:assert/strict';
import test from 'node:test';
import { SemanticaService } from '../shell/service.mjs';

const operation = '10000000-0000-4000-8000-000000000001';
const input = {warehouseId: 'warehouse-a', url: '/api/documents/material?confirm=true', method: 'DELETE',
  body: JSON.stringify({operation_id: operation})};
function fixture() {
  const requests = [];
  const service = new SemanticaService({host: {onSessionInvalidated: () => () => {},
    request: async (path, options) => {requests.push({path, ...options}); return new Response(JSON.stringify({operation_id: operation}));}}});
  return {service, requests};
}
test('confirmed deletion uses only the selected warehouse typed endpoint and retains retry identity', async () => {
  const {service, requests} = fixture();
  for (let i=0;i<2;i++) await service.call('workbench-request', input);
  assert.equal(requests.length, 2);
  for (const request of requests) {
    assert.equal(request.path, '/api/semantica/warehouses/warehouse-a/documents/material');
    assert.equal(request.method, 'DELETE');
    assert.deepEqual(request.body, {operation_id: operation});
  }
});
test('deletion rejects missing confirmation, identity injection and unrelated routes before transport', async () => {
  for (const change of [
    {warehouseId: undefined}, {url:'/api/documents/material'}, {url:'/api/documents/material?confirm=false'},
    {url:'/api/documents/material?confirm=true&actor_id=other'}, {url:'/api/documents/material/corrections?confirm=true'},
    {url:'/api/jobs/material?confirm=true'}, {body:undefined}, {body:'{}'},
    {body:JSON.stringify({operation_id:operation,workspace_id:'other'})}, {editor:{}},
  ]) {
    const {service, requests} = fixture();
    await assert.rejects(service.call('workbench-request', {...input,...change}), {code:'INVALID_RESOURCE'});
    assert.equal(requests.length, 0);
  }
});
