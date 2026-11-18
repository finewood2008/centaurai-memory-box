import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renameEntity, ontologyIssues, sameOntologyType } from '../src/ontology.ts';

test('published definitions ignore JSON key order but still detect direction and property changes', () => {
  const local={source_types:['PERSON'],target_types:['ORG'],name:'WORKS_AT',label:'任职于',properties:[{required:false,name:'role',label:'岗位'}]};
  const published={name:'WORKS_AT',label:'任职于',properties:[{name:'role',label:'岗位',required:false}],source_types:['PERSON'],target_types:['ORG']};
  assert.equal(sameOntologyType(local,published),true);
  assert.equal(sameOntologyType(local,{...published,source_types:['ORG'],target_types:['PERSON']}),false);
  assert.equal(sameOntologyType(local,{...published,properties:[{name:'role',label:'岗位',required:true}]}),false);
  assert.equal(sameOntologyType(undefined,published),false);
});

const fixture = () => ({ entity_types: [
  { name: 'PERSON', label: '人物', properties: [{ name: 'title', label: '职位', required: true }] },
  { name: 'ORG', label: '组织', properties: [] },
], relation_types: [{ name: 'WORKS_AT', label: '任职于', source_types: ['PERSON'], target_types: ['ORG'], properties: [] }] });

test('entity rename keeps both endpoint references and original version immutable, including clearing and retyping', () => {
  const original = fixture();
  original.relation_types[0].target_types.push('PERSON');
  const renamed = renameEntity(renameEntity(original, 0, ''), 0, 'MEMBER');
  assert.deepEqual(renamed.relation_types[0].source_types, ['MEMBER']);
  assert.deepEqual(renamed.relation_types[0].target_types, ['ORG', 'MEMBER']);
  assert.equal(original.entity_types[0].name, 'PERSON');
  assert.deepEqual(ontologyIssues(renamed), []);
  assert.equal(renamed.entity_types[0].properties[0].required, true);
});

test('invalid names, duplicate properties and missing relation endpoints block creating a draft', () => {
  const value = fixture();
  value.entity_types[0].name = '123';
  value.entity_types[0].properties.push({ name: 'title', label: '重复', required: false });
  value.relation_types[0].target_types = [];
  const issues = ontologyIssues(value);
  assert.ok(issues.some(x => x.includes('实体 1')));
  assert.ok(issues.some(x => x.includes('属性标识')));
  assert.ok(issues.some(x => x.includes('起点')));
  assert.ok(issues.some(x => x.includes('终点')));
});

test('entity-only definitions are valid; duplicate entity or relation identifiers are rejected', () => {
  const value = fixture();
  value.relation_types = [];
  assert.deepEqual(ontologyIssues(value), []);
  value.entity_types.push(structuredClone(value.entity_types[0]));
  assert.ok(ontologyIssues(value).length);
  const relations = fixture();
  relations.relation_types.push(structuredClone(relations.relation_types[0]));
  assert.ok(ontologyIssues(relations).some(x => x.includes('关系 2')));
});
