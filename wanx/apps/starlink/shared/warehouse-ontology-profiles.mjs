export const DEFAULT_WAREHOUSE_ONTOLOGY_PROFILE = 'general';
export const WAREHOUSE_ONTOLOGY_NAME = '基础知识本体';

export const WAREHOUSE_ONTOLOGY_PROFILES = Object.freeze([
  Object.freeze({id: 'general', label: '通用知识', description: '日常资料、会议记录、项目和个人知识整理'}),
  Object.freeze({id: 'projects', label: '项目与协作', description: '项目推进、会议跟进和交付管理'}),
  Object.freeze({id: 'research', label: '资料与研究', description: '专题调研、访谈分析和研究结论'}),
  Object.freeze({id: 'operations', label: '业务与流程', description: '产品服务、合同、运营和制度流程'}),
]);

function entity(name, label, definition, classification_boundary, fields) {
  const properties = fields.map(([name, label, definition]) => ({name, label, definition, required: false}));
  return {name, label, definition, classification_boundary, properties};
}

function relation(name, label, source_types, target_types, definition) {
  return {name, label, source_types, target_types, definition, properties: []};
}

const commonEntities = [
  entity('PERSON', '人物', '资料中有明确身份的个人。', '身份未确认的同名人物分别记录。仅有职位或泛称时保留在原文中。', [
    ['role', '角色', '资料中明确写出的身份或职责。'],
    ['alias', '别名', '资料明确指向同一人物的别称。'],
  ]),
  entity('ORG', '组织', '公司、部门、团队、机构或其他有识别名称的群体。', '临时活动归事件。有明确称呼和共同职责的团队可以作为组织。', [
    ['category', '组织类别', '例如公司、部门、团队。'],
    ['short_name', '简称', '资料明确给出的简称。'],
  ]),
  entity('PROJECT', '项目', '围绕明确目标的一组工作，具有可区分的范围。', '单次活动归事件，具体可执行事项归待办。', [
    ['objective', '目标', '资料明确提出的预期成果。'],
    ['status', '状态', '照录已有依据的项目状态。'],
    ['start_date', '开始日期', '保留原文日期精度。'],
    ['end_date', '结束日期', '保留原文日期精度，并区分计划和实际日期。'],
  ]),
  entity('EVENT', '事件', '有明确名称或边界的一次活动，例如会议、访谈、发布。', '计划中的活动可以记录状态和计划时间。只有原文确认发生时才记录实际时间。', [
    ['category', '活动类别', '例如会议、访谈、发布。'],
    ['scheduled_time', '计划时间', '原文明确安排的时间，保留其精度。'],
    ['occurred_time', '实际时间', '原文确认活动已经发生的时间，保留其精度。'],
  ]),
  entity('TASK', '待办', '能执行并检查完成情况的具体事项。', '泛泛的目标归项目或主题。已确认的选择归决定，有明确行动内容时可另提取待办。', [
    ['due_date', '截止日期', '原文明确的截止日期，保留日期精度。'],
    ['status', '状态', '照录待办在资料中的状态。'],
    ['completion_criteria', '完成条件', '原文明确写出的交付要求或验收条件。'],
  ]),
  entity('DECISION', '决定', '资料中已明确确认、通过或采纳的选择或结论。', '讨论意见、拟议方案和未确认的建议保留在原文中。', [
    ['confirmed_date', '确认日期', '保留原文日期精度。'],
    ['rationale', '理由', '资料明确写出的决策理由。'],
    ['scope', '适用范围', '决定适用的对象或范围。'],
  ]),
  entity('DOCUMENT', '资料', '被用作事实对象、值得独立查找的文档、记录或材料。', '每条事实的原文出处由系统保存。文件只有确实需要建立知识关系或独立检索时才另建资料实体。', [
    ['category', '资料类别', '例如纪要、报告、手册。'],
    ['document_date', '资料日期', '保留原文日期精度。'],
    ['version', '版本', '资料明确标注的版本。'],
  ]),
  entity('CONCEPT', '主题', '值得跨资料追踪、有稳定称呼的议题、概念或原则。', '普通关键词留在原文供检索。具体工作、活动和行动分别归项目、事件和待办。', [
    ['meaning', '含义', '资料给出的概念定义或具体含义。'],
    ['alias', '别名', '资料明确指向同一主题的别称。'],
  ]),
  entity('GPE', '地点', '可识别的地理区域或具体场所，例如城市、园区、办公地点。', '地点和同名组织分别记录。仅有方位词时保留在原文中。', [
    ['category', '地点类别', '例如城市、园区、办公室。'],
    ['address', '地址', '资料明确写出的地点地址。'],
  ]),
];

const commonRelations = [
  relation('WORKS_AT', '任职于', ['PERSON'], ['ORG'], '原文确认该人物在该组织任职或具有明确工作归属。'),
  relation('PARTICIPATES_IN', '参与', ['PERSON', 'ORG'], ['PROJECT', 'EVENT'], '原文明确说明该人物或组织参与了该项目或事件。'),
  relation('RESPONSIBLE_FOR', '负责', ['PERSON', 'ORG'], ['TASK', 'PROJECT'], '原文明确指定该人物或组织承担具体待办或项目的责任。'),
  relation('PART_OF', '属于', ['EVENT', 'TASK', 'DECISION'], ['PROJECT'], '原文明确表明该事件、待办或决定属于该项目。'),
  relation('REACHES_DECISION', '形成', ['EVENT'], ['DECISION'], '该事件中明确形成、通过或确认了这项决定。'),
  relation('CREATES_TASK', '产生', ['DECISION'], ['TASK'], '原文明确说明该待办由这项已确认的决定产生。'),
  relation('OCCURRED_AT', '发生于', ['EVENT'], ['GPE'], '原文确认该地点是事件实际发生的位置。'),
  relation('RECORDS', '记录', ['DOCUMENT'], ['PROJECT', 'EVENT', 'DECISION'], '该资料实际记录了项目、事件或决定的内容。仅提及名称时保留原文供查找。'),
  relation('ABOUT', '涉及', ['DOCUMENT'], ['CONCEPT'], '该资料明确以此为主题或展开说明。偶然出现的关键词留在正文。'),
];

const expansions = {
  projects: {
    entity_types: [
      entity('MILESTONE', '里程碑', '项目中用于判断阶段是否达成的可确认节点。', '通常以清楚的达成条件或阶段边界描述。第一场普通会议仍归事件。', [
        ['target_date', '目标日期', '保留原文日期精度。'],
        ['completion_criteria', '达成条件', '原文列出的阶段验收条件。'],
        ['status', '状态', '照录计划、已达成等明确状态。'],
      ]),
      entity('DELIVERABLE', '交付物', '项目要求验收、交付的可单独识别的成果。', '草稿等资料只有被明确列为交付成果时才属于此类。原文出处由系统保存。', [
        ['acceptance_criteria', '验收标准', '原文记录的验收标准。'],
        ['status', '状态', '原文写明的交付状态。'],
      ]),
      entity('RISK', '风险', '资料中明确指出可能影响目标的不确定情况。', '已经发生的问题归事件或待办。有明确后续不确定性时可另记风险。', [
        ['impact', '影响', '资料明确指出的影响。'],
        ['severity', '等级', '资料明确给出的风险等级。'],
        ['mitigation', '应对措施', '资料中明确写出的应对措施。'],
      ]),
    ],
    relation_types: [
      relation('HAS_MILESTONE', '包含里程碑', ['PROJECT'], ['MILESTONE'], '原文将该里程碑归入项目的阶段计划。'),
      relation('HAS_DELIVERABLE', '包含交付物', ['PROJECT'], ['DELIVERABLE'], '原文明确将该成果列为项目交付物。'),
      relation('DEPENDS_ON', '依赖', ['TASK'], ['TASK'], '主体待办需要客体待办的结果或完成后才能继续。'),
      relation('THREATENS', '影响', ['RISK'], ['PROJECT', 'MILESTONE', 'DELIVERABLE'], '资料明确指出该风险可能影响这些项目目标或成果。'),
    ],
  },
  research: {
    entity_types: [
      entity('RESEARCH_QUESTION', '研究问题', '调研、访谈或分析材料中可单独追踪的提问。', '有待作答的提问归此类。已经形成的研究结果归研究结论。', [
        ['scope', '问题范围', '原文明确限定的对象或范围。'],
      ]),
      entity('CLAIM', '论点', '作者、受访者或资料明确提出的可讨论主张。', '收录时保留主张的来源、表达者、原文语气和限定条件。', [
        ['qualification', '限定条件', '原文对论点适用范围的限定。'],
      ]),
      entity('RESEARCH_CONCLUSION', '研究结论', '调研或分析中明确给出的研究结果。', '有明确结论表述才收录。对于拟议的工作做法，应保留讨论状态。', [
        ['scope', '适用范围', '原文给出的结论适用范围。'],
        ['limitations', '局限', '资料明确指出的样本或方法限制。'],
      ]),
    ],
    relation_types: [
      relation('SUPPORTS', '支持', ['DOCUMENT'], ['CLAIM'], '该资料提供明确支持论点的内容。原文片段作为关系证据保存。'),
      relation('REFUTES', '反驳', ['DOCUMENT'], ['CLAIM'], '该资料给出明确反对论点的论证或反证。'),
      relation('ANSWERS', '回答', ['RESEARCH_CONCLUSION'], ['RESEARCH_QUESTION'], '该研究结论明确回答了该研究问题。'),
    ],
  },
  operations: {
    entity_types: [
      entity('PRODUCT', '产品或服务', '业务中能单独识别、有明确称呼的产品或服务。', '普通的行动事项归待办，承载工作目标的范围归项目。', [
        ['category', '类别', '资料明确给出的产品或服务类别。'],
        ['version', '版本', '资料明确标注的版本。'],
      ]),
      entity('CONTRACT', '合同', '用于明确当事方权利义务的协议或合同文件。', '资料写明是意向、草拟或已签署时保留对应状态。普通报价单仍可归资料。', [
        ['contract_number', '合同编号', '资料中出现的合同编号。'],
        ['status', '签署状态', '照录草拟、已签署等明确状态。'],
        ['effective_date', '生效日期', '原文明确的生效日期，保留其精度。'],
      ]),
      entity('PROCESS', '流程', '用于反复执行的一套有明确目标的操作步骤。', '一次性项目或事件与可重复使用的流程分别记录。', [
        ['scope', '适用范围', '流程适用的业务或对象。'],
        ['version', '版本', '资料明确标注的流程版本。'],
      ]),
      entity('PROCESS_STEP', '流程步骤', '流程中拥有明确动作或结果的可识别环节。', '流程步骤可供多次执行。本次执行的行动事项单独作为待办。', [
        ['sequence', '顺序', '只有原文明确排序时才记录。'],
        ['expected_result', '预期结果', '资料中明确写出的步骤输出。'],
      ]),
    ],
    relation_types: [
      relation('COVERS_PRODUCT', '涉及', ['CONTRACT'], ['PRODUCT'], '原文明确将该产品或服务列入合同范围。'),
      relation('HAS_PROCESS_STEP', '包含步骤', ['PROCESS'], ['PROCESS_STEP'], '资料明确将该步骤归入该流程。'),
    ],
  },
};

export function getWarehouseOntologyProfile(id = DEFAULT_WAREHOUSE_ONTOLOGY_PROFILE) {
  const profile = WAREHOUSE_ONTOLOGY_PROFILES.find(profile => profile.id === id);
  if (!profile) return null;
  const expansion = expansions[id];
  const schema = {
    entity_types: [...commonEntities, ...(expansion?.entity_types ?? [])],
    relation_types: [...commonRelations, ...(expansion?.relation_types ?? [])],
  };
  return {...profile, schema: structuredClone(schema)};
}
