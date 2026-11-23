import test from 'node:test';
import assert from 'node:assert/strict';
import { ontologyIssues } from '../src/ontology.ts';
import { WAREHOUSE_ONTOLOGY_PROFILES, getWarehouseOntologyProfile } from '../../shared/warehouse-ontology-profiles.mjs';

test('warehouse ontology choices share a valid base and add only their own types', () => {
  assert.deepEqual(WAREHOUSE_ONTOLOGY_PROFILES.map(({id}) => id), ['general', 'projects', 'research', 'operations']);
  const {id, schema: base} = getWarehouseOntologyProfile();
  assert.equal(id, 'general');
  assert.deepEqual(base.entity_types.map(({name}) => name),
    ['PERSON', 'ORG', 'PROJECT', 'EVENT', 'TASK', 'DECISION', 'DOCUMENT', 'CONCEPT', 'GPE']);
  assert.deepEqual(base.relation_types.find(({name}) => name === 'WORKS_AT')?.source_types, ['PERSON']);
  assert.deepEqual(base.relation_types.find(({name}) => name === 'WORKS_AT')?.target_types, ['ORG']);

  const ownTypes = {
    general: [],
    projects: ['MILESTONE', 'DELIVERABLE', 'RISK'],
    research: ['RESEARCH_QUESTION', 'CLAIM', 'RESEARCH_CONCLUSION'],
    operations: ['PRODUCT', 'CONTRACT', 'PROCESS', 'PROCESS_STEP'],
  };
  for (const {id} of WAREHOUSE_ONTOLOGY_PROFILES) {
    const {schema} = getWarehouseOntologyProfile(id);
    assert.deepEqual(ontologyIssues(schema), [], id);
    assert.deepEqual(schema.entity_types.slice(0, base.entity_types.length), base.entity_types, id);
    assert.deepEqual(schema.relation_types.slice(0, base.relation_types.length), base.relation_types, id);
    assert.deepEqual(schema.entity_types.slice(base.entity_types.length).map(({name}) => name), ownTypes[id]);
  }
});

test('warehouse ontology drafts are independent copies and require a known choice', () => {
  const profile = getWarehouseOntologyProfile('projects');
  profile.schema.entity_types[0].properties[0].label = '草稿';
  profile.schema.relation_types[0].target_types.length = 0;

  for (const id of ['general', 'projects']) {
    const {schema} = getWarehouseOntologyProfile(id);
    assert.equal(schema.entity_types[0].properties[0].label, '角色');
    assert.deepEqual(schema.relation_types[0].target_types, ['ORG']);
  }
  assert.equal(getWarehouseOntologyProfile('unsupported'), null);
});
