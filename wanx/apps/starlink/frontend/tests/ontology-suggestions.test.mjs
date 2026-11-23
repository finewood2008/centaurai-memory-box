import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adoptSuggestion, updateTypeMappings, newOntologyOperationId, updateReuseTarget, removedReuseTarget, currentDirection } from '../src/ontologySuggestions.ts';

const schema = () => ({ entity_types: [{ name: 'PRODUCT', label: '产品', properties: [] }, { name: 'FEATURE', label: '功能', properties: [] }], relation_types: [] });
const mappings = () => ({ entity: {}, relation: {} });
const entity = { kind: 'entity', name: 'SOFTWARE', label: '软件' };
const relation = { kind: 'relation', name: 'SUPPORTS', label: '支持', source_types: ['SOFTWARE'], target_types: ['FEATURE'] };

test('reviewed definitions are retained on new entities, relations and properties', () => {
  const adoptedEntity = adoptSuggestion(schema(), {...entity,definition:' 可独立发布的软件 '},mappings(),'SOFTWARE','软件');
  const adoptedRelation = adoptSuggestion(adoptedEntity.schema,{...relation,definition:'文档明确记载软件支持某功能'},
    adoptedEntity.mappings,'SUPPORTS','支持');
  const property = {kind:'property',name:'edition',owner_kind:'entity',owner_name:'SOFTWARE',definition:'明确记录的发行版本'};
  const adoptedProperty = adoptSuggestion(adoptedRelation.schema,property,adoptedRelation.mappings,'edition','版本');
  const software = adoptedProperty.schema.entity_types.find(item=>item.name==='SOFTWARE');
  assert.equal(software.definition,'可独立发布的软件');
  assert.equal(adoptedProperty.schema.relation_types[0].definition,'文档明确记载软件支持某功能');
  assert.deepEqual(software.properties,[{name:'edition',label:'版本',required:false,definition:'明确记录的发行版本'}]);
  const base = schema();
  base.entity_types[0].definition = '已有产品类型定义';
  assert.deepEqual(adoptSuggestion(base,{...entity,definition:'不能覆盖复用目标'},mappings(),'SOFTWARE','软件','PRODUCT').schema,base);
});

test('selected reuse target follows its own kind and remains invalid after deletion and same-name recreation', () => {
  assert.equal(updateReuseTarget('PRODUCT','entity', [{kind:'relation',previous:'PRODUCT',next:'WRONG'}]),'PRODUCT');
  assert.equal(updateReuseTarget('PRODUCT','entity', [{kind:'entity',previous:'PRODUCT',next:'APP'}]),'APP');
  const removed=updateReuseTarget('PRODUCT','entity', [{kind:'entity',previous:'PRODUCT',next:null}]);
  assert.equal(removed,removedReuseTarget);
  assert.equal(updateReuseTarget(removed,'entity',[{kind:'entity',previous:'PRODUCT',next:'NEW_APP'}]),removedReuseTarget);
  assert.equal(updateReuseTarget('','entity',[{kind:'entity',previous:'PRODUCT',next:'APP'}]),'');
});

test('direction comparison uses current endpoint edits and confirmed entity mappings', () => {
  const original=schema(), aliases={entity:{SOFTWARE:'PRODUCT'},relation:{}};
  const existing={name:'HAS_FEATURE',label:'功能',source_types:['PRODUCT'],target_types:['FEATURE'],properties:[]};
  assert.equal(currentDirection(relation,existing,original,aliases),'same');
  assert.equal(currentDirection(relation,{...existing,source_types:['FEATURE'],target_types:['PRODUCT']},original,aliases),'reversed');
  assert.equal(currentDirection(relation,{...existing,source_types:['PRODUCT','FEATURE']},original,aliases),'compatible');
  assert.equal(currentDirection(relation,{...existing,target_types:['PRODUCT']},original,aliases),'different');
  assert.equal(currentDirection(relation,existing,original,{entity:{SOFTWARE:''},relation:{}}),'missing');
});

test('renamed entity remains comparable to pending relation suggestions', () => {
  const original=schema();original.entity_types[0].name='APP';
  const aliases=updateTypeMappings({entity:{SOFTWARE:'PRODUCT'},relation:{}},[{kind:'entity',previous:'PRODUCT',next:'APP'}]);
  assert.equal(currentDirection(relation,{name:'HAS_FEATURE',label:'功能',source_types:['APP'],target_types:['FEATURE'],properties:[]},original,aliases),'same');
});

test('reuse-only recommendations cannot silently become new types and still require explicit adoption', () => {
  const initial = schema(), recommendation = {...entity,allow_new_type:false,reuse_target:'PRODUCT'};
  assert.throws(()=>adoptSuggestion(initial,recommendation,mappings(),'NEW_TYPE','新类型'),/不支持直接新增/);
  const reused=adoptSuggestion(initial,recommendation,mappings(),'SOFTWARE','软件','PRODUCT');
  assert.deepEqual(reused.schema,initial);
  assert.equal(reused.mappings.entity.SOFTWARE,'PRODUCT');
  assert.equal(initial.entity_types.length,2);
});

test('drawer renames follow adopted aliases and original types, for both entity and relation owners', () => {
  const original = { entity: { SOFTWARE: 'PRODUCT' }, relation: { SUPPORTS: 'HAS_FEATURE' } };
  const updated = updateTypeMappings(original, [
    {kind:'entity', previous:'PRODUCT', next:'APP'}, {kind:'entity', previous:'APP', next:'SERVICE'},
    {kind:'relation', previous:'HAS_FEATURE', next:'PROVIDES'},
  ]);
  assert.equal(updated.entity.SOFTWARE, 'SERVICE');
  assert.equal(updated.entity.PRODUCT, 'SERVICE');
  assert.equal(updated.relation.SUPPORTS, 'PROVIDES');
  assert.equal(updated.relation.HAS_FEATURE, 'PROVIDES');
  assert.equal(original.entity.SOFTWARE, 'PRODUCT');
});

test('deleted mapping cannot bind to a recreated same-name type without explicit reprocessing', () => {
  const removed = updateTypeMappings({entity:{SOFTWARE:'PRODUCT'}, relation:{}}, [{kind:'entity',previous:'PRODUCT',next:null}]);
  assert.throws(() => adoptSuggestion(schema(), relation, removed, 'SUPPORTS', '支持'));
  assert.throws(() => adoptSuggestion(schema(), {kind:'property',owner_kind:'entity',owner_name:'PRODUCT'}, removed, 'code','编号'));
  const acknowledged = adoptSuggestion(schema(), entity, removed, 'SOFTWARE', '软件', 'PRODUCT');
  assert.deepEqual(adoptSuggestion(acknowledged.schema,relation,acknowledged.mappings,'SUPPORTS','支持').schema.relation_types[0].source_types,['PRODUCT']);
});

test('merging several source types deduplicates endpoints', () => {
  const result = adoptSuggestion(schema(), {...relation, source_types:['SOFTWARE','PRODUCT']}, {entity:{SOFTWARE:'PRODUCT'},relation:{}}, 'SUPPORTS','支持');
  assert.deepEqual(result.schema.relation_types[0].source_types,['PRODUCT']);
});

test('operation IDs do not require secure-context-only randomUUID', () => {
  const a=newOntologyOperationId(), b=newOntologyOperationId();
  assert.match(a,/^[a-f0-9]{32}$/); assert.notEqual(a,b);
});

test('human rename propagates through adopted relation endpoints and optional property owner', () => {
  const initial = schema(), aliases = mappings();
  let value = adoptSuggestion(initial, entity, aliases, 'APP', '应用');
  value = adoptSuggestion(value.schema, relation, value.mappings, relation.name, relation.label);
  value = adoptSuggestion(value.schema, { kind: 'property', owner_kind: 'entity', owner_name: 'SOFTWARE', name: 'edition', required: true }, value.mappings, 'edition', '版本');
  assert.deepEqual(value.schema.relation_types[0].source_types, ['APP']);
  assert.deepEqual(value.schema.entity_types.at(-1).properties, [{ name: 'edition', label: '版本', required: false }]);
  assert.equal(initial.entity_types.length, 2);
  assert.deepEqual(aliases, mappings());
});

test('explicit merge keeps existing definition and maps subsequent dependencies', () => {
  const original = schema();
  original.entity_types[0].properties.push({ name: 'code', label: '编号', required: true });
  let value = adoptSuggestion(original, entity, mappings(), 'SOFTWARE', '软件', 'PRODUCT');
  assert.deepEqual(value.schema, original);
  value = adoptSuggestion(value.schema, relation, value.mappings, 'SUPPORTS', '支持');
  assert.deepEqual(value.schema.relation_types[0].source_types, ['PRODUCT']);
  assert.equal(value.schema.entity_types[0].properties[0].required, true);
});

test('missing dependencies, duplicate names and stale merge target leave input untouched', () => {
  const initial = schema(), before = structuredClone(initial);
  assert.throws(() => adoptSuggestion(initial, relation, mappings(), 'SUPPORTS', '支持'));
  assert.throws(() => adoptSuggestion(initial, entity, mappings(), 'PRODUCT', '重复'), /同名/);
  assert.throws(() => adoptSuggestion(initial, entity, mappings(), 'SOFTWARE', '软件', 'MISSING'), /不存在/);
  assert.throws(() => adoptSuggestion(initial, {kind:'property', owner_kind:'entity', owner_name:'SOFTWARE'}, mappings(), 'edition', '版本'), /先采纳/);
  assert.deepEqual(initial, before);
});

test('relation merge preserves endpoint constraints; attributes target the reused relation', () => {
  const initial = schema();
  initial.relation_types.push({name:'HAS_FEATURE', label:'具有功能', source_types:['PRODUCT'], target_types:['FEATURE'], properties:[]});
  let value = adoptSuggestion(initial, relation, mappings(), 'SUPPORTS', '支持', 'HAS_FEATURE');
  value = adoptSuggestion(value.schema, {kind:'property', owner_kind:'relation', owner_name:'SUPPORTS'}, value.mappings, 'note', '说明');
  assert.equal(value.schema.relation_types.length, 1);
  assert.deepEqual(value.schema.relation_types[0].source_types, ['PRODUCT']);
  assert.equal(value.schema.relation_types[0].properties[0].required, false);
  assert.throws(() => adoptSuggestion(value.schema, {kind:'property', owner_kind:'relation', owner_name:'SUPPORTS'}, value.mappings, 'note', '重复'), /已存在/);
});
