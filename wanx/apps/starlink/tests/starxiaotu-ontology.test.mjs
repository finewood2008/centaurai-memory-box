import test from 'node:test';
import assert from 'node:assert/strict';
import {ontologyQuery,ontologyChanges,ontologyFieldChanges,ontologyProgress,renderOntologyProgress,renderOntologyQuery,renderOntologyDialogue} from '../ui/starxiaotu-ontology.mjs';

const schema={entity_types:[{name:'CONTRACT',label:'合同',properties:[]}],relation_types:[]};
const row=(id,status)=>({id,name:'项目规则',version_number:1,status,schema:structuredClone(schema)});

test('ontology queries distinguish effective rules, drafts and history and expand the named type',()=>{
  const payload={items:[row('draft','draft'),row('current','published'),row('previous','archived')]};
  const result=ontologyQuery(payload,'合同有哪些属性？');
  assert.equal(result.current.id,'current');assert.equal(result.matched[0].name,'CONTRACT');
  const markup=renderOntologyQuery(result);
  assert.match(markup,/当前生效/);assert.match(markup,/草稿/);assert.match(markup,/历史版本/);assert.match(markup,/本体 ID：current/);
  assert.match(markup,/CONTRACT/);
});

test('empty rules and malformed receipts are not presented as corpus search results',()=>{
  assert.match(ontologyQuery({items:[]}).answer,/尚无本体/);
  assert.match(ontologyQuery({items:[row('draft','draft')]}).answer,/没有生效本体/);
  for(const payload of [{}, {items:[{id:'bad'}]}, {items:[{...row('broken','published'),schema:{entity_types:[],relation_types:[{}]}}]}])assert.throws(()=>ontologyQuery(payload),/回执不完整/);
});

test('schema diffs retain exact property requirements and do not conflate labels or types',()=>{
  const after=structuredClone(schema);
  after.entity_types[0].properties.push({name:'expires_at',label:'到期日期',required:false});
  const changes=ontologyChanges(schema,after);
  assert.equal(changes.length,1);assert.equal(changes[0].name,'CONTRACT');assert.equal(changes[0].before.properties.length,0);
  assert.equal(changes[0].after.properties[0].required,false);
  assert.equal(ontologyChanges(undefined,after),null);
});

test('suggestion cards focus on the changed property and preserve requiredness, definitions and removals',()=>{
  const before=schema.entity_types[0],after={...before,properties:[{name:'expires_at',label:'到期日期',required:false,definition:'合同约定的到期日'}]};
  assert.deepEqual(ontologyFieldChanges(before,after),[{field:'新增属性 · 到期日期（expires_at）',before:'未配置',after:'到期日期 · 选填 · 合同约定的到期日'}]);
  const required={...after,properties:[{...after.properties[0],required:true}]};
  assert.deepEqual(ontologyFieldChanges(after,required),[{field:'属性 · 到期日期（expires_at）',before:'到期日期 · 选填 · 合同约定的到期日',after:'到期日期 · 必填 · 合同约定的到期日'}]);
  assert.deepEqual(ontologyFieldChanges(after,before),[{field:'删除属性 · 到期日期（expires_at）',before:'到期日期 · 选填 · 合同约定的到期日',after:'未配置'}]);
});

test('relation summaries show endpoint identities and ignore set ordering',()=>{
  const relation={name:'OWNS',label:'拥有',source_types:['A','B'],target_types:['C'],properties:[]};
  assert.deepEqual(ontologyFieldChanges(relation,{...relation,source_types:['B','A']}),[]);
  const rows=ontologyFieldChanges(relation,{...relation,target_types:['D']});
  assert.equal(rows.length,1);assert.equal(rows[0].field,'关系方向');
  assert.equal(rows[0].before,'A、B → C');assert.equal(rows[0].after,'A、B → D');
});

test('progress distinguishes suggestions, applying a draft, publication review and completed publication',()=>{
  assert.deepEqual(ontologyProgress(),{step:0,complete:false});
  assert.deepEqual(ontologyProgress({awaitingProposal:true}),{step:1,complete:false});
  assert.deepEqual(ontologyProgress({awaitingProposal:true,pending:{kind:'apply'}}),{step:2,complete:false});
  const flow={current:{status:'editing',draft:{revision:1}},hasChanges:()=>true};
  assert.deepEqual(ontologyProgress(flow),{step:3,complete:false});
  flow.awaitingProposal=true;
  assert.deepEqual(ontologyProgress(flow),{step:1,complete:false});
  flow.current.status='published';
  assert.deepEqual(ontologyProgress(flow),{step:3,complete:true});
  assert.doesNotMatch(renderOntologyProgress(flow,'<img src=x>'),/<img|aria-current="step"/);
  flow.current.status='editing';flow.needsRefresh=true;
  assert.match(renderOntologyProgress(flow,'测试项目'),/需读取最新状态/);
});

test('query and proposal displays escape content and publication requires this preview confirmation',()=>{
  const payload={items:[{...row('current','published'),name:'<img src=x onerror=alert(1)>'}]};
  assert.doesNotMatch(renderOntologyQuery(ontologyQuery(payload)),/<img/);
  const flow={current:{status:'editing',draft:{revision:1,schema,questions:[]}},baselineSchema:schema,hasChanges:()=>true,
    preview:{resource_id:'preview',preview_digest:'digest',impact:{valid:true,total:0,items:[]}}};
  assert.match(renderOntologyDialogue(flow),/data-sx-ontology="publish" disabled/);
  assert.doesNotMatch(renderOntologyDialogue(flow,'digest'),/data-sx-ontology="publish" disabled/);
  flow.needsRefresh=true;
  assert.match(renderOntologyDialogue(flow,'digest'),/data-sx-ontology="publish" disabled/);
});
