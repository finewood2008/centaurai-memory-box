const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const questionStatus={pending:'待回答',answered:'已回答',skipped:'已跳过',uncertain:'暂不确定',deferred:'待补充',superseded:'已被后续引导替换'};
const actionLabel={answer:'回答',skip:'跳过',uncertain:'暂不确定'};
const actionButton=(q,action,label,disabled)=>`<button type="button" class="ob-button" data-od-question="${esc(q.question_id)}" data-question-action="${action}" ${disabled?'disabled':''}>${label}</button>`;
export function nextDialogueQuestion(draft={}){
  if(!Array.isArray(draft.question_states))return (draft.questions||[]).find(q=>!q.status||q.status==='pending')||null;
  const ledger=draft.question_states;
  // Only questions exposed for this turn may become the current prompt.
  // The ledger supplies status, not extra prompts after guidance has ended.
  for(const q of draft.questions||[]){const state=ledger.find(s=>s.question_id===q.question_id);if(state?.status==='pending')return {...q,...state};}
  return null;
}
export function questionCardsHTML(questions,{editable=false}={}){
  return (questions||[]).map(q=>`<section class="od-question"><p>${esc(q.text)}</p>${q.examples?.length||q.question_id?`<div class="wp-choices">${(q.examples||[]).map(text=>`<button class="ob-button" type="button" data-od-choice="${esc(text)}" ${q.question_id?`data-choice-question="${esc(q.question_id)}"`:''} ${!editable?'disabled':''}>${esc(text)}</button>`).join('')}${q.question_id?actionButton(q,'uncertain','暂不确定，先继续',!editable):''}</div>`:''}<small>选择选项或直接输入，点击发送后继续。</small></section>`).join('');
}
export function questionLedgerHTML(questions,{editable=false,historyOnly=false}={}){
  if(!questions?.length)return '';
  return `<section class="od-question-ledger"><h3>问题台账</h3>${questions.map(q=>`<article><div><span class="wp-badge">${esc(questionStatus[q.status]||'状态待确认')}</span><small>${q.source==='fallback'?'基础引导':q.source==='model'?'模型引导':''}</small></div><p>${esc(q.text)}</p>${q.answer?`<p class="od-recorded-answer">已保存的回答：${esc(q.answer)}</p>`:''}${editable&&q.question_id&&(!historyOnly||['answered','skipped','uncertain','deferred'].includes(q.status))?actionButton(q,'answer',q.status==='answered'?'调整回答':'补充回答',false):''}</article>`).join('')}</section>`;
}
export function questionActionsHTML(actions,questions,{editable=false}={}){
  if(!actions?.length)return '';
  return `<div class="od-question-actions"><small>本轮问题操作 · 点击发送后提交，处理成功后更新台账</small>${actions.map(a=>{const q=questions.find(q=>q.question_id===a.question_id);return `<section><div><strong>${esc(actionLabel[a.action])}</strong><span>${esc(q?.text||'原问题已变化，请重新核对台账')}</span><button type="button" class="ob-button" data-od-remove-question="${esc(a.question_id)}" ${!editable?'disabled':''}>撤回</button></div>${a.action==='answer'?`<label class="wp-sr" for="od-answer-${esc(a.question_id)}">回答：${esc(q?.text||a.question_id)}</label><textarea id="od-answer-${esc(a.question_id)}" data-od-answer="${esc(a.question_id)}" rows="2" maxlength="4000" placeholder="填写这个问题的回答…" ${!editable?'disabled':''}>${esc(a.answer)}</textarea>`:''}</section>`;}).join('')}</div>`;
}
export function turnInputHTML(turn,questions){
  if(turn.kind==='opening')return '';
  return `<article class="wp-user">${turn.content?`<p>${esc(turn.content)}</p>`:''}${(turn.question_actions||[]).map(a=>`<p><b>${esc(actionLabel[a.action]||a.action)}</b> · ${esc(questions.find(q=>q.question_id===a.question_id)?.text||a.question_id)}${a.action==='answer'?`<br>${esc(a.answer)}`:''}</p>`).join('')}</article>`;
}
