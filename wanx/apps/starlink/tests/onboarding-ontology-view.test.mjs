import test from 'node:test';
import assert from 'node:assert/strict';
import {ontologyGraphHTML,ontologyChangesHTML,ontologyDefinitionsHTML} from '../ui/onboarding-ontology-view.mjs';
const schema={entity_types:[{name:'PERSON',label:'人物',properties:[]},{name:'CONTRACT',label:'合同',definition:'法律文件',properties:[{name:'number',label:'编号',required:true}]}],relation_types:[{name:'SIGNS',label:'签署',source_types:['PERSON'],target_types:['CONTRACT'],properties:[]}]};
test('graph uses actual directed schema edges and keeps isolated types without fabricated links',()=>{
  const html=ontologyGraphHTML(schema,[{kind:'entity_types',name:'CONTRACT',before:null,after:schema.entity_types[1]}]);
  assert.match(html,/签署：人物 → 合同/);assert.match(html,/ob-ontology-node added/);
  assert.equal((html.match(/class="ob-ontology-edge /g)||[]).length,1);
  assert.match(ontologyGraphHTML({...schema,relation_types:[]}),/尚未定义关系/);
  assert.equal((ontologyGraphHTML({...schema,relation_types:[]}).match(/class="ob-ontology-node /g)||[]).length,2);
});
test('parallel, multi-endpoint and self relationships remain visible without invalid geometry',()=>{
  const r={name:'LINK',label:'关联',source_types:['PERSON','CONTRACT'],target_types:['PERSON','CONTRACT'],properties:[]};
  const html=ontologyGraphHTML({...schema,relation_types:[schema.relation_types[0],r]});
  assert.equal((html.match(/class="ob-ontology-edge /g)||[]).length,5);
  assert.doesNotMatch(html,/NaN|Infinity|undefined/);
  assert.match(html,/关联：人物 → 人物/);
});
test('human readable changes preserve before/after properties and escape all model labels',()=>{
  const after={...schema.entity_types[1],label:'<img src=x>',properties:[{name:'number',label:'合同编号',required:false,definition:'业务编号'}]};
  const html=ontologyChangesHTML([{kind:'entity_types',name:'CONTRACT',before:schema.entity_types[1],after}],schema);
  assert.match(html,/修改前/);assert.match(html,/修改后/);assert.match(html,/必填/);assert.match(html,/选填/);assert.match(html,/业务编号/);
  assert.doesNotMatch(html,/<img|<pre/);assert.match(html,/&lt;img/);
  assert.doesNotMatch(ontologyDefinitionsHTML({...schema,entity_types:[after]}),/<img/);
  assert.doesNotMatch(ontologyGraphHTML({...schema,entity_types:[after]}),/<img/);
});
