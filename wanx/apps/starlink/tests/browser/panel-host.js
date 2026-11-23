const warehouse = { id: 'fixture', name: '迁移验收仓', description: '合成测试资料', state: 'active',
  document_count: 0, entity_count: 2, relation_count: 1, created_at: '2026-11-17T00:00:00Z' };
const graph = { nodes: [{ entity_id: 'person', canonical_name: '测试人员', entity_type: 'PERSON' }, { entity_id: 'project', canonical_name: '测试项目', entity_type: 'PROJECT' }],
  edges: [{ fact_id: 'relation', subject_entity_id: 'person', object_entity_id: 'project', relation_type: 'WORKS_ON', evidence: [{ id: 'source', document_id: 'doc', document_version_id: 'cited-version', excerpt: '引用版正文', segment_id: 'cited-segment', locator_json: JSON.stringify({ page: 2, source_char_start: 0, source_char_end: 5 }) }] }] };
const sampleSchema = { entity_types: [
  { name: "PERSON", label: "人物" }, { name: "PROJECT", label: "项目" },
  { name: "DOCUMENT", label: "资料" }, { name: "EVENT", label: "事件" },
  { name: "CONCEPT", label: "概念" }, { name: "ORGANIZATION", label: "小组" },
], relation_types: [{ name: "WORKS_ON", label: "参与" }] };
const publishedSchema = {
  entity_types: sampleSchema.entity_types.map(item => ({ ...item, properties: item.name === 'PERSON' ? [
    { name: 'name', label: '姓名', required: true },
  ] : [] })),
  relation_types: [{ ...sampleSchema.relation_types[0], source_types: ['PERSON'], target_types: ['PROJECT'], properties: [] }],
};
let rulesDialogue;
const ontologyVersions = [{ id: 'sample-schema', name: '验收本体', status: 'published', version_number: 1, schema: publishedSchema }];
if (document.documentElement.dataset.sample === "true") {
  const items = [
    ["interviews", "用户访谈", "PROJECT", "project", "包括"],
    ["brief", "设计方案", "DOCUMENT", "project", "产出"],
    ["schedule", "上线计划", "DOCUMENT", "project", "依据"],
    ["prototype", "交互原型", "DOCUMENT", "brief", "转化自"],
    ["workshop", "共创讨论", "EVENT", "interviews", "衍生"],
    ["needs", "查阅需求", "CONCEPT", "interviews", "提炼"],
    ["accessibility", "无障碍检查", "CONCEPT", "prototype", "验收"],
    ["release", "小范围试用", "EVENT", "schedule", "安排"],
    ["owners", "访谈小组", "ORGANIZATION", "interviews", "负责"],
    ["results", "试用反馈", "DOCUMENT", "release", "形成"],
  ];
  for (const [id, name, kind, parent, relation] of items) {
    graph.nodes.push({ entity_id: id, canonical_name: name, entity_type: kind });
    graph.edges.push({ fact_id: "sample-" + id, subject_entity_id: parent, object_entity_id: id, relation_type: relation, evidence: [] });
  }
}
const fixtureModel = { id: 'fixture-model', name: '验收模型', location: 'local', route: 'wanx', available: true, revision: 1, inference_options: { thinking_modes: ['auto'] } };
const fixtureProcessing = { revision: 1, inherit: false, affected_warehouses: [],
  stages: [{ role: 'embedding', name: '验收向量模型', location: 'external', available: true }],
  effective: { mode: 'automatic', extraction: fixtureModel, inference_options: { thinking_mode: 'auto' } } };
const fixtureJob = { id: 'failed-job', kind: 'search_index', status: 'failed', stage: 'failed', document_name: '测试材料.txt',
  updated_at: '2026-11-17T00:00:00Z', error_message: '合成失败原因', completed_units: 2, total_units: 5 };
const sensitivePolicies = new Map();
const defaultPolicy = { enabled: true, semantic_enabled: false, revision: 0, rules: [], builtin_defaults: [],
  rule_capacity: { max_custom: 30, prompt_limit: 5000 }, scan: { status: 'not_started' } };
window.fixtureSensitivePolicies = sensitivePolicies;
window.fixtureWarehouses = [warehouse, { ...warehouse, id: 'second', name: '第二验收仓' }];
window.fixtureLaunchTarget = { requestId: 'fixture', target: { warehouseId: warehouse.id, view: 'search' } };
window.fixtureCalls = [];
window.fixtureOverrides = {};
window.wanxClient = { onStarlinkEvent() {} };
window.fixturePanel = window.createStarlinkPanelView({
  changed() {},
  async request(_name, { action, input = {} }) {
    window.fixtureCalls.push({ action, input });
    if (window.fixtureOverrides[action]) return window.fixtureOverrides[action](input);
    let value = {};
    if (action === 'initialize') value = { identity: { accountId: 'fixture', boxId: 'fixture-box', dataScope:'personal', user: { id: 1, name: '验收用户' } },
      warehouses: { items: window.fixtureWarehouses }, runtime: {}, capabilities: { accepted_suffixes: ['txt', 'pdf'], document_max_bytes: 10000000, source_annotations: {search_version:1} } };
    else if (action === 'warehouses' || action === 'onboarding-warehouses') value = { items: window.fixtureWarehouses };
    else if (action === 'onboarding-read') value = {id:'fixture-record', revision:0, status:'in_progress', answers:{}, created_workspace_id:null};
    else if (action === 'warehouse') value = warehouse;
    else if (action === 'graph') value = graph;
    else if (action === 'conversation-ontologies' && document.documentElement.dataset.sample === 'true') {
      value = { items: [{ id: "sample-schema", status: "published", schema: sampleSchema }] };
    }
    else if (action === 'jobs') value = { items: [fixtureJob], total: 1 };
    else if (['documents', 'conversation-ontologies', 'conversation-list', 'conversation-material-workflows'].includes(action)) value = { items: [], total: 0, has_more: false };
    else if (action === 'processing') value = fixtureProcessing;
    else if (action === 'model-catalog') value = { items: [fixtureModel], default: fixtureModel };
    else if (action === 'launch-target') value = window.fixtureLaunchTarget;
    else if (action === 'space-list') value = { parent: input.parent || '', items: [], breadcrumbs: [] };
    else if (action === 'document-text' && input.id === 'doc' && input.versionId === 'cited-version' && input.start === 0 && input.end === undefined)
      value = { document_id: 'doc', version_id: 'cited-version', start: 0, end: 25, total_chars: 25, text: '引用版上一段引用版正文',
        locators: [{ segment_id: 'preceding-segment', start: 0, end: 20 }, { segment_id: 'cited-segment', start: 20, end: 25 }] };
    else if (action === 'document-text' && input.id === 'doc' && input.versionId === 'cited-version' && input.start === 20)
      value = { document_id: 'doc', version_id: 'cited-version', start: 20, end: 25, total_chars: 25, text: '引用版正文' };
    else if (action === 'document-text' && input.id === 'doc' && input.versionId === 'cited-version' && input.start === 0 && input.end === 20)
      value = { document_id: 'doc', version_id: 'cited-version', start: 0, end: 20, total_chars: 25, text: '引用版上一段' };
    else if (action === 'document') value = { document: { id: input.id, original_name: '测试材料.txt', document_format: 'txt', size_bytes: 16, segment_count: 1 },
      version: { id: 'fixture-version', version_number: 1 }, segments: [{ id: 'fixture-segment', text: '校对前正文' }] };
    else if (action === 'workbench-request') {
      if (input.url.startsWith('/api/ontology-suggestions/materials?') || input.url === '/api/ontology-suggestions/materials') {
        value = {items:window.fixtureOntologyTask ? [{document_id:'doc',document_version_id:'cited-version',
          status:window.fixtureOntologyTask,count:window.fixtureOntologyTask==='completed'?1:0}] : []};
      }
      else if (input.url === '/api/ontology-suggestions/materials/doc/review' && input.method === 'POST') {
        value = {id:'material-preview', base_ontology_id:'sample-schema', documents:[
          {id:'doc',version_id:'cited-version',name:'引用测试.txt',sampled_segments:1,total_segments:1,truncated:false}
        ],suggestions:[{id:'auto-type',kind:'entity',name:'FEATURE',label:'功能',definition:'资料中描述的功能',reason:'原文说明了功能',
          similar_to:[],evidence:{document_id:'doc',version_id:'cited-version',segment_id:'cited-segment',
            document_name:'引用测试.txt',quote:'引用版正文'}}]};
      }
      else if (input.url.startsWith('/api/sensitive/settings')) {
        const policy = sensitivePolicies.get(input.warehouseId) || defaultPolicy;
        value = policy;
        if (input.method === 'POST') {
          if (window.fixturePauseSensitiveSave) await new Promise(resolve => { window.fixtureReleaseSensitiveSave = resolve; });
          const { expected_revision, enabled, semantic_enabled, rules } = JSON.parse(input.body);
          if (expected_revision !== policy.revision) return { ok: false, code: 'SENSITIVE_REVISION_CONFLICT', status: 409 };
          value = { ...policy, revision: policy.revision + 1, enabled, semantic_enabled, rules };
          sensitivePolicies.set(input.warehouseId, value);
        }
      }
      else if (input.url === '/api/sensitive/preview') {
        const { text, expected_revision } = JSON.parse(input.body);
        const policy = sensitivePolicies.get(input.warehouseId) || defaultPolicy;
        if (expected_revision !== policy.revision) return { ok: false, code: 'SENSITIVE_REVISION_CONFLICT', status: 409 };
        const savedRule = policy.rules[0];
        value = savedRule ? { text: text.replace(savedRule.name, savedRule.mask), status: 'masked' } : { text, status: 'clean' };
      }
      else if (input.url === '/api/ontologies' && input.method === 'POST') {
        const { name, schema } = JSON.parse(input.body);
        value = { id: 'sample-draft', name, schema, status: 'draft', version_number: 2 };
        ontologyVersions.unshift(value);
      }
      else if (input.url === '/api/ontologies/sample-draft/publish' && input.method === 'POST') {
        const draft = ontologyVersions.find(item => item.id === 'sample-draft');
        const current = ontologyVersions.find(item => item.status === 'published');
        if (current) current.status = 'superseded';
        draft.status = 'published';
        value = draft;
      }
      else if (input.url.includes('ontologies')) value = { items: ontologyVersions };
      else if (input.url.includes('settings/status')) value = { version: 'fixture', phase: 'ready', native_owner_management: true, document_formats: [], local_models: {} };
      else if (input.url.startsWith('/api/jobs?')) value = { items: [], total: 0, activity: { foreground_count: 0, sensitive_job: null } };
      else if (input.url.startsWith('/api/conversations?')) {
        value = { items: rulesDialogue ? [{id: rulesDialogue.conversation_id, scenario: 'change', created_at: '2026-11-19T00:00:00Z'}] : [], has_more: false };
      }
      else if (input.url === '/api/conversations' && input.method === 'POST') {
        rulesDialogue = {conversation_id: 'rules-round', current_ontology_id: 'sample-schema', initialized: false, status: 'uninitialized'};
        value = {resource_id: 'rules-round'};
      }
      else if (input.url === '/api/conversations/rules-round/ontology-edit') value = structuredClone(rulesDialogue);
      else if (input.url.endsWith('/ontology-edit/initialize')) {
        Object.assign(rulesDialogue, {status: 'editing', initialized: true, base_ontology_id: 'sample-schema',
          draft_digest: 'a'.repeat(64), draft: {revision: 0, name: '验收草稿', schema: structuredClone(publishedSchema), questions: []},
          history: {items: []}});
        value = {resource_id: 'initialized'};
      }
      else if (input.url.endsWith('/ontology-edit/proposals')) {
        const {instruction} = JSON.parse(input.body);
        const schema = structuredClone(publishedSchema);
        schema.entity_types[0].properties.push({name:'role',label:'职务',required:false});
        rulesDialogue.proposal = {resource_id:'fixture-proposal', proposal_digest:'b'.repeat(64),
          expected_revision: 0, draft_digest: rulesDialogue.draft_digest, status:'proposed',
          summary:'为人物增加职务属性。', schema, questions:[], dependencies:[]};
        rulesDialogue.history.items.unshift({resource_id:'fixture-proposal', status:'proposed',
          instruction, answer:rulesDialogue.proposal.summary});
        value = {resource_id:'fixture-proposal',status:'proposed'};
      }
      else if (input.url.endsWith('/ontology-edit/proposals/fixture-proposal/apply')) {
        rulesDialogue.draft.revision++;
        rulesDialogue.draft.schema = rulesDialogue.proposal.schema;
        rulesDialogue.draft_digest = 'c'.repeat(64);
        rulesDialogue.proposal.status = 'applied';
        value = {resource_id:'fixture-applied',status:'applied'};
      }
      else if (input.url.endsWith('/ontology-edit/preview')) {
        value = {resource_id:'fixture-preview',draft_revision:rulesDialogue.draft.revision,
          draft_digest:rulesDialogue.draft_digest,preview_digest:'d'.repeat(64),impact:{
            valid:true,total:2,offset:0,has_more:false,items:[{document_id:'doc-0',name:'合成资料甲.txt',
              certainty:'possible',protected:true,reasons:['已发布资料可能包含职务信息。']}]},
        };
      }
      else if (input.url.startsWith('/api/owner/graph?')) value = graph;
      else if (input.url.startsWith('/api/ontology-updates/sample-schema?')) {
        value = { target: ontologyVersions.find(row=>row.status==='published'), changes: [], total: 2, offset: 0, limit: 20,
          batch_update_available: true, items: ['合成资料甲.txt','合成资料乙.txt'].map((name,i)=>({
            document_id: 'doc-'+i, name, preview_token: 'a'.repeat(64), reasons: [], selectable: true, protected: i===0,
          })) };
      }
      else if (input.url === '/api/ontology-updates/sample-schema/start' && input.method === 'POST') {
        value = {items: JSON.parse(input.body).selections.map(row=>({document_id:row.document_id}))};
      }
      else if (input.url.includes('graph')) value = { nodes: [], edges: [] };
      else value = { items: [], total: 0 };
    }
    return { ok: true, value };
  },
});
window.fixturePanel.sync({ canLaunchApplications: true, account: { accountId: 'fixture' }, connection: { deviceId: 'fixture-box' } }, true, true);
window.fixturePanel.mount();
