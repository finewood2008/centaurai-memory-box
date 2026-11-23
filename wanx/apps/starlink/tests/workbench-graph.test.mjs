import test from 'node:test';
import assert from 'node:assert/strict';
import {SemanticaService} from '../shell/service.mjs';
function fixture(){const requests=[];return {requests,service:new SemanticaService({host:{onSessionInvalidated:()=>()=>{},request:async(path,options)=>{requests.push({path,...options});return new Response(JSON.stringify({nodes:[],edges:[]}));}}})};}
test('owner graph stays on the selected warehouse typed Bridge route, without workbench or summary',async()=>{
  const {service,requests}=fixture();
  await service.call('workbench-request',{warehouseId:'warehouse',url:'/api/owner/graph?workspace_id=default&limit=120&entity_id=entity',method:'GET'});
  assert.equal(requests[0].path,'/api/semantica/warehouses/warehouse/owner/graph?limit=120&entity_id=entity');
});
test('owner graph refuses unsupported query fields, writes, invalid limits and injected identity',async()=>{
  for(const input of [{url:'/api/owner/graph?summary=true'},{url:'/api/owner/graph?limit=501'},{url:'/api/owner/graph?limit=0'},{url:'/api/owner/graph?limit=1&limit=2'},{url:'/api/owner/graph?actor_id=other'},{url:'/api/owner/graph?entity_id=../other'},{method:'POST'},{body:'{}'},{editor:{}},{warehouseId:undefined}]){
    const {service,requests}=fixture();await assert.rejects(service.call('workbench-request',{warehouseId:'warehouse',url:'/api/owner/graph?limit=120',method:'GET',...input}),{code:'INVALID_RESOURCE'});assert.equal(requests.length,0);
  }
});
