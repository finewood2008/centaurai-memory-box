// Registered personal onboarding and rule-review operations; no arbitrary paths or scopes.
export const onboardingActions = new Set(['onboarding-read', 'onboarding-save', 'onboarding-warehouses',
  'onboarding-create', 'onboarding-context', 'onboarding-scope-publish', 'onboarding-confirm', 'onboarding-generate', 'onboarding-suggestion',
  'onboarding-rules', 'onboarding-rule-prepare', 'onboarding-rule-publish', 'onboarding-ontologies']);
const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const op = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,120}$/.test(value);
const revision = value => Number.isSafeInteger(value) && value >= 0;
export const answerLimits = {industry:200, occupation:200, background:8000, material_types:8000, purpose:16000, questions:8000};
const error = () => { throw Object.assign(new Error('MODELING_INVALID_REQUEST'), {code:'MODELING_INVALID_REQUEST',status:422}); };
const object = v => v && typeof v === 'object' && !Array.isArray(v);
const only = (v, keys) => object(v) && Object.keys(v).every(k => keys.includes(k));
function answers(value, draft) {
  const extra = {warehouse_name:60, flow_step:20, flow_mode:20, background_sample:60, purpose_sample:60, creation_operation:120};
  const limits = draft ? {...answerLimits,...extra} : answerLimits;
  if (!only(value, Object.keys(limits)) || Object.entries(value).some(([k,v]) => typeof v !== 'string' || [...v].length > limits[k])) error();
  if (draft && (value.flow_step && !['background','purpose','confirm'].includes(value.flow_step) ||
    value.flow_mode && !['create','profile'].includes(value.flow_mode) || value.creation_operation && !op(value.creation_operation))) error();
}
export const scopeFieldLimits = Object.freeze({
  industry:0, occupation:0, service_objects:6, purposes:6, material_sources:6,
  questions_to_answer:6, excluded_scope:6, uncertain_items:8,
});
export function scopePatchError(value) {
  if (!only(value,Object.keys(scopeFieldLimits))) return 'scope';
  return Object.keys(value).find(field => {
    const item = value[field], limit = scopeFieldLimits[field];
    return limit === 0 ? typeof item !== 'string' || [...item].length > 200 :
      !Array.isArray(item) || item.length > limit ||
      item.some(text => typeof text !== 'string' || !text.trim() || [...text].length > 300);
  });
}
export function onboardingRequest(action, input = {}) {
  if (!onboardingActions.has(action)) return null;
  const keys = {
    'onboarding-read':[], 'onboarding-warehouses':[], 'onboarding-save':['body'],
    'onboarding-create':['onboardingId','body'], 'onboarding-context':['warehouseId'],
    'onboarding-scope-publish':['warehouseId','body'],
    'onboarding-confirm':['warehouseId','body'], 'onboarding-generate':['warehouseId','body'],
    'onboarding-suggestion':['warehouseId','suggestionId'],
    'onboarding-rules':['warehouseId','suggestionId'], 'onboarding-rule-prepare':['warehouseId','body'],
    'onboarding-rule-publish':['warehouseId','previewId','body'], 'onboarding-ontologies':['warehouseId'],
  }[action];
  if (!only(input, keys)) error();
  for (const key of keys.filter(k => k !== 'body')) if (!id(input[key])) error();
  const paths = {
    'onboarding-read':'/modeling/onboarding', 'onboarding-save':'/modeling/onboarding',
    'onboarding-warehouses':'/modeling/warehouses',
    'onboarding-create':`/modeling/onboarding/${input.onboardingId}/warehouse`,
    'onboarding-context':`/warehouses/${input.warehouseId}/modeling/suggestion-context`,
    'onboarding-scope-publish':`/warehouses/${input.warehouseId}/modeling/warehouse-scope/publish`,
    'onboarding-confirm':`/warehouses/${input.warehouseId}/modeling/answer-confirmations`,
    'onboarding-generate':`/warehouses/${input.warehouseId}/modeling/answer-suggestions`,
    'onboarding-suggestion':`/warehouses/${input.warehouseId}/modeling/answer-suggestions/${input.suggestionId}`,
    'onboarding-rules':`/warehouses/${input.warehouseId}/modeling/answer-suggestions/${input.suggestionId}/rules`,
    'onboarding-rule-prepare':`/warehouses/${input.warehouseId}/modeling/rule-previews`,
    'onboarding-rule-publish':`/warehouses/${input.warehouseId}/modeling/rule-previews/${input.previewId}/publish`,
    'onboarding-ontologies':`/warehouses/${input.warehouseId}/workbench/ontologies`,
  };
  const write = keys.includes('body');
  if (write) {
    const b = input.body;
    const fields = action === 'onboarding-save' ? ['operation_id','expected_revision','answers','status']
      : action === 'onboarding-create' ? ['operation_id','expected_revision','name','purpose']
      : action === 'onboarding-scope-publish' ? ['operation_id','expected_revision','base_ontology_id','changes','confirmed']
      : action === 'onboarding-confirm' ? ['operation_id','expected_revision','onboarding_revision','expected_confirmation_id','answers']
      : action === 'onboarding-rule-prepare' ? ['operation_id','proposal_id','expected_draft_id','name','schema','decisions']
      : action === 'onboarding-rule-publish' ? ['operation_id','schema_digest','confirmed']
      : ['operation_id','confirmation_id','base_ontology_id'];
    if (!only(b,fields) || !op(b.operation_id)) error();
    if (['onboarding-save','onboarding-create','onboarding-confirm'].includes(action) && !revision(b.expected_revision)) error();
    if (action === 'onboarding-scope-publish' &&
        (!revision(b.expected_revision) || !id(b.base_ontology_id) || b.confirmed!==true ||
        scopePatchError(b.changes) || !Object.keys(b.changes).length)) error();
    if (action === 'onboarding-rule-prepare') {
      if (!id(b.proposal_id) || b.expected_draft_id != null && !id(b.expected_draft_id) ||
        typeof b.name !== 'string' || !b.name.trim() || [...b.name].length>120 ||
        !only(b.schema,['entity_types','relation_types']) || !Array.isArray(b.schema.entity_types) || !Array.isArray(b.schema.relation_types) ||
        !Array.isArray(b.decisions) || b.decisions.length>12) error();
      for (const d of b.decisions) if (!only(d,['suggestion_id','action','target_name','owner_kind','owner_name']) ||
        !id(d.suggestion_id) || !['add','reuse','ignore'].includes(d.action) || !['','entity','relation'].includes(d.owner_kind) ||
        typeof d.target_name!=='string' || typeof d.owner_name!=='string') error();
    }
    if (action === 'onboarding-rule-publish' && (b.confirmed!==true || typeof b.schema_digest!=='string' || !/^[a-f0-9]{64}$/.test(b.schema_digest))) error();
    if (action === 'onboarding-save') {
      answers(b.answers, true);
      if (b.status !== undefined && !['in_progress','skipped','completed'].includes(b.status)) error();
    }
    if (action === 'onboarding-create' && (typeof b.name !== 'string' || !b.name.trim() || [...b.name].length > 60 ||
      b.purpose !== undefined && (typeof b.purpose !== 'string' || [...b.purpose].length > 16000))) error();
    if (action === 'onboarding-confirm') {
      answers(b.answers, false);
      if (!revision(b.onboarding_revision) || b.expected_confirmation_id != null && !op(b.expected_confirmation_id)) error();
    }
    if (action === 'onboarding-generate' && (!op(b.confirmation_id) || !op(b.base_ontology_id))) error();
    if (new TextEncoder().encode(JSON.stringify(b)).length > 128 * 1024) error();
  }
  return {path:paths[action],method:write ? 'POST':'GET', ...(write ? {body:structuredClone(input.body)} : {}),
    timeoutMs:action === 'onboarding-generate' ? 300000 : 60000};
}
export const identityKey = context => JSON.stringify([context.accountId ?? null, context.boxId,
  context.user?.id, context.dataScope || 'personal']);
