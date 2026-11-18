import test from 'node:test';
import assert from 'node:assert/strict';
import {warehouseMaterialEntries,readWarehouseMaterials,selectWarehouseMaterial,openWarehouseMaterial,refreshWarehouseMaterial,startWarehouseMaterialDialogue} from '../ui/material-library.mjs';
import {materialListHTML,materialLibraryHTML} from '../ui/material-workspace.mjs';
const workflow=id=>({document_id:id,document:{id,original_name:'WANX.txt',status:'ready'},label:'正文已解析',tasks:[],conversations:[],actions:{start_dialogue:{allowed:true}}});

function fixture(){
  const calls=[],flow={warehouseId:'warehouse',saved:{conversationId:'conversation'},intake:{},changes:{record:{}},
    state:{loaded:true,intents:[],materialIndex:{},conversations:[],warehouseMaterials:[]},
    check(){},emit(){},rememberMaterialComposer(){calls.push('save-composer');},
    async run(fn){if(this.state.busy)return;this.state.busy=true;try{await fn();this.state.error='';}catch(e){this.state.error=e.code;}finally{this.state.busy=false;}},
    async selectMaterial(session,id){calls.push(['select',session,id]);this.state.selectedIntent=id;},
    async read(action,input){calls.push([action,input]);return action==='conversation-material-workflows'?{items:[workflow('external')],total:1}:action==='conversation-material-workflow'?workflow(input.documentId):{document:{id:input.id,original_name:'WANX.txt',status:'ready'}};}};
  return {flow,calls};
}

test('deleted source links never reappear as unnamed upload materials while changed versions remain visible',()=>{
  const {flow}=fixture();flow.state.warehouseMaterials=[{id:'current',original_name:'当前材料'}];
  flow.state.materialIndex={old:[{id:'removed',document_id:'deleted',status:'stale',source_status:'source_unavailable'},
    {id:'legacy',status:'stale',invalid_reason:'source_deleted'},
    {id:'changed',document_id:'version-changed',status:'stale',source_status:'source_changed',original_name:'正文有新版本'}]};
  assert.deepEqual(warehouseMaterialEntries(flow).map(row=>row.document.id),['current','version-changed']);
  const html=materialListHTML(flow);assert.doesNotMatch(html,/待上传材料|data-id="deleted"|data-id="legacy"/);assert.match(html,/正文有新版本/);
});
test('warehouse inventory includes unlinked WANX material and never labels parsed text as published knowledge',async()=>{
  const {flow,calls}=fixture();await readWarehouseMaterials(flow);
  assert.equal(warehouseMaterialEntries(flow).length,1);
  const html=materialListHTML(flow);assert.match(html,/WANX.txt/);assert.match(html,/正文已解析/);assert.match(html,/library-select/);
  await selectWarehouseMaterial(flow,'external');assert.equal(flow.state.librarySelection.document.id,'external');
  assert.match(materialLibraryHTML(flow),/查看处理任务/);
  assert.equal(calls.some(c=>Array.isArray(c)&&/create|upload|confirm|publish/.test(c[0])),false);
});
test('one document row holds multiple conversation links without inventing an active conversation',async()=>{
  const {flow,calls}=fixture();await readWarehouseMaterials(flow);
  flow.state.materialIndex={one:[{id:'i1',document_id:'external'}],two:[{id:'i2',document_id:'external'}]};
  assert.equal(warehouseMaterialEntries(flow).length,1);
  await selectWarehouseMaterial(flow,'external');assert.equal(flow.state.librarySelection.links.length,2);
  assert.equal(calls.some(c=>Array.isArray(c)&&c[0]==='select'),false);
  assert.equal((materialListHTML(flow).match(/class="mw-material /g)||[]).length,1);
});
test('reading current material bypasses its single stale conversation without executing processing',async()=>{
  const {flow,calls}=fixture();await readWarehouseMaterials(flow);
  flow.state.materialIndex={one:[{id:'i1',document_id:'external',status:'stale'}]};
  await selectWarehouseMaterial(flow,'external',true);
  assert.equal(flow.state.librarySelection.document.id,'external');
  assert.equal(calls.some(c=>Array.isArray(c)&&c[0]==='select'),false);
  assert.equal(calls.some(c=>Array.isArray(c)&&/create|confirm|publish/.test(c[0])),false);
});

test('a single linked material resumes the existing conversation without creating a new intent',async()=>{
  const {flow,calls}=fixture();await readWarehouseMaterials(flow);
  flow.state.materialIndex={one:[{id:'i1',document_id:'external'}]};
  await selectWarehouseMaterial(flow,'external');assert.deepEqual(calls.at(-1),['select','one','i1']);
});
test('inventory pagination is independent from the upload picker and deduplicates document rows',async()=>{
  const {flow}=fixture();flow.state.documents=[{id:'picker'}];
  flow.read=async(_action,{offset})=>({items:[workflow(offset?'b':'a')],total:2});
  await readWarehouseMaterials(flow);assert.equal(flow.state.warehouseMaterialMore,true);
  await readWarehouseMaterials(flow,true);assert.equal(flow.state.warehouseMaterialMore,false);
  assert.deepEqual(flow.state.warehouseMaterials.map(d=>d.id),['a','b']);assert.deepEqual(flow.state.documents,[{id:'picker'}]);
  flow.saved.deletedDocuments={a:true};assert.deepEqual(warehouseMaterialEntries(flow).map(row=>row.document.id),['b']);
});
test('selection refuses pending mutations and rejects another document returned by the server',async()=>{
  const {flow,calls}=fixture();flow.state.warehouseMaterials=[{id:'external'}];flow.saved.pending={};
  await selectWarehouseMaterial(flow,'external');assert.equal(flow.state.error,'MODELING_REQUEST_PENDING');assert.equal(calls.length,0);
  delete flow.saved.pending;flow.read=async()=>({document:{id:'other'}});
  await selectWarehouseMaterial(flow,'external');assert.equal(flow.state.error,'SEMANTICA_INVALID_RESPONSE');assert.equal(flow.state.librarySelection,undefined);
});

test('launch navigation verifies the document and conversation attachment before selecting a session',async()=>{
  const {flow,calls}=fixture();flow.all=async()=>[{id:'intent',document_id:'external'}];
  flow.selectMaterial=async(session,id)=>{calls.push(['select',session,id]);flow.state.detail={document_id:'external'};};
  assert.equal(await openWarehouseMaterial(flow,{documentId:'external',conversationId:'c',intentId:'intent'}),true);
  assert.deepEqual(calls.at(-1),['select','c','intent']);
  const before=calls.length;
  assert.equal(await openWarehouseMaterial(flow,{documentId:'external',conversationId:'c',intentId:'foreign'}),false);
  assert.equal(flow.state.error,'MODELING_RESOURCE_NOT_FOUND');assert.equal(calls.length,before+1);
});

test('launching an unlinked material outside the first inventory page only reads and selects that document',async()=>{
  const {flow,calls}=fixture();assert.equal(await openWarehouseMaterial(flow,{documentId:'external'}),true);
  assert.equal(flow.state.librarySelection.document.id,'external');assert.equal(calls.filter(Array.isArray).every(c=>['document','conversation-material-workflow'].includes(c[0])),true);
});

test('material workflow refresh replaces status and revokes cached actions after a failed read',async()=>{
  const {flow}=fixture();await readWarehouseMaterials(flow);await selectWarehouseMaterial(flow,'external');
  assert.equal(flow.saved.libraryDocumentId,'external');
  flow.read=async()=>({...workflow('external'),label:'正在发布',actions:{start_dialogue:{allowed:false,reason:'处理中'}}});
  await refreshWarehouseMaterial(flow);assert.match(materialLibraryHTML(flow),/正在发布/);assert.doesNotMatch(materialLibraryHTML(flow),/data-cv="library-start"/);
  flow.read=async()=>{throw Object.assign(Error('removed'),{status:404});};
  await assert.rejects(refreshWarehouseMaterial(flow));assert.equal(flow.state.librarySelection,null);assert.deepEqual(flow.state.warehouseMaterials,[]);
});

test('explicit start revalidates permission and uses existing confirmed intake without extracting',async()=>{
  const {flow,calls}=fixture();await readWarehouseMaterials(flow);await selectWarehouseMaterial(flow,'external');flow.ready=async()=>{};
  flow.intake.stageDocument=async id=>{calls.push(['stage',id]);flow.intake.staged={documentId:id};};
  flow.intake.submit=async input=>calls.push(['submit',input]);
  await startWarehouseMaterialDialogue(flow);assert.deepEqual(calls.at(-1),['submit',{isolated:true,note:''}]);
  flow.intake.staged=null;flow.read=async()=>({...workflow('external'),actions:{start_dialogue:{allowed:false}}});const count=calls.length;
  await startWarehouseMaterialDialogue(flow);assert.equal(flow.state.error,'MODELING_MATERIAL_BUSY');assert.equal(calls.length,count);
});

test('malformed workflow responses cannot expose an executable start action',async()=>{
  const {flow}=fixture();flow.read=async()=>({items:[{document:{},actions:{}}],total:1});
  await assert.rejects(readWarehouseMaterials(flow),{code:'SEMANTICA_INVALID_RESPONSE'});
});
