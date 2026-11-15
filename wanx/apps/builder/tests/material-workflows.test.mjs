import test from 'node:test';
import assert from 'node:assert/strict';
import {createMaterialBrowser} from '../integration/team-client/starlink/materials.mjs';
const state={document_id:'d',document_version_id:'v',workflow_revision:1,automatic_processing:{},label:'草稿待核对',processing_mode:'dialogue',tasks:[],conversations:[{conversation_id:'c',intent_id:'i',conversation_status:'active'}],actions:{prepare_automatic:{allowed:false,reason:'请继续核对现有草稿'},reextract:{allowed:false,reason:'请继续核对现有草稿'},edit_source:{allowed:false,reason:'当前正文不可编辑'},start_dialogue:{allowed:false}}};
function fixture(){let scope={scope:'one',warehouseId:'warehouse'},fail=false;const calls=[];
  const browser=createMaterialBrowser({personal:true,getContext:()=>scope,changed(){},call:async(action,input)=>{calls.push([action,input]);if(action==='document')return {document:{original_name:'source'},version:{id:'v'}};if(action==='document-text')return {version_id:'v',text:'text',end:4,total_chars:4};if(action==='material-workflow'){if(fail)throw Error('offline');return state}return {opened:true};}});
  return {browser,calls,fail(){fail=true},switch(){scope={scope:'other',warehouseId:'new'}}};
}
test('WANX shows dialogue state, disables automatic re-extraction and opens exact existing conversation',async()=>{
  const f=fixture();await f.browser.action('material-open',{id:'d'});
  const html=f.browser.render({documents:[{id:'d'}],total:1,offset:0});
  assert.match(html,/草稿待核对/);assert.match(html,/data-data-action="reextract-document"[^>]*disabled/);
  await f.browser.action('material-dialogue',{conversation:'c',intent:'i'});
  assert.deepEqual(f.calls.at(-1),['open-starlink',{warehouseId:'warehouse',view:'conversation',documentId:'d',conversationId:'c',intentId:'i'}]);
  assert.equal(f.calls.some(([a])=>/extract|correct|upload/.test(a)),false);
});
test('failed status refresh revokes cached actions and forged conversation locator is rejected',async()=>{
  const f=fixture();await f.browser.action('material-open',{id:'d'});
  await assert.rejects(f.browser.action('material-dialogue',{conversation:'foreign',intent:'i'}));
  f.fail();await f.browser.action('material-open',{id:'d'});
  const html=f.browser.render({documents:[{id:'d'}],total:1,offset:0});
  assert.match(html,/状态读取失败/);assert.doesNotMatch(html,/data-data-action="material-dialogue"/);
  assert.match(html,/data-data-action="material-edit"[^>]*disabled/);
});

test('HTTP 200 mismatched document or missing actions reports structure diagnostics, not server failure',async()=>{
  for(const patch of [{document_id:'foreign'},{actions:null},{document_version_id:'old'}]){
    const browser=createMaterialBrowser({personal:true,getContext:()=>({scope:'s',warehouseId:'w'}),changed(){},call:async action=>{
      if(action==='document')return {version:{id:'v'}};
      if(action==='document-text')return {version_id:'v',text:'body'};
      return {...state,...patch,_transport:{httpStatus:200,requestId:'req-200'}};
    }});
    await browser.action('material-open',{id:'d'});
    const html=browser.render({documents:[{id:'d',workflow:state}],total:1,offset:0});
    assert.match(html,/响应结构或材料版本不匹配（HTTP 200；MATERIAL_RESPONSE_INVALID；请求 req-200）/);
    assert.match(html,/data-data-action="material-edit"[^>]*disabled/);
  }
});
test('forbidden material stops before fetching text and does not revive a previously cached body',async()=>{
  let denied=false,textCalls=0;
  const browser=createMaterialBrowser({personal:true,getContext:()=>({scope:'s',warehouseId:'w'}),changed(){},call:async action=>{
    if(action==='document')return {version:{id:'v'}};
    if(action==='document-text'){textCalls++;return {version_id:'v',text:'private-source'};}
    if(denied)throw Object.assign(Error('sensitive upstream'),{httpStatus:403,code:'MODELING_OWNER_REQUIRED',requestId:'req-403'});
    return state;
  }});
  await browser.action('material-open',{id:'d'});denied=true;await browser.action('material-open',{id:'d'});
  assert.equal(textCalls,1);
  const html=browser.render({documents:[{id:'d',workflow:state}],total:1,offset:0});
  assert.doesNotMatch(html,/private-source|sensitive upstream/);assert.match(html,/HTTP 403/);
  await browser.action('material-edit',{});assert.equal(textCalls,1);
});
test('new automatic availability is independent of legacy reextract; edit denial reason remains visible',async()=>{
  const browser=createMaterialBrowser({personal:true,getContext:()=>({scope:'s',warehouseId:'w'}),changed(){},call:async action=>{
    if(action==='document')return {version:{id:'v'}};
    if(action==='document-text')return {version_id:'v',text:'body'};
    return {...state,actions:{...state.actions,prepare_automatic:{allowed:true}}};
  }});
  await browser.action('material-open',{id:'d'});
  const html=browser.render({documents:[{id:'d'}],total:1,offset:0});
  assert.doesNotMatch(html,/data-data-action="reextract-document"[^>]*disabled/);
  assert.match(html,/data-data-action="material-edit"[^>]*disabled/);assert.match(html,/当前正文不可编辑/);
});
