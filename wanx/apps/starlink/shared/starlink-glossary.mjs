export const starlinkGlossary = [
  {
    title: '星图与本体',
    terms: [
      { key: 'ontology', label: '本体', guide: 'ontology', definition: '一张星图的整理规则，规定从资料里识别哪些对象、记录哪些属性，以及对象之间能建立什么关系。' },
      { key: 'entity', label: '实体', guide: 'entity', definition: '星图里单独记录的一个对象，例如一个人、一家公司或一份合同。' },
      { key: 'entity-type', label: '实体类型', guide: 'ontology', definition: '一类对象的整理规则。例如「合同」类型可以规定要记录合同编号和到期日。' },
      { key: 'instance', label: '实例', guide: 'entity', definition: '按照某个类型整理出的具体记录。例如「合同」是类型，「某份采购合同」是这个类型的实例。' },
      { key: 'ontology-label', label: '本体标签', guide: 'ontology', definition: '类型在界面上的显示名称，可以用来识别或筛选图中的记录。' },
      { key: 'type-id', label: '类型标识', guide: 'ontology', definition: '系统在规则里引用类型时使用的固定名称。例如用 PERSON 代表界面上的「人物」。' },
      { key: 'display-name', label: '显示名称', guide: 'ontology', definition: '用户在列表、图谱和表单里看到的名称，例如「人物」或「任职于」。' },
      { key: 'relation', label: '关系', guide: 'relation', definition: '两个具体实体之间的一条连接，例如「张三 → 参与 → 某项目」。' },
      { key: 'relation-type', label: '关系类型', guide: 'ontology', definition: '一类连接的整理规则，说明连接代表什么，以及允许连接哪些类型的对象。' },
      { key: 'relation-direction', label: '关系方向', guide: 'ontology', definition: '规定关系从哪类实体指向哪类实体。例如「员工 → 任职于 → 公司」的起点是员工，终点是公司。' },
      { key: 'property', label: '属性', guide: 'ontology', definition: '用来描述一个实体或一条关系的字段，例如合同的到期日、任职关系的起始日期。' },
      { key: 'required-property', label: '必填与选填', guide: 'ontology', definition: '缺少必填属性的抽取结果无法通过校验。选填属性在资料里找不到时可以留空。' },
      { key: 'classification-boundary', label: '分类边界', guide: 'ontology', definition: '用来分清相似类型的条件。例如已签署的文件算合同，尚未签署的报价单归到另一类。' },
    ],
  },
  {
    title: '资料与抽取',
    terms: [
      { key: 'source-version', label: '正文版本', guide: 'library', definition: '星图保存的某一次正文内容。校对后可以生成新版本，原始文件还能继续查看。' },
      { key: 'parse', label: '正文解析', guide: 'library', definition: '把导入的文件读成可查看的正文。解析完成后可以核对文字，知识抽取和建索引各有自己的进度。' },
      { key: 'material-goal', label: '整理目标', guide: 'library', definition: '说明希望从这一份资料里了解什么，例如「找出项目的负责人和下一次评审日期」。' },
      { key: 'extraction-plan', label: '抽取计划', guide: 'library', definition: '列出这一轮要处理的材料、正文版本、整理目标和适用规则，供开始抽取前核对。' },
      { key: 'extraction', label: '知识抽取', guide: 'models', definition: '根据整理规则，从原文里识别实体、属性和关系，并记录它们的出处。' },
      { key: 'candidate', label: '抽取结果', guide: 'library', definition: '从当前材料识别出的候选实体和关系。核对时可以查看出处，确认发布后才会进入生效知识。' },
      { key: 'evidence', label: '来源证据', guide: 'library', definition: '支持一条记录的原文摘录和所在位置。可以打开对应的正文版本核对。' },
    ],
  },
  {
    title: '草稿与发布',
    terms: [
      { key: 'ontology-version', label: '本体版本', guide: 'ontology', definition: '某一次保存或发布的完整规则。草稿可继续核对，生效版本供后续抽取使用。' },
      { key: 'draft', label: '待发布草稿', guide: 'ontology', definition: '已经保存、可继续核对的一套本体改动。确认发布后才会成为生效版本。' },
      { key: 'active-ontology', label: '生效本体', guide: 'ontology', definition: '当前正在使用的一套整理规则。发布新版本后，过去已整理的资料可以按需重新处理。' },
      { key: 'published-knowledge', label: '已发布知识', guide: 'library', definition: '已确认生效的实体、关系和证据，可以从星图或数据列表查看。' },
      { key: 'publish-knowledge', label: '知识入图', guide: 'graph', definition: '把核对完成的知识发布到当前星图，让对应的实体和关系可查看。' },
    ],
  },
  {
    title: '检索与交付',
    terms: [
      { key: 'search-index', label: '检索索引', guide: 'library', definition: '为正文片段建立的查找目录。索引就绪后，搜索可以更快找到相关片段。' },
      { key: 'vector-index', label: '检索向量模型', guide: 'models', definition: '把句子转换成能比较相似程度的一组数字，用来找意思接近的原文片段。' },
      { key: 'redaction', label: '交付脱敏', guide: 'sensitive', definition: '对外提供知识或证据时，按规则隐去姓名、电话等敏感信息。' },
      { key: 'delivery-check', label: '交付检测', guide: 'sensitive', definition: '在知识或证据交付前识别敏感内容，供脱敏规则决定哪些内容可以提供。' },
    ],
  },
];

const termsByKey = new Map(starlinkGlossary.flatMap(group => group.terms.map(term => [term.key, term])));

export function getStarlinkTerm(key) {
  return termsByKey.get(key);
}
