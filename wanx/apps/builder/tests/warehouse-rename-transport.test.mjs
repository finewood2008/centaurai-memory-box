import test from 'node:test';
import assert from 'node:assert/strict';
import {SemanticaService} from '../integration/team-client/starlink/service.mjs';
import {validatedWarehouseRename} from '../integration/team-client/starlink/warehouse-rename.mjs';
const input={warehouseId:'12345678-1234-1234-1234-123456789abc',operationId:'12345678-1234-1234-1234-123456789def',name:'新名称'};
test('rename transport counts Unicode codepoints and trims ordinary surrounding spaces',()=>{
 assert.equal(validatedWarehouseRename({...input,name:'  '+ '🌟'.repeat(60)+'  '}).name,'🌟'.repeat(60));
 for(const name of ['', '  ', '🌟'.repeat(61), 'x\n', '\u007fx', 'x\u0085', 4])assert.throws(()=>validatedWarehouseRename({...input,name}),{code:'WAREHOUSE_INVALID_NAME'});
});
test('rename transport cannot select other authority or invent a URL/method/operation identity',()=>{
 for(const invalid of [{warehouseId:'../settings'},{warehouseId:'other'}, {operationId:undefined},{operationId:'x'}, {scope:'team'},{description:'overwrite'},{method:'DELETE'},{path:'/settings'}])assert.throws(()=>validatedWarehouseRename({...input,...invalid}),{code:'TEAM_DATA_TARGET_INVALID'});
});

test('an older native service without rename prompts an upgrade instead of inventing a retry identity',async()=>{
 let calls=0;
 const service=new SemanticaService({host:{close(){},onSessionInvalidated:()=>()=>{},request:async()=>{calls++;return new Response(null,{status:405})}}});
 try{await assert.rejects(service.call('rename-warehouse',input),{code:'SEMANTICA_UPGRADE_REQUIRED'});assert.equal(calls,1)}finally{service.close()}
});
