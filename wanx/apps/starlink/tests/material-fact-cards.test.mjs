import test from 'node:test';
import assert from 'node:assert/strict';
import {factCardHTML,factDiffHTML,factName,factType,selectedFactsHTML,visibleFactItems} from '../ui/material-fact-cards.mjs';
import {ConversationChanges} from '../ui/conversation-changes.mjs';
const schema={entity_types:[{name:'PRODUCT',label:'产品',properties:[{name:'version',label:'产品版本'}]},{name:'DOCUMENT',label:'文档',properties:[]}],relation_types:[{name:'BELONGS_TO',label:'属于',properties:[]}]};
const entity={id:'private-uuid',kind:'entity',payload:{name:'研发平台',type:'PRODUCT',aliases:[],disambiguation_key:'auto:PRODUCT:platform',properties:{version:'V1.0',empty:null,blank:' ',list:[],map:{},zero:0,flag:false}},evidence:[{excerpt:'平台版本为 V1.0 <原文>',segment_id:'segment-private',locator:{page_number:2}}]};
const primary=html=>html.split('<details class="cv-fact-technical"')[0];
test('fact cards use ontology labels, retain zero and false, omit empty values and fold identifiers',()=>{
  const html=factCardHTML(entity,{schema});const visible=primary(html);
  assert.match(visible,/研发平台.*产品/s);assert.match(visible,/产品版本.*V1.0/s);assert.match(visible,/<dd>0<\/dd>/);assert.match(visible,/<dd>否<\/dd>/);
  assert.doesNotMatch(visible.replace(/<[^>]+>/g,''),/auto:PRODUCT|private-uuid|segment-private|disambiguation_key|aliases|empty|blank/);
  assert.match(html,/技术详情/);assert.match(html,/auto:PRODUCT/);assert.match(html,/&lt;原文&gt;/);assert.doesNotMatch(html,/<原文>/);
});
test('relation names resolve endpoints from the server or current material without exposing endpoint keys',()=>{
  const relation={id:'r',kind:'relation',payload:{type:'BELONGS_TO',source_candidate_key:entity.id,target_candidate_key:'target'},endpoints:{target_candidate_key:{name:'研发组织'}},evidence:[]};
  assert.equal(factName(relation,[entity]),'研发平台 → 研发组织');
  assert.match(primary(factCardHTML(relation,{schema,context:[entity]})),/研发平台 → 属于 → 研发组织/);
  const unresolved=primary(factCardHTML({...relation,endpoints:{}},{schema}));assert.doesNotMatch(unresolved,/private-uuid|target/);assert.match(unresolved,/待核对对象/);
});
test('diffs highlight type and property changes, keeping draft and proposal states distinct',()=>{
  const after={...entity,payload:{...entity.payload,type:'DOCUMENT',properties:{version:'V2.0'}}};
  const html=factDiffHTML({item_id:entity.id,before:entity,after},{schema});
  assert.match(html,/建议 · 未应用/);assert.match(html,/分类.*产品.*文档/s);assert.match(html,/产品版本.*V1.0.*V2.0/s);
  assert.doesNotMatch(html.split('<details>')[0],/private-uuid|PRODUCT|DOCUMENT|disambiguation_key/);
  assert.match(factDiffHTML({before:entity,after:null},{schema,status:'草稿 · 尚未发布'}),/草稿 · 尚未发布/);
});
test('source content is only inserted into the matching card and does not manufacture a description',()=>{
  const options={schema,selectable:true,source:{text:'只属于第一项的上下文',end:5,total_chars:10},sourceFor:entity.id};
  assert.match(factCardHTML(entity,options),/原文上下文/);
  assert.doesNotMatch(factCardHTML({...entity,id:'second'},options),/只属于第一项的上下文/);
  assert.doesNotMatch(factCardHTML(entity,{schema}),/cv-fact-description/);
});
test('page filtering and select-page operate on the same visible set and retain exact fact IDs',()=>{
  const state={summary:{status:'editing',revision:1,ontology:schema},items:{revision:1,items:[entity,{...entity,id:'doc',payload:{name:'说明书',type:'DOCUMENT'}}]},selected:[],factFilter:{keyword:'V1.0',type:'PRODUCT'}};
  assert.deepEqual(visibleFactItems(state,schema).map(i=>i.id),[entity.id]);
  const c=Object.create(ConversationChanges.prototype);c.state=state;c.f={state:{loaded:true},saved:{},emit(){},changes:c};c.saved={scopes:{'':{}}};c.scope='';c.selectPage();
  assert.deepEqual(c.state.selected,[entity.id]);assert.equal(state.items.items.length,2);
});
test('selected names survive pagination but are never guessed from unrelated identifiers',()=>{
  const flow={state:{ontology:{schema}},changes:{state:{selected:[entity.id,'unknown'],knownItems:{[entity.id]:entity},items:{items:[]}},independent:false}};
  const html=selectedFactsHTML(flow);assert.match(html,/正在调整这 2 项/);assert.match(html,/研发平台/);assert.match(html,/其他页所选条目/);assert.doesNotMatch(html,/private-uuid|unknown/);
});

test('a configured classification label is respected even when it equals the type identifier',()=>{
  const custom={entity_types:[{name:'PRODUCT',label:'PRODUCT'}]};
  assert.equal(factType(entity,custom),'PRODUCT');assert.equal(factType(entity,{entity_types:[]}),'未命名分类');
});

test('blocking errors remain visible even when a response also marks them reviewed',()=>{
  const item={...entity,issues:[{severity:'error',reviewed:true,message:'实体类型不符合约束'},{severity:'warning',reviewed:true,message:'原文已核对'}]};
  const html=primary(factCardHTML(item,{schema}));assert.match(html,/分类待核对/);assert.match(html,/存在阻塞错误/);assert.match(html,/实体类型不符合约束/);assert.doesNotMatch(html,/原文已核对/);
});

test('equal-looking property values with different JSON types still appear in the change summary',()=>{
  const before={...entity,payload:{...entity.payload,properties:{version:1}}},after={...entity,payload:{...entity.payload,properties:{version:'1'}}};
  const summary=factDiffHTML({item_id:entity.id,before,after},{schema}).split('<details>')[0];
  assert.match(summary,/产品版本/);assert.match(summary,/数值/);assert.match(summary,/文本/);
});

test('changes to source evidence and aliases are disclosed alongside a name change',()=>{
  const before=entity,after={...entity,payload:{...entity.payload,name:'新名称',aliases:['另一个名称']},evidence:[{excerpt:'新依据',segment_id:'new-segment'}]};
  const summary=factDiffHTML({item_id:entity.id,before,after},{schema}).split('<details>')[0];
  assert.match(summary,/其他名称/);assert.match(summary,/原文依据/);assert.match(summary,/内容已调整/);
});

test('a failed source read clears the previous source window before awaiting the replacement',async()=>{
  const c=Object.create(ConversationChanges.prototype);c.state={summary:{id:'draft',revision:1},source:{text:'上一处来源'},sourceFor:entity.id};
  c.owner={documentId:'document',editor:{session:'s',generation:'1'}};c.f={run:fn=>fn()};
  c.call=async()=>{assert.equal(c.state.source,null);throw Error('read failed');};
  await assert.rejects(c.source('second-source',entity.id),/read failed/);assert.equal(c.state.source,null);assert.equal(c.state.sourceFor,null);
});

test('changing to a distinct endpoint with the same name is explicitly disclosed',()=>{
  const before={id:'relation',kind:'relation',payload:{type:'BELONGS_TO',source_candidate_key:'source',target_candidate_key:'first'},endpoints:{source_candidate_key:{name:'产品'},target_candidate_key:{name:'同名组织'}}};
  const after={...before,payload:{...before.payload,target_candidate_key:'second'}};
  const summary=factDiffHTML({before,after},{schema}).split('<details>')[0];
  assert.match(summary,/关系终点/);assert.match(summary,/同名组织.*对应对象已变化/s);assert.doesNotMatch(summary,/first|second/);
});

test('reordering keys within an unchanged property object does not invent a property change',()=>{
  const before={...entity,payload:{...entity.payload,properties:{version:{a:1,b:2}}}},after={...entity,payload:{...entity.payload,properties:{version:{b:2,a:1}}}};
  const summary=factDiffHTML({before,after},{schema}).split('<details>')[0];assert.doesNotMatch(summary,/产品版本/);
});
