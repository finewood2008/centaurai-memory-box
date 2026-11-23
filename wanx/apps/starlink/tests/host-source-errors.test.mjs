import test from 'node:test';
import assert from 'node:assert/strict';
import {ConversationFlow} from '../ui/conversation-state.mjs';
import {refreshWarehouseMaterial} from '../ui/material-library.mjs';
import {workbenchFailure,workbenchErrorReply} from '../shell/workbench-errors.mjs';
import {readWorkbenchReply} from '../ui/native-workbench.js';
const make=()=>new ConversationFlow({warehouseId:'warehouse',identity:{boxId:'box',user:{id:1},dataScope:'personal'},storage:{getItem:()=>null,setItem(){},removeItem(){}},call:async()=>{throw Error('Unexpected request');},uuid:()=> 'operation'});
for(const code of ['SEMANTICA_OPERATION_NOT_ALLOWED','SEMANTICA_UPGRADE_REQUIRED'])test(code+' preserves the material page on an unsupported endpoint',async()=>{
 const f=make();f.state.loaded=true;f.state.importDocumentId='document';f.state.warehouseMaterials=[{id:'document'}];
 await f.run(async()=>{throw workbenchFailure({code},404);});
 assert.equal(f.state.loaded,true);assert.equal(f.state.importDocumentId,'document');assert.equal(f.state.warehouseMaterials.length,1);assert.match(f.state.error,/材料列表已保留/);assert.equal(f.state.busy,false);
 f.state.librarySelection={document:{id:'document',workflow:{actions:{edit_source:{allowed:true}}}}};
 f.read=async()=>{throw workbenchFailure({code},404);};
 await assert.rejects(refreshWarehouseMaterial(f));
 assert.equal(f.state.warehouseMaterials.length,1);assert.equal(f.state.librarySelection.document.id,'document');assert.equal(f.state.librarySelection.document.workflow,undefined);
});
for(const [status,code] of [[401,'HOST_SESSION_EXPIRED'],[403,'SEMANTICA_RESOURCE_FORBIDDEN'],[404,'SEMANTICA_RESOURCE_NOT_FOUND']])test(code+' still revokes cached material access',async()=>{
 const f=make();f.state.loaded=true;f.state.importDocumentId='document';f.state.warehouseMaterials=[{id:'document'}];
 await f.run(async()=>{throw Object.assign(Error(code),{code,status});});
 assert.equal(f.state.loaded,false);assert.equal(f.state.importDocumentId,null);assert.deepEqual(f.state.warehouseMaterials,[]);
});
for(const code of ['SOURCE_VERSION_CONFLICT','SOURCE_NOT_READY','SOURCE_CONFIRMATION_STALE','SOURCE_OPERATION_CONFLICT'])test(code+' survives IPC without upstream body or secrets',()=>{
 const e=workbenchFailure({code,message:'PRIVATE material'},409);const reply=workbenchErrorReply(e);
 assert.equal(reply.code,code);assert.equal(reply.status,409);assert.doesNotMatch(JSON.stringify(reply),/PRIVATE/);
 assert.throws(()=>readWorkbenchReply(reply),x=>x.code===code&&x.status===409);
});
test('unknown SOURCE codes are not passed through',()=>{assert.equal(workbenchErrorReply({code:'SOURCE_PRIVATE',status:500}).code,'SEMANTICA_REQUEST_FAILED');});
test('network failure retains the exact source confirmation request for replay',async()=>{
 const f=make(),calls=[];f.call=async(action,input)=>{calls.push(structuredClone(input));if(calls.length===1)throw Object.assign(Error('timeout'),{code:'SEMANTICA_SERVICE_TIMEOUT',status:0});return {receipt:{confirmation_id:'confirmation',document_id:input.documentId,document_version_id:input.documentVersionId,operation_id:input.operationId,extraction_started:false,publication_performed:false}};};
 const input={documentId:'document',documentVersionId:'version',confirmed:true};
 await assert.rejects(f.write('conversation-source-confirm',input));assert.ok(f.saved.pending);
 await f.write('conversation-source-confirm',input);assert.deepEqual(calls[0],calls[1]);assert.equal(f.saved.pending,null);
});
