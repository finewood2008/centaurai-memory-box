import test from 'node:test';
import assert from 'node:assert/strict';
import {ConversationFlow} from '../ui/conversation-state.mjs';
import {deleteMaterial,canDeleteMaterial} from '../ui/material-deletion.mjs';
import {materialListHTML,materialLibraryHTML} from '../ui/material-workspace.mjs';
import {conversationHTML} from '../ui/conversation.js';

function fixture(){
  const store=new Map(),calls=[];let live=true,attempt=0,mode='ok',release;
  const item={id:'intent',document_id:'doc',source_status:'available',status:'cancelled',original_name:'材料.txt'};
  const make=()=>{
    const f=new ConversationFlow({warehouseId:'warehouse',identity:{boxId:'box',user:{id:1},dataScope:'personal'},isCurrent:()=>live,
      storage:{getItem:k=>store.get(k),setItem:(k,v)=>store.set(k,v)},uuid:()=>`10000000-0000-4000-8000-${String(++attempt).padStart(12,'0')}`,
      call:async(action,input)=>{
        if(action==='conversation-intents')return {items:[item,{id:'other',document_id:'other'}],has_more:false};
        calls.push(structuredClone({action,input}));
        if(mode==='lose')throw Object.assign(Error(),{status:0,code:'SEMANTICA_CONNECTION_FAILED'});
        if(mode==='refuse')throw Object.assign(Error(),{status:409,code:'MODELING_SNAPSHOT_CHANGED'});
        if(mode==='hold')await new Promise(resolve=>release=resolve);
        return mode==='invalid'?{status:'failed'}:{status:'committed',document:{id:'doc',status:'deleted'},job:{id:'cleanup',status:'queued'}};
      }});
    f.saved.conversationId='session';
    f.state.loaded=true;f.state.intents=[item];f.state.detail=item;f.state.selectedIntent='intent';
    f.state.materialIndex={session:[item],linked:[{...item,id:'linked-intent'}],other:[{id:'other',document_id:'other'}]};
    f.state.messages=[{role:'assistant',content:'private source'}];f.state.knowledge={items:['private graph']};f.intake.source={document:{id:'doc',segment_count:1},version:{id:'version'},segments:[{id:'s',text:'private source'}]};
    f.saved.intakeReviews={intent:{edits:{s:'private source'}},'linked-intent':{note:'private note'}};
    f.saved.confirmedGoals={intent:{goal:'private goal'}};
    f.saved.materialComposers={'session:intent':{input:'private input'},'linked:linked-intent':{input:'private input'},'other:other':{input:'keep'}};
    f.changes.saved.scopes={'["session","intent"]':{draftId:'draft'},'["linked","linked-intent"]':{draftId:'draft2'},'["other","other"]':{draftId:'keep'}};
    f.snapshot=async()=>{};f.readMaterialIndex=async()=>{};
    return f;
  };
  return {make,calls,store,item,setMode:m=>mode=m,invalidate:()=>live=false,release:()=>release()};
}
const target={documentId:'doc',name:'材料.txt'};

test('unlinked library materials can be deleted without targeting the previous conversation material',async()=>{
  const h=fixture(),f=h.make();f.state.librarySelection={document:{id:'external',original_name:'自动处理材料'}};
  assert.equal(canDeleteMaterial(f),true);assert.match(materialLibraryHTML(f),/data-cv="material-delete" >删除材料/);
  await deleteMaterial(f,target);assert.equal(f.state.errorCode,'MODELING_REQUEST_PENDING');assert.equal(h.calls.length,0);
  f.call=async(action,input)=>{h.calls.push({action,input});return {status:'committed',document:{id:'external'}};};
  await deleteMaterial(f,{documentId:'external',name:'自动处理材料'});
  assert.equal(h.calls[0].input.url,'/api/documents/external?confirm=true');
  assert.equal(f.saved.deletedDocuments.external,true);assert.equal(f.saved.deletedDocuments.doc,undefined);
  assert.equal(f.saved.materialComposers['session:intent'].input,'private input');
});

test('empty-workspace authorization failures revoke the loaded UI instead of appearing as graph errors',async()=>{
  const h=fixture(),f=h.make();f.saved.conversationId=null;
  f.call=async()=>{throw Object.assign(Error('forbidden'),{status:403,code:'SEMANTICA_FORBIDDEN'});};
  await f.run(()=>ConversationFlow.prototype.snapshot.call(f));
  assert.equal(f.state.loaded,false);assert.equal(f.state.messages.length,0);assert.equal(f.state.detail,null);
});

test('stopped material has a delete entry; confirmed deletion uses scoped Bridge and clears all linked local sources',async()=>{
  const h=fixture(),f=h.make();assert.equal(canDeleteMaterial(f),true);
  assert.match(conversationHTML({id:'warehouse',state:'active'},null,null,true,f),/data-cv="material-delete"/);
  await deleteMaterial(f,target);
  assert.equal(h.calls.length,1);assert.equal(h.calls[0].action,'workbench-request');
  assert.equal(h.calls[0].input.url,'/api/documents/doc?confirm=true');assert.equal(h.calls[0].input.method,'DELETE');assert.equal(h.calls[0].input.warehouseId,'warehouse');
  assert.equal(f.state.detail,null);assert.equal(f.state.messages.length,0);assert.equal(f.intake.source,null);assert.equal(f.state.knowledge,null);
  assert.equal(f.saved.conversationId,null);assert.equal(f.saved.emptyMaterialWorkspace,true);
  assert.equal(f.saved.deletedMaterialConversations.session,true);
  assert.deepEqual(f.state.materialIndex.session,[]);assert.deepEqual(f.state.materialIndex.linked,[]);assert.equal(f.state.materialIndex.other.length,1);
  assert.deepEqual(f.saved.intakeReviews,{});assert.deepEqual(f.saved.confirmedGoals,{});
  assert.deepEqual(Object.keys(f.saved.materialComposers),['other:other']);assert.equal(f.changes.saved.scopes['["session","intent"]'],undefined);assert.equal(f.changes.saved.scopes['["linked","linked-intent"]'],undefined);assert.equal(f.changes.saved.scopes['["other","other"]'].draftId,'keep');
  assert.match(f.state.deletionNotice,/后台清理/);assert.equal(f.saved.materialDeletion,undefined);
  assert.deepEqual((await f.read('conversation-intents')).items.map(i=>i.id),['other']);
  assert.doesNotMatch(materialListHTML(f),/材料.txt/);
});
test('response loss survives reload and retries the original operation; other actions cannot race',async()=>{
  const h=fixture();h.setMode('lose');let f=h.make();await deleteMaterial(f,target);const operation=h.calls[0].input.body;
  let executed=false;await f.run(()=>{executed=true;});assert.equal(executed,false);
  assert.match(materialListHTML(f),/恢复删除请求/);
  f=h.make();f.restore();h.setMode('ok');await deleteMaterial(f,target);
  assert.equal(h.calls[1].input.body,operation);assert.equal(f.saved.deletedDocuments.doc,true);
});
test('definite refusal keeps data and a subsequent explicitly confirmed attempt uses a new operation',async()=>{
  const h=fixture(),f=h.make();h.setMode('refuse');await deleteMaterial(f,target);
  assert.equal(f.saved.materialDeletion,undefined);assert.equal(f.state.detail.document_id,'doc');
  h.setMode('ok');await deleteMaterial(f,target);assert.notEqual(h.calls[0].input.body,h.calls[1].input.body);
});
test('HTTP success with business failure is not treated as deletion',async()=>{
  const h=fixture(),f=h.make();h.setMode('invalid');await deleteMaterial(f,target);
  assert.ok(f.saved.materialDeletion);assert.equal(f.saved.deletedDocuments,undefined);assert.equal(f.state.detail.document_id,'doc');
});
test('double submit sends once and warehouse switching never clears the new workspace',async()=>{
  const h=fixture(),f=h.make();h.setMode('hold');const first=deleteMaterial(f,target);
  await deleteMaterial(f,target);assert.equal(h.calls.length,1);h.invalidate();h.release();await first;
  assert.equal(f.state.detail.document_id,'doc');assert.equal(f.saved.deletedDocuments,undefined);
});
test('accepted deletion clears caches even when subsequent state read fails',async()=>{
  const h=fixture(),f=h.make();f.snapshot=async()=>{throw Error('offline');};await deleteMaterial(f,target);
  assert.equal(f.state.messages.length,0);assert.equal(f.state.detail,null);assert.match(f.state.error,/删除已受理/);
  assert.equal(f.saved.deletedDocuments.doc,true);
});
test('unsettled draft writes block deletion and a changed confirmation target cannot delete another material',async()=>{
  const h=fixture(),f=h.make();f.changes.record.pending={action:'apply'};assert.equal(canDeleteMaterial(f),false);
  await deleteMaterial(f,target);assert.equal(h.calls.length,0);
  delete f.changes.record.pending;await deleteMaterial(f,{documentId:'other',name:'Other'});assert.equal(h.calls.length,0);
});
test('another material in the same conversation keeps its local draft and unsent composer',async()=>{
  const h=fixture(),f=h.make();f.saved.materialComposers['session:other']={input:'keep sibling'};
  f.changes.saved.scopes['["session","other"]']={draftId:'sibling'};
  await deleteMaterial(f,target);
  assert.equal(f.saved.materialComposers['session:other'].input,'keep sibling');
  assert.equal(f.changes.saved.scopes['["session","other"]'].draftId,'sibling');
});
test('deletion also clears unloaded continuation scopes, selections and composers',async()=>{
  const h=fixture(),f=h.make();
  f.saved.materialContinuations={continued:{documentId:'doc',conversationId:'unloaded',fromIntent:'old'}};
  f.saved.resumedIntents={old:'continued'};f.saved.selection={unloaded:'continued'};
  f.saved.materialComposers['unloaded:continued']={input:'private continuation'};
  f.saved.materialComposers['unloaded:old']={input:'private old input'};
  f.changes.saved.scopes['["unloaded","continued"]']={draftId:'private'};
  await deleteMaterial(f,target);
  assert.deepEqual(f.saved.materialContinuations,{});assert.deepEqual(f.saved.resumedIntents,{});
  assert.equal(f.saved.selection.unloaded,undefined);
  assert.equal(f.saved.materialComposers['unloaded:continued'],undefined);assert.equal(f.saved.materialComposers['unloaded:old'],undefined);
  assert.equal(f.changes.saved.scopes['["unloaded","continued"]'],undefined);
});
test('deletion recovery clears persisted source edits even when reload failed before reading any material',async()=>{
  const h=fixture();let f=h.make();h.setMode('lose');await deleteMaterial(f,target);
  f=h.make();f.restore();f.clearView();f.state.materialIndex={};f.state.loaded=false;
  h.setMode('ok');await deleteMaterial(f,target);
  assert.deepEqual(f.saved.intakeReviews,{});assert.deepEqual(f.saved.confirmedGoals,{});
  assert.deepEqual(Object.keys(f.saved.materialComposers),['other:other']);
  assert.equal(f.changes.saved.scopes['["session","intent"]'],undefined);
  assert.equal(f.changes.saved.scopes['["linked","linked-intent"]'],undefined);
});
test('failed local cleanup persistence retains the original request and blocks other writes until replay',async()=>{
  const h=fixture(),f=h.make();const save=f.storage.setItem;
  f.storage.setItem=(key,value)=>{if(key.endsWith('.changes'))throw Error('disk full');save(key,value);};
  await deleteMaterial(f,target);assert.ok(f.saved.materialDeletion);
  let changed=false;await f.run(()=>{changed=true;});assert.equal(changed,false);
  f.storage.setItem=save;await deleteMaterial(f,target);
  assert.equal(h.calls[0].input.body,h.calls[1].input.body);assert.equal(f.saved.materialDeletion,undefined);
});

test('deletion and later refresh never reload user messages from the deleted material session',async()=>{
  const h=fixture(),f=h.make();
  f.snapshot=ConversationFlow.prototype.snapshot.bind(f);
  await deleteMaterial(f,target);
  assert.equal(h.calls.some(c=>c.action==='conversation-messages'||c.action==='conversation-get'),false);
  await f.snapshot();assert.equal(f.state.messages.length,0);
  f.state.input='旧目标';await f.submitInput();assert.match(f.state.inputNotice,/先上传或选择材料/);
  assert.equal(h.calls.some(c=>c.action==='conversation-send'),false);
});

test('reload after deletion remains empty and does not select an older active conversation',async()=>{
  const h=fixture(),deleted=h.make();await deleteMaterial(deleted,target);
  const calls=[];const f=new ConversationFlow({warehouseId:'warehouse',identity:{boxId:'box',user:{id:1},dataScope:'personal'},storage:deleted.storage,
    call:async(action)=>{calls.push(action);if(action==='conversation-ontologies')return {items:[{id:'rules',status:'published',schema:{entity_types:[],relation_types:[]}}]};assert.equal(action,'conversation-list');return {items:[{id:'session',status:'active'},{id:'older',status:'active'}],has_more:false};}});
  await f.load();assert.equal(f.state.loaded,true);assert.equal(f.saved.conversationId,null);assert.equal(f.state.messages.length,0);
  assert.deepEqual(calls,['conversation-list','conversation-ontologies']);assert.equal(f.state.ontology.id,'rules');assert.deepEqual(f.state.conversations.map(c=>c.id),['older']);
});

test('old cached deletion is migrated before snapshot can restore historical user messages',async()=>{
  const h=fixture(),f=h.make();f.saved.deletedDocuments={doc:true};
  const calls=[];f.call=async(action)=>{
    calls.push(action);
    if(action==='conversation-get')return {revision:1,input_generation:1,source_stamp:'removed',latest_turn:{id:'old-turn'}};
    if(action==='conversation-messages')return {items:[{role:'user',sequence:1,content:'不应恢复的旧抽取目标'}],has_more:false};
    if(action==='conversation-intents')return {items:[h.item],has_more:false};
    throw Error('Unexpected '+action);
  };
  await ConversationFlow.prototype.snapshot.call(f);
  assert.equal(f.saved.conversationId,null);assert.equal(f.saved.emptyMaterialWorkspace,true);assert.equal(f.state.messages.length,0);
  assert.equal(calls.includes('conversation-turn'),false);
});

test('empty workspace distinguishes ontology read failures from no published definitions and can retry',async()=>{
  let failed=true;
  const f=new ConversationFlow({warehouseId:'warehouse',identity:{boxId:'box',user:{id:1},dataScope:'personal'},
    call:async(action)=>{assert.equal(action,'conversation-ontologies');if(failed)throw Error('offline');return {items:[{id:'draft',status:'draft',schema:{entity_types:[{name:'DRAFT'}]}}]};}});
  f.state.loaded=true;
  await f.snapshot();assert.equal(f.state.ontologyError,true);
  assert.match(conversationHTML({id:'warehouse',state:'active'},null,null,true,f),/当前本体读取失败/);
  failed=false;await f.snapshot();assert.equal(f.state.ontologyError,false);assert.equal(f.state.ontology,null);
  const html=conversationHTML({id:'warehouse',state:'active'},null,null,true,f);
  assert.match(html,/尚无已发布本体/);assert.doesNotMatch(html,/DRAFT/);
});
