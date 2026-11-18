const warehouse = { id: 'fixture', name: '迁移验收仓', description: '合成测试资料', state: 'active',
  document_count: 0, entity_count: 2, relation_count: 1, created_at: '2026-11-17T00:00:00Z' };
const graph = { nodes: [{ entity_id: 'person', canonical_name: '测试人员', entity_type: 'PERSON' }, { entity_id: 'project', canonical_name: '测试项目', entity_type: 'PROJECT' }],
  edges: [{ fact_id: 'relation', subject_entity_id: 'person', object_entity_id: 'project', relation_type: 'WORKS_ON', evidence: [{ document_id: 'doc', document_version_id: 'cited-version', excerpt: '引用版正文', segment_id: 'cited-segment', locator_json: JSON.stringify({ page: 2, source_char_start: 0, source_char_end: 5 }) }] }] };
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
const fixtureProcessing = { revision: 1, inherit: false, stages: [], affected_warehouses: [],
  effective: { mode: 'automatic', extraction: fixtureModel, inference_options: { thinking_mode: 'auto' } } };
const fixtureJob = { id: 'failed-job', kind: 'search_index', status: 'failed', stage: 'failed', document_name: '测试材料.txt',
  updated_at: '2026-11-17T00:00:00Z', error_message: '合成失败原因', completed_units: 2, total_units: 5 };
window.fixtureWarehouses = [warehouse, { ...warehouse, id: 'second', name: '第二验收仓' }];
window.fixtureLaunchTarget = { requestId: 'fixture', target: { warehouseId: warehouse.id, view: 'graph' } };
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
      warehouses: { items: window.fixtureWarehouses }, runtime: {}, capabilities: { accepted_suffixes: ['txt', 'pdf'], document_max_bytes: 10000000 } };
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
    else if (action === 'search') value = { items: [{ document_id: 'doc', original_name: '测试材料.txt', text: '检索验收片段', channels: ['keyword'] }] };
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
      if (input.url === '/api/ontologies' && input.method === 'POST') {
        const { name, schema } = JSON.parse(input.body);
        value = { id: 'sample-draft', name, schema, status: 'draft', version_number: 2 };
        ontologyVersions.unshift(value);
      }
      else if (input.url.includes('ontologies')) value = { items: ontologyVersions };
      else if (input.url.includes('settings/status')) value = { version: 'fixture', phase: 'ready', native_owner_management: true, document_formats: [], local_models: {} };
      else if (input.url.startsWith('/api/jobs?')) value = { items: [], total: 0, activity: { foreground_count: 0, sensitive_job: null } };
      else if (input.url.includes('graph')) value = { nodes: [], edges: [] };
      else value = { items: [], total: 0 };
    }
    return { ok: true, value };
  },
});
window.fixturePanel.sync({ canLaunchApplications: true, account: { accountId: 'fixture' }, connection: { deviceId: 'fixture-box' } }, true, true);
window.fixturePanel.mount();
document.getElementById('starlink-banner-create').addEventListener('click', () => window.fixturePanel.action('new-warehouse'));
