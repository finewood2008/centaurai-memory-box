import {nextScopeQuestion,questionCardsHTML,questionStatus} from './onboarding-dialogue-questions.mjs';

const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const scopeFields={
  industry:'行业',occupation:'职业／角色',service_objects:'服务对象',focus_objects:'关注对象',purposes:'用途',
  material_sources:'资料来源',questions_to_answer:'希望回答的问题',excluded_scope:'排除范围',uncertain_items:'未确定项',
};
export const scopeGroups=[
  ['行业与角色','industry','occupation'],['服务对象','service_objects'],['关注对象','focus_objects'],['用途','purposes'],
  ['资料来源','material_sources'],['希望回答的问题','questions_to_answer'],['重点与边界','excluded_scope','uncertain_items'],
];
const scopeStatus={pending:'缺失',skipped:'跳过',uncertain:'不确定',deferred:'稍后'};
const legacyLists={purposes:'purpose',material_sources:'material_types',questions_to_answer:'questions'};
const values=value=>Array.isArray(value)?value.filter(v=>typeof v==='string'&&v.trim()):typeof value==='string'&&value.trim()?[value]:[];

export function baseScope(snapshot) {
  const purpose=snapshot?.seed?.purpose;
  if(!purpose||typeof purpose!=='object'||Array.isArray(purpose))return snapshot?.draft?.revision===0?snapshot.draft.scope:null;
  const scope={};
  for(const field of Object.keys(scopeFields)){
    const legacy=legacyLists[field];
    const original=purpose[legacy||field];
    const structured=purpose._onboarding_scope?.[field];
    if(legacy){
      const same=Array.isArray(structured)&&structured.every(item=>typeof item==='string')&&structured.join('\n')===original;
      scope[field]=same?structured:values(original);
    }else{
      scope[field]=values(original);
    }
  }
  return scope;
}

function scopeValues(scope,fields){
  if(!scope)return '<p class="od-scope-empty">未读取</p>';
  if(!fields.some(key=>values(scope[key]).length))return '<p class="od-scope-empty">尚未填写</p>';
  return fields.map(key=>{
    const content=values(scope[key]);
    return `<div>${fields.length>1?`<small>${scopeFields[key]}</small>`:''}<p${content.length?'':' class="od-scope-empty"'}>${content.map(esc).join('<br>')||'尚未填写'}</p></div>`;
  }).join('');
}

export function scopeCardsHTML(snapshot,{editable=false,hasInput=false,deferredQuestionId=null}={}){
  const draft=snapshot.draft,prior=baseScope(snapshot),openQuestion=nextScopeQuestion(draft);
  const ledger=draft.question_states||draft.questions||[];
  const cards=scopeGroups.map(([label,...fields],index)=>{
    const remaining=fields.filter(key=>!values(draft.scope?.[key]).length);
    const questions=ledger.filter(q=>remaining.includes(q.field));
    const current=openQuestion&&remaining.includes(openQuestion.field)?openQuestion:null;
    const earlier=questions.findLast(q=>['skipped','uncertain','deferred'].includes(q.status));
    const response=current?(current.question_id&&current.question_id===deferredQuestionId?'deferred':'pending'):earlier?.status;
    const covered=remaining.length===0||fields.includes('excluded_scope')&&remaining.length<fields.length&&!response;
    const status=covered?'已覆盖':scopeStatus[response]||'缺失';
    const tone=covered?'covered':response&&response!=='pending'?'deferred':'missing';
    return {index,html:`<article class="od-scope-card" data-tone="${tone}">
      <header><h3>${label}</h3><span class="od-scope-state" data-tone="${tone}">${status}</span></header>
      <div class="od-scope-columns"><div><span>${snapshot.status==='stale'?'原基础范围':'现行'}</span>${scopeValues(prior,fields)}</div>
        <div><span>本轮草稿</span>${scopeValues(draft.scope,fields)}</div></div>
      ${editable?`<button type="button" class="btn btn-secondary" data-od-scope="${index}" ${hasInput?'disabled':''}>改这一项<span class="wp-sr"> ${label}</span></button>`:''}</article>`,
      priority:tone==='missing'?(current?0:1):tone==='deferred'?2:3};
  });
  return `<div class="od-scope-cards">${cards.sort((a,b)=>a.priority-b.priority||a.index-b.index).map(card=>card.html).join('')}</div>`;
}

export function scopeEditPrompt(index){
  const group=scopeGroups[index];
  return group?`仅调整「${group[0]}」这项仓范围。我的要求：`:'';
}

export function scopeQuestionHTML(snapshot,editable,progress,{deferredQuestionId=null,hasInput=false}={}){
  const q=nextScopeQuestion(snapshot.draft);
  if(!q)return '';
  const deferred=q.question_id&&q.question_id===deferredQuestionId;
  return `<section class="od-scope-question" aria-label="待补问"><header>待补问 · ${esc(scopeFields[q.field]||'业务范围')}</header>
    ${deferred?`<p>已留待稍后回答。</p><button class="ob-button" type="button" data-od="resume-question" ${!editable||hasInput?'disabled':''}>继续回答</button>`:
      questionCardsHTML([q],{editable,allowSkip:true,rangeActions:true,hasInput})}
    <footer>${esc(progress)}</footer></section>`;
}

export function scopeUnresolvedHTML(questions=[],items=[],deferredQuestionId=null){
  const open=questions.filter(q=>!q.status||['pending','deferred','skipped','uncertain'].includes(q.status));
  return open.length||items.length?`<ul>${open.map(q=>{
    const deferred=q.status==='pending'&&q.question_id&&q.question_id===deferredQuestionId;
    return `<li><span>${deferred?'稍后':esc(questionStatus[q.status]||'待回答')}</span>${esc(q.text)}</li>`;
  }).join('')}${items.map(item=>`<li>${esc(item)}</li>`).join('')}</ul>`:'<p class="wp-muted">暂无未决问题。</p>';
}

function changedFields(prior,scope){
  return Object.keys(scopeFields).filter(key=>prior
    ? JSON.stringify(values(prior[key]))!==JSON.stringify(values(scope?.[key]))
    : values(scope?.[key]).length);
}

export function scopeChangeLabels(snapshot,scope){
  return changedFields(baseScope(snapshot),scope).map(key=>scopeFields[key]);
}

export function scopeChangesHTML(snapshot,preview){
  const prior=baseScope(snapshot);
  const changes=changedFields(prior,preview.scope);
  if(!changes.length)return `<p class="od-scope-empty">${prior?'业务范围与现行一致。':'基础范围暂不可读取，本轮没有可展示的范围内容。'}</p>`;
  const rows = keys => `<dl class="od-scope-diff">${keys.map(key => {
    const before = values(prior?.[key]);
    const after = values(preview.scope?.[key]);
    const long = before.concat(after).join('').length > 65;
    const proposed = after.map(value=>before.length>1&&before.includes(value)
      ? `<span class="od-scope-retained">${esc(value)}</span>`
      : esc(value)).join('<br>');
    return `<div><dt>${scopeFields[key]}</dt><dd${long?' class="od-scope-diff-long"':''}>
      <span><small>现行</small>${before.map(esc).join('<br>') || (prior?'未指定':'未读取')}</span>
      <span class="od-scope-diff-arrow" aria-hidden="true">→</span>
      <strong><small>待发布</small>${proposed || '未指定'}</strong>
    </dd></div>`;
  }).join('')}</dl>`;
  return `${prior?'':'<p class="od-scope-empty" role="status">当前盒端未提供基础范围。</p>'}
    ${rows(changes.slice(0,4))}
    ${changes.length>4?`<details class="od-scope-more" id="od-review-scope-more"><summary>展开其余 ${changes.length-4} 项范围变化</summary>${rows(changes.slice(4))}</details>`:''}`;
}
