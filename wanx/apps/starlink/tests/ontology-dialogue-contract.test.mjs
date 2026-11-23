import test from 'node:test';
import assert from 'node:assert/strict';
import {SemanticaService} from '../shell/service.mjs';
const digest='a'.repeat(64);
function fixture(){const calls=[];return {calls,service:new SemanticaService({host:{onSessionInvalidated:()=>()=>{},request:async(path,options)=>{calls.push({path,...options});return new Response(JSON.stringify({resource_id:'receipt'}));}}})};}
const input=(suffix,body)=>({warehouseId:'warehouse',url:'/api/conversations/c/ontology-edit'+suffix,method:body?'POST':'GET',...(body?{body:JSON.stringify({operation_id:'operation',...body})}:{})});
test('ontology dialogue stays warehouse scoped with original operation identity, no editor credentials',async()=>{
  const h=fixture();await h.service.call('workbench-request',input('/turns',{expected_revision:2,draft_digest:digest,instruction:'新增专利类型',selected:[]}));
  assert.equal(h.calls[0].path,'/api/semantica/warehouses/warehouse/workbench/conversations/c/ontology-edit/turns');
  const body=typeof h.calls[0].body==='string'?JSON.parse(h.calls[0].body):h.calls[0].body;
  assert.equal(body.operation_id,body._native_operation_id);assert.equal(body._native_editor,undefined);
});
test('standalone change creation and published-only confirmation are finite operations',async()=>{
  const h=fixture();await h.service.call('workbench-request',{warehouseId:'warehouse',url:'/api/conversations',method:'POST',body:JSON.stringify({operation_id:'create',scenario:'change',workspace_id:'default'})});
  await h.service.call('workbench-request',input('/execute',{preview_id:'preview',preview_digest:digest,confirmed:true,mode:'publish_only'}));
  assert.equal(h.calls.length,2);
});

test('proposal generation and explicit application are separate finite warehouse routes',async()=>{
  const h=fixture();
  await h.service.call('workbench-request',input('/proposals',{expected_revision:2,draft_digest:digest,instruction:'建议研发实体与关系',selected:[],proposal_id:'previous',proposal_digest:digest}));
  await h.service.call('workbench-request',input('/proposals/suggestion/apply',{expected_revision:2,draft_digest:digest,proposal_digest:digest,confirmed:true}));
  assert.equal(h.calls.length,2);assert.match(h.calls[0].path,/\/ontology-edit\/proposals$/);assert.match(h.calls[1].path,/\/proposals\/suggestion\/apply$/);
  for(const call of h.calls){const body=typeof call.body==='string'?JSON.parse(call.body):call.body;assert.equal(body.operation_id,body._native_operation_id);assert.equal(body._native_editor,undefined);}
});

test('proposal apply refuses missing consent, injected schema, malformed bindings and arbitrary paths',async()=>{
  const body={expected_revision:0,draft_digest:digest,proposal_digest:digest,confirmed:true};
  for(const candidate of [input('/proposals/p/apply',{...body,confirmed:false}),input('/proposals/p/apply',{...body,proposal_digest:'bad'}),input('/proposals/p/apply',{...body,schema:{}}),input('/turns/p/apply',body),input('/proposals/p/apply'),input('/proposals/p',body),input('/proposals',{expected_revision:0,draft_digest:digest,instruction:'修改',selected:[],proposal_id:'p'})]){
    const h=fixture();await assert.rejects(h.service.call('workbench-request',candidate),{code:'INVALID_RESOURCE'});assert.equal(h.calls.length,0);
  }
});
test('deny injected scopes, arbitrary schemas, malformed selection and implicit re-extraction',async()=>{
  const turn={expected_revision:0,draft_digest:digest,instruction:'删除',selected:[]};
  for(const candidate of [input('/turns',{...turn,actor:'someone'}),input('/turns',{...turn,_native_editor:{}}),input('/turns',{...turn,selected:[{kind:'entity',type_kind:'relation',type_name:'PERSON'}]}),input('/turns',{...turn,selected:[{kind:'entity',type_kind:'entity',type_name:{}}]}),input('/draft',{schema:{}}),input('/execute',{preview_id:'p',preview_digest:digest,confirmed:true,mode:'selected'}),input('/execute',{preview_id:'p',preview_digest:digest,confirmed:false,mode:'publish_only'}),{...input(''),editor:{}},input('?offset=0&offset=1'),input('?actor_id=other'),input('/initialize/invalid',{base_ontology_id:'base',name:'test'})]){
    const h=fixture();await assert.rejects(h.service.call('workbench-request',candidate),{code:'INVALID_RESOURCE'});assert.equal(h.calls.length,0);
  }
});
