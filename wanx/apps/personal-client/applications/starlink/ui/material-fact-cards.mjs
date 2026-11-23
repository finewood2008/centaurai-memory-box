import {issueCategory} from '../shared/publication-validation.mjs';
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const valueText=v=>typeof v==='boolean'?(v?'是':'否'):typeof v==='string'?v:JSON.stringify(v);
const filled=v=>v!==null&&v!==undefined&&(typeof v!=='string'||v.trim())&&(!Array.isArray(v)||v.length>0)&&(typeof v!=='object'||Array.isArray(v)||Object.keys(v).length>0);
const labels={description:'说明',version:'版本',status:'状态',title:'标题',date:'日期',name:'名称',url:'链接',category:'分类',code:'编号'};
export function factSchema(flow){return flow?.changes?.state.summary?.ontology||flow?.changes?.state.context?.schema||flow?.state.ontology?.schema;}
export function factContext(flow){return [...(flow?.changes?.state.items?.items||[]),...Object.values(flow?.changes?.state.knownItems||{})];}
function endpointName(item,key,context){return item.endpoints?.[key]?.name||context.find(i=>i.kind==='entity'&&(i.id===item.payload?.[key]||i.candidate_key===item.payload?.[key]))?.payload?.name||item.endpoint_names?.[key]||'';}
export function factName(item,context=[],schema){
  if(item?.kind!=='relation')return String(item?.payload?.name||'未命名实体');
  const endpoint=key=>endpointName(item,key,context)||'待核对对象';
  return `${endpoint('source_candidate_key')} → ${schema?factType(item,schema)+' → ':''}${endpoint('target_candidate_key')}`;
}
export function factType(item,schema){
  const definition=(item?.kind==='relation'?schema?.relation_types:schema?.entity_types)?.find(d=>d.name===item?.payload?.type);
  return typeof definition?.label==='string'&&definition.label.trim()?definition.label:'未命名分类';
}
function factChangeBasis(change,before,after,{schema,documentId,documentVersionId}){
  const reason=typeof change.reason==='string'?change.reason:typeof change.explanation==='string'?change.explanation:'';
  const user=['user_statement','user_supplement','user_input'].includes(change.reason_kind);
  const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
  const classification=before&&after&&before.payload.type!==after.payload.type;
  const definitions=(after?.kind==='relation'?schema?.relation_types:schema?.entity_types)?.find(d=>d.name===after?.payload?.type)?.properties||[];
  const empty=classification&&after.payload.properties&&typeof after.payload.properties==='object'?definitions.filter(p=>!filled(after.payload.properties?.[p.name])).map(p=>p.label||labels[p.name]||'未填写属性'):[];
  const sources=(Array.isArray(change.source_evidence)?change.source_evidence:[]).filter(e=>e&&e.document_id===documentId&&e.document_version_id===documentVersionId&&documentId&&documentVersionId&&typeof e.segment_id==='string'&&e.segment_id&&typeof e.excerpt==='string'&&e.excerpt.trim()&&Number.isSafeInteger(e.start)&&Number.isSafeInteger(e.end)&&e.start>=0&&e.end>e.start&&e.end-e.start===[...e.excerpt].length).slice(0,8);
  return `${classification?`<section class="cv-classification-note"><strong>分类调整</strong>${before.kind!=='relation'&&typeof before.payload.name==='string'&&before.payload.name===after.payload.name?'<p>名称保持不变。</p>':''}${Array.isArray(before.evidence)&&Array.isArray(after.evidence)&&same(before.evidence,after.evidence)?`<p>${before.evidence?.length?'原文引用保持不变；引用说明对象出现在材料中，不要求原文直接写明新分类。':'条目当前没有原文引用，请核对来源；对话说明不会自动变成原文。'}</p>`:''}${empty.length?`<p>未提供的属性保持空缺：${esc(empty.join('、'))}。不自动补造属性值。</p>`:''}</section>`:''}
    ${reason?`<section class="cv-change-reason"><strong>${user?'用户补充说明（不是原文引用）':'调整理由（助手建议）'}</strong><p>${esc(reason)}</p></section>`:''}
    ${sources.length?`<section class="cv-change-sources"><strong>对象的原文引用</strong>${change.evidence_scope==='object_source_not_classification_proof'?'<p>以下引用说明对象的来源，分类调整由你核对确认。</p>':''}${sources.map(e=>`<blockquote>${esc(e.excerpt)}${e.truncated?'<small>仅展示部分引用</small>':''}</blockquote>`).join('')}</section>`:Array.isArray(change.source_evidence)?'<p class="muted">当前建议未附带可展示的已核对原文引用；可查看条目的原文来源。</p>':''}`;
}
function properties(item,schema){
  const definitions=(item.kind==='relation'?schema?.relation_types:schema?.entity_types)?.find(d=>d.name===item.payload?.type)?.properties||[];
  return Object.entries(item.payload?.properties||{}).filter(([,v])=>filled(v)).map(([key,value],index)=>({key,value,label:definitions.find(d=>d.name===key)?.label||labels[key]||(/[\u3400-\u9fff]/.test(key)?key:`其他属性 ${index+1}`)}));
}
export function visibleFactItems(state,schema){
  const keyword=String(state.factFilter?.keyword||'').trim().toLocaleLowerCase(),type=state.factFilter?.type||'';
  return (state.items?.items||[]).filter(item=>(!type||item.payload?.type===type)&&(!keyword||[factName(item,Object.values(state.knownItems||{}),schema),factType(item,schema),...properties(item,schema).flatMap(p=>[p.label,valueText(p.value)])].join(' ').toLocaleLowerCase().includes(keyword)));
}
export function selectedFactsHTML(flow){
  const c=flow?.changes;if(!c?.state.selected.length||c.independent)return '';
  const items=factContext(flow),names=c.state.selected.map(id=>{const item=items.find(i=>i.id===id);return item?factName(item,items,factSchema(flow)):'其他页所选条目';});
  return `<aside class="cv-selected-facts" aria-label="当前选中的修改对象"><strong>正在调整这 ${names.length} 项</strong><p>${names.map(esc).join('、')}</p><small>描述要求后先生成建议，确认后才保存到草稿。</small></aside>`;
}
function locator(e){const l=e.locator||{};return l.page_number!=null?`第 ${l.page_number} 页`:l.page!=null?`第 ${l.page} 页`:l.paragraph!=null?`第 ${l.paragraph} 段`:'原文片段';}
export function factCardHTML(item,{schema,context=[],selectable=false,selected=false,disabled=false,selectionDisabled=disabled,adjustable=false,status='',source=null,sourceFor=null}={}){
  const title=factName(item,context,schema),type=factType(item,schema),attrs=properties(item,schema),evidence=(item.evidence||[]).filter(e=>e.excerpt||e.segment_id);
  const viewKey=item.id||item.candidate_key||item.entity_id||item.fact_id||[item.kind,item.payload?.type,title,evidence[0]?.segment_id].join(':');
  const description=typeof item.payload?.description==='string'?item.payload.description:'';
  const issues=(item.issues||[]).filter(i=>['error','warning'].includes(issueCategory(i))),typeIssue=issues.some(i=>/类型|分类|端点|约束|TYPE|ENDPOINT/.test((i.message||'')+' '+(i.code||'')));
  return `<article class="cv-fact cv-knowledge-card"><header><div class="cv-fact-title">${selectable?`<label><input type="checkbox" data-cv-item="${esc(item.id)}" ${selected?'checked':''} ${selectionDisabled?'disabled':''}><strong>${esc(title)}</strong></label>`:`<h4>${esc(title)}</h4>`}<span class="cv-fact-type">${esc(type)}</span>${issues.some(i=>i.severity==='error')?'<span class="cv-fact-error">存在阻塞错误</span>':''}${typeIssue?'<span class="cv-fact-warning">分类待核对</span>':''}</div>${status?`<small class="cv-fact-status">${esc(status)}</small>`:''}</header>
    ${description?`<p class="cv-fact-description">${esc(description)}</p>`:''}
    ${attrs.length?`<dl class="cv-fact-properties">${attrs.map(p=>`<dt title="${esc(p.key)}">${esc(p.label)}</dt><dd>${esc(valueText(p.value))}</dd>`).join('')}</dl>`:''}
    ${item.payload?.aliases?.length?`<p class="cv-fact-aliases">其他名称：${esc(Array.isArray(item.payload.aliases)?item.payload.aliases.join('、'):item.payload.aliases)}</p>`:''}
    <section class="cv-fact-evidence"><strong>原文依据</strong>${evidence.length?`<blockquote>${esc(String(evidence[0].excerpt||'请读取上下文核对依据').slice(0,180))}${String(evidence[0].excerpt||'').length>180?'…':''}</blockquote><details data-cv-disclosure="fact-evidence-${esc(viewKey)}"><summary>查看原文与上下文 · ${evidence.length} 处依据</summary>${evidence.map(e=>`<div><small>${esc(locator(e))}</small>${e.excerpt?`<p>${esc(e.excerpt)}</p>`:''}${selectable&&e.segment_id?`<button type="button" class="btn btn-secondary" data-cv="change-source" data-id="${esc(e.segment_id)}" data-item-id="${esc(item.id)}" ${disabled?'disabled':''}>读取原文上下文</button>`:''}</div>`).join('')}${source&&sourceFor===item.id?`<div class="cv-fact-context"><strong>原文上下文</strong><p>${esc(source.text)}</p>${Number.isSafeInteger(source.total_chars)&&source.end<source.total_chars?'<small>当前仅返回部分上下文。</small>':''}</div>`:''}</details>`:'<p class="muted">尚无原文依据，请核对后补充或排除。</p>'}</section>
    ${issues.length?`<details class="cv-fact-issues"><summary>需核对 · ${issues.length} 项提示</summary><ul>${issues.map(i=>`<li>${esc(i.message||'请核对此条内容')}</li>`).join('')}</ul></details>`:''}
    ${adjustable?`<button type="button" class="btn btn-secondary" data-cv="change-adjust-item" data-id="${esc(item.id)}" ${disabled?'disabled':''}>通过对话调整</button>`:''}
    <details class="cv-fact-technical" data-cv-disclosure="fact-technical-${esc(viewKey)}"><summary>技术详情</summary><pre>${esc(JSON.stringify({id:item.id,kind:item.kind,payload:item.payload,evidence:item.evidence},null,2))}</pre></details></article>`;
}
export function factDiffHTML(change,{schema,context=[],status='建议 · 未应用',documentId,documentVersionId}={}){
  const normalize=value=>value==null?null:value.payload?value:{kind:context.find(i=>i.id===change.item_id)?.kind||'entity',payload:value};
  const before=normalize(change.before),after=normalize(change.after),item=after||before||context.find(i=>i.id===change.item_id);
  const heading=item?factName(item,context,schema):'知识条目',fields=[];
  const row=(name,left,right)=>{if(left!==right)fields.push(`<div><dt>${esc(name)}</dt><dd><span>${esc(left||'未填写')}</span><span aria-label="修改为"> → </span><strong>${esc(right||'未填写')}</strong></dd></div>`);};
  const canonical=value=>value&&typeof value==='object'?Array.isArray(value)?value.map(canonical):Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
  const equal=(a,b)=>JSON.stringify(canonical(a))===JSON.stringify(canonical(b));
  const valueKind=v=>v===null?'空值':Array.isArray(v)?'列表':({string:'文本',number:'数值',boolean:'布尔值',object:'对象',undefined:'未填写'}[typeof v]);
  const valueRow=(name,a,b)=>{
    if(equal(a,b))return;
    let left=filled(a)?valueText(a):'未填写',right=filled(b)?valueText(b):'移除';
    if(left===right){left+=`（${valueKind(a)}）`;right+=`（${valueKind(b)}）`;}
    row(name,left,right);
  };
  if(before&&after){
    if(before.kind==='relation'||after.kind==='relation'){
      for(const [key,label] of [['source_candidate_key','关系起点'],['target_candidate_key','关系终点']]){
        if(before.payload[key]===after.payload[key])continue;
        const a=endpointName(before,key,context)||'待核对对象',b=endpointName(after,key,context)||'待核对对象';
        row(label,a,b===a?b+'（对应对象已变化，请展开核对）':b);
      }
    }else row('名称',factName(before,context,schema),factName(after,context,schema));
    const beforeLabel=typeof change.before_type_label==='string'&&change.before_type_label.trim()?change.before_type_label:factType(before,schema),afterLabel=typeof change.after_type_label==='string'&&change.after_type_label.trim()?change.after_type_label:factType(after,schema);
    if(before.payload.type!==after.payload.type&&beforeLabel===afterLabel)row('分类',beforeLabel,'另一分类（显示名称相同，详见技术详情）');
    else row('分类',beforeLabel,afterLabel);
    const left=properties(before,schema),right=properties(after,schema);
    for(const key of new Set([...left,...right].map(p=>p.key))){const a=left.find(p=>p.key===key),b=right.find(p=>p.key===key);valueRow(b?.label||a?.label,a?.value,b?.value);}
    valueRow('内容说明',before.payload.description,after.payload.description);
    valueRow('其他名称',before.payload.aliases,after.payload.aliases);
    valueRow('核对说明',before.review_note,after.review_note);
    if(!equal(before.evidence||[],after.evidence||[]))row('原文依据',`${(before.evidence||[]).length} 处依据`,`${(after.evidence||[]).length} 处依据（内容已调整）`);
  }
  return `<article class="cv-change-diff cv-fact-diff"><header><h4>${esc(heading)}</h4><span class="cv-fact-status">${esc(status)}</span></header>${!before?'<p>建议新增此条内容</p>':!after?'<p>修改前：保留此条内容 → 修改后：从本材料结果中排除</p>':fields.length?`<dl class="cv-readable-diff">${fields.join('')}</dl>`:'<p>原文依据或其他内容有调整，请展开查看完整对比。</p>'}${factChangeBasis(change,before,after,{schema,documentId,documentVersionId})}<details><summary>查看完整修改前后</summary><div class="cv-before-after"><div><h5>修改前</h5>${before?factCardHTML(before,{schema,context}):'<p>原来没有此条内容</p>'}</div><div><h5>修改后</h5>${after?factCardHTML(after,{schema,context}):'<p>排除此条内容</p>'}</div></div></details></article>`;
}
