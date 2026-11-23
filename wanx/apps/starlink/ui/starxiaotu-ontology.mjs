const html = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
const validSchema = schema => schema && ['entity_types','relation_types'].every(key => Array.isArray(schema[key]) && schema[key].every(type =>
  type && typeof type.name==='string' && typeof type.label==='string' && Array.isArray(type.properties) && type.properties.every(p => p && typeof p.name==='string' && typeof p.label==='string' && typeof p.required==='boolean') &&
  (key!=='relation_types' || Array.isArray(type.source_types) && type.source_types.every(name=>typeof name==='string') && Array.isArray(type.target_types) && type.target_types.every(name=>typeof name==='string'))));

/** Versions belong to one project's rules; historical versions are not extra active ontologies. */
export function ontologyQuery(payload, question = '') {
  if(!payload || !Array.isArray(payload.items) || payload.items.some(item=>!item || typeof item.id!=='string' || typeof item.name!=='string' || typeof item.status!=='string' || !validSchema(item.schema)))throw new Error('本体列表回执不完整，请稍后重试。');
  const items=payload.items, current=items.find(item=>item.status==='published');
  if(!current)return {items,answer:items.length?'当前项目还没有生效本体，以下是已有草稿或历史版本。':'当前项目尚无本体，请先在本体页面建立并发布规则。'};
  const matched=[...current.schema.entity_types,...current.schema.relation_types].filter(type=>question.includes(type.label || type.name) || question.includes(type.name));
  return {items,current,matched,answer:'以下是当前项目的本体规则。当前生效版本为「'+current.name+'」；草稿和历史版本单独标注。'+(matched.length?'已展开问题中提到的类型。':'')};
}

function definition(type, schema) {
  if(!type)return '无此定义';
  const label=name=>schema?.entity_types.find(t=>t.name===name)?.label || name;
  return (type.label || type.name)+'（'+type.name+'）'+(type.source_types?'；方向：'+type.source_types.map(label).join('、')+' → '+(type.label||type.name)+' → '+type.target_types.map(label).join('、'):'')+
    '；定义：'+(type.definition||'未填写')+'；分类边界：'+(type.classification_boundary||'未填写')+'；属性：'+(type.properties.map(p=>(p.label||p.name)+'（'+p.name+'，'+(p.required?'必填':'选填')+(p.definition?'，'+p.definition:'')+'）').join('、')||'无');
}

export function renderOntologyQuery(result) {
  const status=item=>item===result.current?'当前生效':item.status==='draft'?'草稿':item.status==='published'?'历史发布版本':'历史版本（'+item.status+'）';
  return '<div class="sx-ontology-query">'+result.items.map(item=>'<details'+(item===result.current?' open':'')+'><summary>'+html(item.name)+' · '+html(status(item))+(item.version_number?' · v'+html(item.version_number):'')+'</summary><small>本体 ID：'+html(item.id)+'</small>'+['entity_types','relation_types'].map(key=>'<div><strong>'+(key==='entity_types'?'实体类型':'关系类型')+' · '+item.schema[key].length+'</strong>'+item.schema[key].map(type=>'<details'+(result.matched?.includes(type)?' open':'')+'><summary>'+html(type.label||type.name)+'（'+html(type.name)+'）</summary><p>'+html(definition(type,item.schema))+'</p></details>').join('')+'</div>').join('')+'</details>').join('')+'</div>';
}

function canonical(value) {
  if(Array.isArray(value))return value.map(canonical);
  if(value && typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(key==='source_types'||key==='target_types'?[...value[key]].sort():value[key])]));
  return value;
}
export function ontologyChanges(before, after) {
  if(!before || !after)return null;
  const changes=[];
  for(const key of ['entity_types','relation_types']) {
    const previous=new Map(before[key].map(type=>[type.name,type])), next=new Map(after[key].map(type=>[type.name,type]));
    for(const name of new Set([...previous.keys(),...next.keys()]))if(JSON.stringify(canonical(previous.get(name)))!==JSON.stringify(canonical(next.get(name))))changes.push({kind:key==='entity_types'?'实体类型':'关系类型',name,before:previous.get(name),after:next.get(name)});
  }
  return changes;
}
function renderDiff(before, after, suggestion) {
  const changes=ontologyChanges(before,after);
  if(!changes)return '<p>缺少对应的生效版本，请打开本体页面对照完整定义。</p>';
  return '<details class="sx-ontology-diff" open><summary>'+(suggestion?'建议差异（尚未应用）':'草稿与生效规则的差异')+' · '+changes.length+' 项</summary>'+changes.map(change=>'<article><strong>'+(!change.before?'新增':!change.after?'删除':'修改')+change.kind+' · '+html(change.after?.label||change.before?.label||change.name)+'（'+html(change.name)+'）</strong><div class="sx-diff-table"><table><caption class="sx-visually-hidden">'+html(change.kind+' '+change.name)+'的规则变化</caption><thead><tr><th scope="col">修改项</th><th scope="col">修改前</th><th scope="col">'+(suggestion?'建议修改后':'待发布')+'</th></tr></thead><tbody>'+ontologyFieldChanges(change.before,change.after,before,after).map(row=>'<tr><th scope="row">'+html(row.field)+'</th><td>'+html(row.before)+'</td><td>'+html(row.after)+'</td></tr>').join('')+'</tbody></table></div><details class="sx-definition-details"><summary>查看完整定义</summary><p>修改前：'+html(definition(change.before,before))+'</p><p>'+(suggestion?'建议修改后':'待发布')+'：'+html(definition(change.after,after))+'</p></details></article>').join('')+'</details>';
}

export function ontologyFieldChanges(before, after, beforeSchema, afterSchema) {
  const rows=[], add=(field,previous,next)=>{if(previous!==next)rows.push({field,before:previous||'未配置',after:next||'未配置'});};
  if(!before || !after)add('类型',before?'已定义':'未定义',after?'已定义':'未定义');
  for(const [key,label] of [['label','名称'],['definition','定义'],['classification_boundary','分类边界']])add(label,before?.[key],after?.[key]);
  const direction=(type,schema)=>type?.source_types?[type.source_types,type.target_types].map(names=>[...names].sort().map(name=>{
    const label=schema?.entity_types.find(item=>item.name===name)?.label;
    return label?label+'（'+name+'）':name;
  }).join('、')).join(' → '):'';
  add('关系方向',direction(before,beforeSchema),direction(after,afterSchema));
  const previous=new Map((before?.properties||[]).map(p=>[p.name,p])),next=new Map((after?.properties||[]).map(p=>[p.name,p]));
  const describe=p=>p?[(p.label||p.name),p.required?'必填':'选填',p.definition].filter(Boolean).join(' · '):'';
  for(const name of new Set([...previous.keys(),...next.keys()])) {
    const a=previous.get(name),b=next.get(name);
    add((!a?'新增属性 · ':!b?'删除属性 · ':'属性 · ')+(b?.label||a?.label||name)+'（'+name+'）',describe(a),describe(b));
  }
  const a=(before?.properties||[]).map(p=>p.name),b=(after?.properties||[]).map(p=>p.name);
  if(a.length===b.length && a.every(name=>next.has(name)) && a.some((name,i)=>name!==b[i]))add('属性顺序',a.join(' → '),b.join(' → '));
  return rows;
}

export function ontologyProgress(flow) {
  if(flow?.current?.status==='published')return {step:3,complete:true};
  if(flow?.pending?.kind==='apply' || flow?.settling?.kind==='apply')return {step:2,complete:false};
  if(flow?.awaitingProposal || flow?.current?.active_turn_id || flow?.pending?.kind==='proposal')return {step:1,complete:false};
  if(flow?.current?.draft?.revision && flow.hasChanges()!==false)return {step:3,complete:false};
  return {step:0,complete:false};
}

export function renderOntologyProgress(flow, project) {
  const {step,complete}=ontologyProgress(flow);
  return '<strong>修改本体 · '+html(project)+'</strong><ol aria-label="本体修改步骤">'+['描述要求','核对建议','应用草稿','确认发布'].map((label,index)=>'<li data-state="'+(complete||index<step?'done':index===step?'current':'next')+'"'+(!complete&&index===step?' aria-current="step"':'')+'><span aria-hidden="true">'+(complete||index<step?'✓':index+1)+'</span>'+label+'</li>').join('')+'</ol>'+(complete?'<small>本次修改已发布</small>':flow?.needsRefresh?'<small>需读取最新状态后继续</small>':'');
}

export const ontologyExamples = [
  {id:'property',label:'增加属性',text:'给「实体类型名称」增加「属性名称」属性，设为选填。',selection:'实体类型名称'},
  {id:'entity',label:'新增实体类型',text:'新增实体类型「类型名称」，用于记录「业务含义」。',selection:'类型名称'},
  {id:'relation',label:'调整关系',text:'调整关系类型「关系名称」：从「主体类型」指向「客体类型」。',selection:'关系名称'},
];
export function renderOntologyEntry() {
  return '<section class="sx-ontology-entry" aria-label="开始对话修改本体"><strong>描述你想调整的规则，我会先生成修改建议。</strong><p>例如：给合同类型增加“到期日期”属性，设为选填。</p><div aria-label="本体修改示例">'+ontologyExamples.map(example=>'<button type="button" class="sx-link" data-sx-ontology-example="'+example.id+'">'+example.label+'</button>').join('')+'</div><p class="sx-status">点击示例填入输入框，替换类型名称并补充要求后发送。</p><p class="sx-prompt-hint" hidden>已保留未发送的内容，清空输入后可填入示例。</p></section>';
}

export function renderOntologyDialogue(flow, confirmedPreview = '') {
  const current=flow.current, proposal=flow.proposal, preview=flow.preview;
  const busy=flow.busy || !!flow.pending || flow.needsRefresh || !!flow.settling || !!current?.active_turn_id;
  const button=(action,label,disabled=false)=>'<button type="button" class="sx-link" data-sx-ontology="'+action+'"'+(disabled?' disabled':'')+'>'+label+'</button>';
  let body='<strong>本体修改 · '+(current?.status==='published'?'已发布':flow.awaitingProposal?'建议待确认':current?.draft?.revision?'待发布草稿':'尚未修改生效规则')+'</strong>';
  if(flow.error)body+='<p class="sx-error" role="alert">'+html(flow.error)+'</p>';
  if(flow.note)body+='<p role="status">'+html(flow.note)+'</p>';
  if(flow.busy)body+='<p role="status">正在读取或处理本体请求…</p>';
  if(flow.pending)body+='<p>上次请求结果尚未确认，请恢复原请求以核对结果。</p>'+button('retry','恢复原请求',flow.busy);
  body+=button('refresh','读取最新状态',flow.busy || !!flow.pending);
  if(current?.status==='stale')body+='<p>当前生效本体已变化，请到本体页面核对冲突后继续。</p>';
  if(current && !current.initialized && !flow.pending)body+=button('initialize','继续初始化草稿',busy);
  if(proposal && flow.awaitingProposal) {
    body+='<p>'+html(proposal.summary)+'</p>'+renderDiff(current?.draft?.schema,proposal.schema,true);
    if(proposal.dependencies.length)body+='<p>关联约束：'+html(proposal.dependencies.join('；'))+'</p>';
    if(proposal.questions.length)body+='<p>待确认问题：\n'+html(proposal.questions.join('\n'))+'</p>';
    body+='<p>本次修改尚未发布。可继续调整建议，确认应用只会更新草稿。</p><button type="button" class="sx-link" data-sx-refine-ontology>继续调整</button>'+button('apply','确认应用到草稿',busy || proposal.status!=='proposed' || proposal.questions.length>0 || current?.status!=='editing');
  } else if(current?.draft && current.status!=='published') {
    body+=renderDiff(flow.baselineSchema,current.draft.schema,false);
    if(current.draft.questions.length)body+='<p>待确认问题：\n'+html(current.draft.questions.join('\n'))+'</p>';
    body+=button('prepare','预览发布影响',busy || !current.draft.revision || flow.hasChanges()===false || current.draft.questions.length>0 || current.can_preview===false || current.status!=='editing');
  }
  if(preview) {
    body+='<section class="sx-impact"><strong>发布影响 · '+preview.impact.total+' 份资料</strong><p>本次只发布规则；历史资料是否重新处理，需要另行确认。</p>'+
      preview.impact.items.map(item=>'<p>'+html(item.name)+(item.protected?' · 受保护':'')+(item.active_task_count?' · 有处理中任务':'')+'\n'+html(item.reasons.join('；'))+'</p>').join('');
    if(preview.impact.has_more)body+=button('more','查看后续影响资料',busy);
    if(!preview.impact.valid)body+='<p>当前预览无效，请读取最新状态后重新预览。</p>';
    body+='<label class="sx-confirm"><input type="checkbox" data-sx-publish-confirm'+(confirmedPreview===preview.preview_digest?' checked':'')+(busy||!preview.impact.valid?' disabled':'')+'>我已核对以上规则差异与影响，确认发布</label>'+button('publish','确认发布规则',busy || !preview.impact.valid || confirmedPreview!==preview.preview_digest)+'</section>';
  }
  if(current?.status==='published')body+='<p>规则已发布。后续检索与抽取使用服务端当前生效版本；历史资料不会在这里自动重新处理。</p>';
  return '<section class="sx-ontology" aria-label="本体建议、草稿与发布">'+body+'</section>';
}
