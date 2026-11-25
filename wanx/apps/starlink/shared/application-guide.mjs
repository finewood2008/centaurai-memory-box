import {starlinkGlossary} from './starlink-glossary.mjs';

export const pages = {
  'my-ai': ['我的 AI','选择智能体，配置它可以使用的资料。'],
  memory: ['记忆','在记忆库中查看记录，按来源筛选。'],
  data: ['星图','选择一个项目，查看资料、实体和它们之间的关系。'],
  space: ['空间','在文件夹中浏览、预览和整理文件。'],
  boxes: ['盒子','查看当前设备的连接和授权状态。'],
  accessories: ['配件','选择设备，查看记录和采集设置。'],
  settings: ['设置','管理账号、设备维护和客户端偏好。'],
  'dialogue-models': ['模型设置','查看可用模型与默认配置。'],
  profile: ['个人资料','查看当前云账号与身份信息。'],
  notifications: ['通知中心','查看设备和应用的通知。'],
  credits: ['积分','核对余额和使用明细。'],
  help: ['问题与反馈','按问题查找操作说明。'],
};
// Only these displayed values may accompany a guide question to the box model.
const pageFields = {
  data:'子页面 当前项目 可见项目数 项目资料数 项目实体数 项目关系数 生效本体 生效版本 实体类型数 关系类型数 实体类型示例 属性规则示例 关系规则示例 画面可见实体数 画面可见关系数 已选实体 已选实体类型 已选关系 图谱视图 已选资料 资料状态',
  'my-ai':'当前智能体 参考星图 空间文件 智能体记忆 自动备份 已选来源快照数',
  memory:'子页面 概览数量 来源分布示例 当前来源 列表状态 筛选结果数 本页记录数 自动备份 已选来源快照数',
  space:'列表状态 位置 目录项目数 筛选后项目数 已选数量 已选项目 当前可写',
  boxes:'当前盒子 连接状态 关联设备数 可用存储 总容量',
  accessories:'工作台 采集设置 配件状态',
  settings:'云账号 登录时启动 当前盒子', profile:'云账号',
  notifications:'未读数量 当前筛选', credits:'显示余额', provisioning:'配置步骤',
  help:'帮助主题', 'dialogue-models':'模型设置状态', 'client-update':'要求更新',
};
export function guidePageFacts(page, source) {
  const facts={};
  if (!Object.hasOwn(pageFields,page) || !source || typeof source !== 'object') return facts;
  for (const key of (pageFields[page]+' 可见栏目 当前弹窗').split(' ')) {
    const value=source[key];
    if (typeof value==='boolean' || Number.isSafeInteger(value) && value>=0) facts[key]=value;
    if (typeof value==='string' && value.trim()) facts[key]=value.trim().slice(0,180);
  }
  return facts;
}
const rows = [
  ['overview','项目概览','概览汇总当前星图项目中的资料、实体和关系。可以从这里了解整理进度，再打开资料库查看具体材料。','data','overview'],
  ['memory-source','记忆来源','来源说明这条记忆由哪个智能体或设备采集。选一个来源，就能只看它留下的记录。','memory'],
  ['task-access','任务资料范围','在「我的 AI」里为任务选择可用的空间文件夹、星图和记忆来源。开始前核对这三项，决定本次任务能查什么。','my-ai'],
  ['space-folder','个人空间','个人空间存放当前身份在盒子上的文件。打开文件夹浏览原件，也可以通过搜索找到文件。','space'],
  ['sharing','分享链接','链接让接收方在设定的有效期和权限内访问这份资料。可以在分享管理中查看状态或撤销链接。','space'],
  ['backup','备份快照','快照保存某台设备在一个时间点的记忆库副本。恢复时先核对来源设备、备份时间和当前记忆库。','memory'],
  ['annotation','文件标注','给文件添加标签和说明，之后可以按用途查找。自动生成的建议需要你核对后保存。','space'],
  ['box-binding','盒子授权','当前身份需要得到设备授权才能访问盒子里的资料。在盒子页核对设备名称和连接状态。','boxes'],
  ['claim','认领码','认领码用于把设备绑定到你的账号。核对设备上的码，再按向导配网并确认绑定。','boxes'],
  ['capture','记忆采集','开启后，这个配件中经你确认的录音总结会自动存入记忆库；也可以逐条手动保存。到记忆页选择对应来源，就能找回以前的总结。','accessories'],
  ['model-default','默认模型','CentaurAI 侧栏使用当前连接的记忆盒子的默认文本模型。更换盒子的默认文本模型后，下一次问答就会使用新模型。','settings'],
  ['cloud-account','云账号','云账号用于登录并管理账号服务。访问盒子上的个人资料，还需要当前设备获得盒子授权。','profile'],
  ['space-redaction','空间脱敏规则','它决定在空间中对文件执行「脱敏」时，哪些信息需要遮盖。先核对规则，再在文件菜单选择脱敏。','settings'],
  ['maintenance','盒子运维工具','这里可以检查当前盒子的运行状态和服务更新。先核对设备，再选择要检查的服务。','settings'],
  ['library','资料库','这里保存当前星图的材料。打开一份材料可以看正文、抽取结果和证据。','data','conversation'],
];
const destinations = {library:'conversation',entity:'knowledge',relation:'data',data:'data',ontology:'ontology',models:'models',sensitive:'sensitive',graph:'graph',warehouses:'warehouses',overview:'overview'};
export const viewLabels = {conversation:'项目资料库',knowledge:'实体列表',data:'关系列表',ontology:'本项目的本体',models:'模型设置',sensitive:'脱敏规则',graph:'知识星图',warehouses:'项目列表',overview:'项目概览',tasks:'处理任务'};
export const concepts = new Map(rows.map(([key,label,definition,page,view])=>[key,{key,label,definition,page,view}]));
for (const {terms} of starlinkGlossary) for (const term of terms) {
  concepts.set(term.key,{...term,page:'data',view:destinations[term.guide] || 'overview'});
}
concepts.get('ontology').definition += ' 例如，整理合同时，可以识别「公司」和「合同」，再用「签署」把它们连起来。';
export const linkLabel = term => term.key==='candidate' ? '查看抽取结果' : '查看' + (viewLabels[term.view] || pages[term.page][0]);
const configurationLinks = {
  'create-project': ['开始新建星图', 'warehouses'],
  material: ['选择要整理的资料', 'conversation'],
  ontology: ['前往本体修改', 'ontology'],
  models: ['打开抽取模型设置', 'models'],
  'dialogue-models': ['打开 CentaurAI 模型设置', 'models'],
  sensitive: ['打开脱敏规则', 'sensitive'],
  import: ['打开资料导入', 'conversation'],
  projects: ['打开我的项目', 'warehouses'],
};
export function configurationLink(action) {
  if (!Object.hasOwn(configurationLinks, action)) return null;
  const [label, view] = configurationLinks[action];
  return {label, target:{view, configuration:action}};
}
export const guideMark = '✨';
export const guideShortcut = e => !e.repeat && (e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && e.key.toLowerCase()==='k';

// A click on padding around text is background. A click on the text itself is not.
export function isGuideBackgroundClick(event) {
  const target = event.target;
  if (event.button !== 0 || !event.detail || event.defaultPrevented || !target?.closest) return false;
  if (target.closest('a,button,input,textarea,select,label,summary,[contenteditable]:not([contenteditable="false"]),[tabindex]:not([tabindex="-1"]),[role="button"],[role="link"],[role="row"],[role="option"],[role="tab"],[role="menuitem"],[data-action],[draggable="true"],[popover],img,svg,canvas,video,audio')) return false;
  const doc = target.ownerDocument;
  if (!doc.getSelection()?.isCollapsed || doc.defaultView.getComputedStyle(target).cursor === 'pointer') return false;
  const range = doc.caretRangeFromPoint(event.clientX, event.clientY);
  if (range?.startContainer.nodeType === 3) {
    const node = range.startContainer, offset = range.startOffset;
    range.setStart(node, Math.max(0, offset - 1));
    range.setEnd(node, Math.min(node.length, offset + 1));
    for (const rect of range.getClientRects()) {
      if (event.clientX >= rect.left && event.clientX < rect.right &&
          event.clientY >= rect.top && event.clientY < rect.bottom) return false;
    }
  }
  return true;
}

// Page-local targets use visible product controls. Ordinary headings are only focused.
export function guideScreenTargets(root, query) {
  const text=s=>s?.replace(/✨/gu,'').replace(/\s+/g,' ').trim();
  const region=[...root.querySelectorAll('dialog[open],[aria-modal="true"]:not([hidden])')].find(el=>el.getClientRects().length) || root;
  const needle=text(query)?.toLocaleLowerCase() || '';
  const hits=[];
  for(const el of region.querySelectorAll('[data-guide-record],.my-ai-agent[aria-pressed],[data-overview-target],.memory-page-nav-group button,h2,h3,h4,summary,label[for],button[data-action]')){
    if(!el.getClientRects().length || el.closest('[hidden],[inert],#academy-drawer-root,template') || el.matches(':disabled'))continue;
    if(el.matches('button[data-action]') && el.closest('.main-nav,.topbar') && !el.hasAttribute('data-guide-record'))continue;
    const title=text(el.dataset.guideTitle || el.getAttribute('aria-label') || el.innerText)?.slice(0,160);
    if(!title || needle && !title.toLocaleLowerCase().includes(needle))continue;
    const clickable=el.matches('[data-guide-record],.my-ai-agent,[data-overview-target],.memory-page-nav-group button');
    const key=[el.tagName,el.dataset.guideRecord || el.dataset.overviewTarget || el.id || '',title].join('/');
    const control=el.matches('button,label[for],summary');
    hits.push({key,title,source:clickable?'当前页项目':control?'当前页控件':'当前页栏目',open:()=>{
      if(!el.isConnected || !el.getClientRects().length || el.closest('[inert]'))return false;
      if(clickable)el.click();
      else{el.scrollIntoView({block:'center'});if(el.tabIndex<0)el.tabIndex=-1;el.focus({preventScroll:true});}
      return true;
    }});
  }
  return hits.filter(h=>hits.filter(x=>x.key===h.key).length===1).slice(0,12);
}
