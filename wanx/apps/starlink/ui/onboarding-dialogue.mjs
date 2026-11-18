import {OnboardingDialogue,dialogueError,onboardingUnavailable,scopeOnlyInstruction} from './onboarding-dialogue-state.mjs';
import {ontologyGraphHTML,ontologyDefinitionsHTML,ontologyChangesHTML} from './onboarding-ontology-view.mjs';
import {nextDialogueQuestion,questionCardsHTML,questionLedgerHTML,questionActionsHTML,turnInputHTML} from './onboarding-dialogue-questions.mjs';
import {dialogueTemplates} from './onboarding-templates.mjs';
import {scopeCardsHTML,scopeChangesHTML,scopeEditPrompt,scopeQuestionHTML,scopeUnresolvedHTML} from './onboarding-scope-workspace.mjs';
const namePageTemplates=[...dialogueTemplates,{label:'空白模板',description:'清空名称和资料与用途，从空白开始填写',name:'',purpose:''}];
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fields={service_objects:'服务对象',purposes:'用途',industry:'行业',occupation:'职业／角色',material_sources:'资料来源',questions_to_answer:'希望回答的业务问题',excluded_scope:'排除范围',uncertain_items:'未确定项'};
const words=v=>(Array.isArray(v)?v.join('；'):v)||'尚未明确';
export const dialogueScopeHTML=scope=>`<dl class="od-scope">${Object.entries(fields).map(([key,label])=>`<div><dt>${label}</dt><dd>${esc(words(scope?.[key]))}</dd></div>`).join('')}</dl>`;
const sessionTime = new Intl.DateTimeFormat('zh-CN', {month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'});
const button=(a,text,primary=false,disabled=false)=>`<button type="button" data-od="${a}" class="btn ${primary?'btn-primary':'btn-secondary'}${a==='quick'&&!primary?' od-quick':''}" ${disabled?'disabled':''}>${text}</button>`;
export function dialogueProgress(progress){
  const p=progress||{},valid=['guidance_rounds','max_guidance_rounds','remaining_rounds'].every(k=>Number.isSafeInteger(p[k])&&p[k]>=0)&&p.guidance_rounds<=p.max_guidance_rounds&&p.remaining_rounds===p.max_guidance_rounds-p.guidance_rounds;
  if(!valid)return {hint:'用你的话回答或提出修改，范围明确后即可核对。',label:'逐步明确范围'};
  return {
    hint:`行业和适用角色单独确认，不计入普通引导。普通引导最多 ${p.max_guidance_rounds} 轮，之后仍可主动补充或修改。`,
    label:`引导 ${p.guidance_rounds} / ${p.max_guidance_rounds} 轮${p.guidance_complete?' · 已完成':''}`,
  };
}

export function dialogueSideHTML({snapshot,preview=null,tab='graph',editable=false}){
  const d=preview||snapshot?.draft;if(!d)return '';
  const proposed=!!preview||snapshot.status==='published'||d.ontology_proposed===true||d.ontology_proposed==null&&d.revision>0;
  const scope=`<details class="od-scope-details" open><summary>已记录的业务范围</summary>${dialogueScopeHTML(d.scope)}</details>`;
  const rulesTabs=`<div class="wp-tabs"><button type="button" class="btn btn-secondary" data-od="graph" aria-pressed="${tab==='graph'}">关系图</button><button type="button" class="btn btn-secondary" data-od="list" aria-pressed="${tab==='list'}">类型与属性</button></div>`;
  const content=proposed?`${rulesTabs}${tab==='graph'?ontologyGraphHTML(d.schema,d.changes||[],'od'):ontologyDefinitionsHTML(d.schema,'od')}${preview?'':scope}`:
    `<section class="od-scope-waiting" role="status"><h3>等待明确业务范围</h3><p>先逐步明确服务对象和用途。形成本体建议后，会在这里展示类型、关系和属性供你核对。</p></section>${scope}<details id="od-current-rules"><summary>查看当前规则</summary><p class="wp-muted">这是仓库已有的生效规则，不是根据本次回答生成的建议。</p>${ontologyDefinitionsHTML(d.schema,'od-current')}</details>`;
  const ledger=preview?'':`<details id="od-ledger"><summary>查看问题与回答记录</summary>${questionLedgerHTML(d.question_states??d.questions,{editable,historyOnly:true})}</details>`;
  const changes=proposed?`<details id="od-rule-changes"><summary>${preview?'相对生效规则的变化':'本轮类型与关系变化'}</summary>${ontologyChangesHTML(d.changes||[],d.schema)}</details>`:'';
  const scopeChanges=!preview&&(d.scope_changes||[]).length?`<details id="od-scope-changes"><summary>本轮范围变化</summary>${d.scope_changes.map(c=>`<p><b>${esc(fields[c.field]||c.field)}</b><br>修改前：${esc(words(c.before))}<br>修改后：${esc(words(c.after))}</p>`).join('')}</details>`:'';
  return `<aside class="wp-preview"><header><h2>${proposed?'类型与关系':'业务范围'}</h2><span class="wp-badge">${preview?'待发布':snapshot.status==='published'?'已发布':proposed?'草稿':'待明确'}</span></header><div class="wp-preview-body">${content}${ledger}${changes}${scopeChanges}</div></aside>`;
}

export function mountOnboardingDialogue({ host, storage, identity, call, onEnter, onClose, onComplete, onModels,
  warehouse=null, fresh=false, quick=null, legacyCreation=null, recoveryError=null, recoverLegacy, onQuick, readQuick, startUpdate=false }) {
  const dialog=document.createElement('section');dialog.className='od-dialog od-inline';dialog.setAttribute('aria-label','数据仓设置');host.append(dialog);
  let timer=null,closed=false,scrollNext=false,activePanel='chat',quickBusy=false,legacyBusy=false,writeError='',nameError='',quickAvailable=false;
  let reviewTab='diff';
  const model=new OnboardingDialogue({call,storage,identity,onEnter:async(...args)=>{
    await onEnter(...args);
    if(model.saved.entryPending){
      model.saved.entryPending=false;
      try{model.persist();}catch{model.saved.entryPending=true;}
    }
    onComplete();
  },onChange:()=>{render();schedule();}});
  const close=()=>{if(closed)return;closed=true;clearTimeout(timer);model.dispose();dialog.remove();};
  const writing=()=>quickBusy||legacyBusy||model.state.busy;
  const directCreation=()=>quickAvailable&&!model.state.loaded&&!model.saved.warehouse;
  const updating=()=>model.saved.setupMode==='update';
  function schedule(){clearTimeout(timer);if(!closed&&model.generating&&!model.state.pollError)timer=setTimeout(async()=>{await model.poll();schedule();},3000);}
  function namePage(){
    const {state:s,saved:v}=model,locked=!!(quick||legacyCreation||v.pending||v.creation||recoveryError);
    const direct=directCreation();
    const readonly=locked||quickBusy||legacyBusy||s.loaded&&writing();
    const name=quick?.input.name||legacyCreation?.answers?.warehouse_name||v.creation?.name||v.name;
    const purpose=quick?.input.description??v.creation?.purpose??v.purpose??'';
    return `<form id="od-name-form" class="wp-name-card">
      <label for="od-name">数据仓名称</label><input class="form-input" id="od-name" value="${esc(name)}" maxlength="60" required aria-describedby="od-name-error" aria-invalid="${!!nameError}" placeholder="例如：产品研究" ${readonly?'readonly':''}>
      <p class="od-name-error" id="od-name-error" role="alert" ${nameError?'':'hidden'}>${esc(nameError)}</p>
      <label for="od-purpose">${direct?'数据仓说明':'准备整理什么'} <small>选填</small></label><textarea class="form-input" id="od-purpose" rows="3" maxlength="${direct&&[...purpose].length<=500?500:16000}" placeholder="例如：整理用户访谈和竞品分析，方便追溯设计决策。" ${readonly?'readonly':''}>${esc(purpose)}</textarea>
      ${locked?'':templateCards()}
      ${direct?'':'<p class="wp-muted">通过对话建仓时，在线模型会接收填写的名称和用途。原始资料可以稍后导入。</p>'}
      <div class="wp-actions"><button type="submit" class="btn btn-primary" ${direct?'data-od="quick"':''} ${!direct&&!s.loaded||writing()||locked?'disabled':''}>${direct?'创建数据仓':'创建并开始对话'}</button>
      ${direct?'':button('quick','使用通用规则直接建仓',false,!s.loaded||writing()||locked)}</div>
    </form>`;
  }
  function templateCards(){const {state:s,saved:v}=model;return `<details id="od-templates" class="od-templates"><summary>使用场景模板</summary><p class="wp-muted">填入名称和用途，可以继续编辑。</p><div class="od-template-grid">${namePageTemplates.map((t,i)=>`<button type="button" class="od-template-card" data-od-template="${i}" aria-pressed="${v.name===t.name&&(v.purpose||'')===t.purpose}" ${!s.loaded&&!directCreation()||writing()?'disabled':''}><strong>${esc(t.label)}</strong><span>${esc(t.description)}</span></button>`).join('')}</div></details>`;}
  function side(){return dialogueSideHTML({snapshot:model.state.snapshot,preview:model.state.page==='review'?model.saved.preview:null,tab:model.state.tab,editable:model.editable});}
  function review(){
    const p=model.saved.preview,s=model.state,disabled=!s.loaded||s.busy||!!model.saved.pending||model.generating;
    const questions=p.question_states||p.questions;
    return `<div class="od-review"><div class="wp-grid"><article class="wp-confirm-card"><h2>整理范围</h2>${dialogueScopeHTML(p.scope)}${questions?.length?`<details id="od-review-history"><summary>查看问题与回答记录</summary>${questionLedgerHTML(questions)}<p class="wp-muted">跳过和暂不确定的问题会保留为后续补充项。</p></details>`:''}</article>${side()}</div>
      <div class="od-review-actions"><label class="wp-check"><input id="od-confirm" type="checkbox" ${s.confirmed?'checked':''} ${disabled?'disabled':''}>我已核对范围、类型、关系及属性，确认发布为本仓整理规则。</label>
      <div class="wp-actions">${button('publish','确认发布',true,!s.confirmed||disabled)}${button('continue','返回对话',false,s.busy||!!model.saved.pending)}</div></div></div>`;
  }
  function scopeReview(){
    const p=model.saved.preview,s=model.state;
    const disabled=!s.loaded||s.busy||!!model.saved.pending||model.generating;
    const changes=Array.isArray(p.changes)?p.changes:null;
    const scopeOnly=model.scopePublicationAllowed;
    return `<div class="od-review od-calibration-review">
      <section class="od-review-section" aria-label="范围变化">
        <header><h2>范围变化</h2><span>更新本仓用途</span></header>
        ${scopeChangesHTML(s.snapshot,p)}
      </section>
      <section class="od-review-section" aria-label="规则差异">
        <header><h2>规则差异</h2><span>${changes?changes.length?`${changes.length} 项改动 · 需要手动处理`:'0 项改动 · 沿用现行规则':'差异数量待确认'}</span></header>
        <div class="od-review-tabs">
          <button type="button" class="btn btn-secondary" data-od="review-diff" aria-pressed="${reviewTab==='diff'}">变更清单</button>
          <button type="button" class="btn btn-secondary" data-od="review-graph" aria-pressed="${reviewTab==='graph'}">关系图</button>
        </div>
        ${reviewTab==='graph'?ontologyGraphHTML(p.schema,changes||[],'od-calibration'):changes?ontologyChangesHTML(changes,p.schema):'<p class="wp-muted">此版本未返回差异明细。可展开完整规则核对。</p>'}
        <details id="od-review-definitions"><summary>查看完整待发布规则</summary>${ontologyDefinitionsHTML(p.schema,'od-calibration')}</details>
      </section>
      <section class="od-review-section od-unresolved" aria-label="未决问题"><header><h2>未决问题</h2></header>
        ${scopeUnresolvedHTML(p.question_states||p.questions||[],p.scope.uncertain_items||[],model.saved.deferredQuestionId)}
      </section>
      <p class="od-impact-note">材料影响估算 · 暂未提供</p>
      <div class="od-review-actions">
        <p class="wp-muted">${scopeOnly?'确认后更新仓用途。已有资料不会自动重新抽取。':'请在范围卡片中移除规则变更，再核对发布。本体规则可在规则总览手动编辑。'}</p>
        <label class="wp-check"><input id="od-confirm" type="checkbox" ${s.confirmed&&scopeOnly?'checked':''} ${disabled||!scopeOnly?'disabled':''}>我已核对范围变化和规则差异</label>
        <div class="wp-actions">${button('continue','返回修改',false,s.busy||!!model.saved.pending)}${button('publish','确认发布',true,!s.confirmed||disabled||!scopeOnly)}</div>
      </div>
    </div>`;
  }
  function currentCard(){const s=model.state,d=s.snapshot;if(!d)return `<p role="status">${s.busy?'正在读取开场问题与范围草稿…':'准备读取开场问题与范围草稿。'}</p>`;
    if(model.generating){const opening=model.inFlight==='conversation-onboarding-start'||s.turns.some(t=>t.status==='generating'&&t.kind==='opening');return `<article class="wp-assistant wp-current" role="status"><h2>${opening?'正在生成开场引导…':'正在梳理本轮范围…'}</h2><p>完成后展示更新的范围、图谱和下一轮问题。进度将自动读取；提交的问题操作尚未生效。</p></article>`;}
    if(d.status==='stale')return `<article class="wp-assistant wp-current"><h2>当前规则或用途已变化</h2><p>本轮历史保留。请从当前生效规则开始新的建仓对话，再核对发布。</p>${button('new-session','基于当前规则开始新对话',true,s.busy||!!model.saved.pending)}</article>`;
    const question=nextDialogueQuestion(d.draft);
    const latest=s.turns[0];
    const answer=latest?.status==='succeeded'&&latest.answer?`<p class="od-latest-answer">${esc(latest.answer)}</p>`:'';
    const offerModels=onModels&&['MODELING_CONTEXT_BUDGET','MODEL_BILLING_REQUIRED'].includes(latest?.error_code);
    const failure=latest?.status==='failed'?`<div class="od-turn-error" role="status"><p>${esc(dialogueError(latest))}</p><div class="wp-actions">${offerModels?button('models','打开模型设置',false,!model.editable):''}${retryTurn(latest)}</div></div>`:'';
    const start=d.can_start&&latest?.kind!=='opening'?button('start','生成开场引导',false,!model.editable):'';
    return `<article class="wp-assistant wp-current">${answer}${failure}${question?questionCardsHTML([question],{editable:model.editable}):'<p>可以继续补充范围，或核对已整理的规则。</p>'}${start}</article>`;
  }
  function publicationPage(showEntry){
    const {state:s,saved:v}=model,p=s.snapshot?.publication||v.publication;
    const replaced=s.snapshot?.status==='published'&&s.snapshot.publication_effective===false;
    const questions=p?.unresolved_questions||p?.question_states||p?.questions||[];
    if(updating())return `<div class="od-calibration-receipt">
      ${replaced?'<p class="wp-info" role="status">本次发布已被更新版本覆盖。</p>':''}
      <div class="od-receipt-results">
        <section class="od-review-section"><header><h2>业务范围</h2></header><p>已更新仓用途。后续材料对话会使用新范围。</p></section>
        <section class="od-review-section"><header><h2>本体规则</h2></header><p>${p?.changed===false?'规则未变':Number.isSafeInteger(p?.version_number)?`已发布 v${p.version_number}`:'规则已发布'}${p?.changed===false&&Number.isSafeInteger(p.version_number)?` · 沿用 v${p.version_number}`:''}</p></section>
      </div>
      <section class="od-review-section od-unresolved"><header><h2>遗留问题</h2></header>
        ${scopeUnresolvedHTML(questions,p?.unresolved_items||[],v.deferredQuestionId)}
      </section>
      <div class="wp-actions od-receipt-actions"><p class="wp-muted">已有资料未自动重新抽取。</p>
        ${showEntry?button('enter','查看生效规则',true,s.busy||!!v.pending):''}</div>
    </div>`;
    return `<article class="wp-confirm-card od-publication">
      <h2>${typeof p?.version_number==='number'?'发布版本 '+esc(p.version_number):'发布回执'}</h2>
      <p>${replaced?'当前数据仓已使用新版规则。':'整理规则已发布，导入资料后即可开始整理。'}</p>
      ${p?.unresolved_items?.length?`<p>待补充 · ${esc(words(p.unresolved_items))}</p>`:''}
      ${questions?.length?`<details id="od-publication-questions"><summary>查看待补充问题</summary>${questionLedgerHTML(questions)}</details>`:''}
      ${showEntry?`<div class="wp-actions">${button('enter',v.setupMode==='update'?'查看生效规则':'打开资料库',true,s.busy||!!v.pending)}</div>`:''}
    </article>`;
  }
  function retryTurn(turn){
    if(turn.kind==='opening')return model.state.snapshot?.can_start?button('start','重试开场引导',false,!model.editable):'';
    return `<button type="button" class="ob-button" data-od-retry="${esc(turn.resource_id)}" ${!model.editable?'disabled':''}>恢复本轮输入</button>`;
  }
  function history(){
    const {state:s,saved:v}=model;
    const options=s.sessions.map((session,index)=>{
      const timestamp=Date.parse(session.created_at);
      const label=Number.isFinite(timestamp)?sessionTime.format(timestamp):`会话 ${index+1}`;
      return `<option value="${esc(session.id)}" ${session.id===v.conversationId?'selected':''}>${esc(label)}</option>`;
    }).join('');
    return `<details id="od-history" class="od-sessions"><summary>对话历史</summary>
      <label class="od-session-selector" ${s.sessions.length>1?'':'hidden'}>切换会话<select id="od-session" ${s.busy||v.pending||model.generating?'disabled':''}>${options}</select></label>
      <div class="wp-messages">${s.snapshot?.turns.has_more?button('more','加载更早的对话',false,s.busy):''}
      ${[...s.turns].reverse().map(t=>`${turnInputHTML(t,model.questions)}<article class="wp-assistant"><small>${t.kind==='opening'?'开场引导':updating()?'校准助手':'建仓助手'}</small>${t.answer?`<p>${esc(t.answer)}</p>`:''}${t.status==='failed'?`<p>${esc(dialogueError(t))}</p>${retryTurn(t)}`:t.status==='generating'?'<p>生成中…</p>':t.status==='stale'?'<p>本轮结果未应用。</p>':''}</article>`).join('')}
      ${s.turns.length?'':'<p class="wp-muted">还没有对话记录。</p>'}</div></details>`;
  }
  function chatPage(){
    const s=model.state, progress=dialogueProgress(s.snapshot?.progress);
    const canReview=s.snapshot?.can_preview&&s.snapshot.draft.ontology_proposed!==false;
    return `<div class="od-chat-tools"><div class="od-panel-switch" role="group" aria-label="建仓工作区">
      <button type="button" class="btn btn-secondary" data-od="chat-panel" aria-pressed="${activePanel==='chat'}">建仓对话</button><button type="button" class="btn btn-secondary" data-od="draft-panel" aria-pressed="${activePanel==='draft'}">范围与规则</button>
      </div>${canReview?button('preview','核对并发布',true,!model.editable):''}</div>
      <div class="od-chat-panels" data-panel="${activePanel}"><section class="wp-chat" ${activePanel==='chat'?'':'hidden'}>
      <header><strong>建仓助手</strong><small title="${esc(progress.hint)}">${esc(progress.label)}</small></header>
      <div class="od-current-wrap" aria-live="polite">${currentCard()}</div>${composer()}${history()}</section>
      ${activePanel==='draft'?side():''}</div>`;
  }
  function scopePage(){
    const {snapshot:s,turns}=model.state;
    if(!s)return '<p class="wp-muted" role="status">正在读取现行范围和草稿…</p>';
    const stale=s.status==='stale',finished=turns[0];
    const failed=finished?.status==='failed'? `<div class="od-turn-error" role="status"><p>${esc(dialogueError(finished))}</p>${retryTurn(finished)}
      ${onModels&&['MODELING_CONTEXT_BUDGET','MODEL_BILLING_REQUIRED'].includes(finished.error_code)?button('models','打开模型设置',false,!model.editable):''}</div>`:'';
    const questionOptions={deferredQuestionId:model.saved.deferredQuestionId,hasInput:model.unsent};
    return `<div class="od-calibration">
      <p class="wp-muted">在这里更新资料来源、用途等业务范围。本体规则在「规则总览」手动编辑。</p>
      ${stale?`<div class="od-calibration-conflict" role="status"><div><strong>现行规则已更新</strong><p>规则或仓用途已变化。这份草稿可只读查看，原回答保留在此会话。</p></div>
        ${button('new-session','重新校准',true,writing()||!!model.saved.pending)}</div>`:''}
      ${scopeCardsHTML(s,{editable:model.editable,...questionOptions})}
      ${!stale?`<div class="od-calibration-compose">
        ${model.generating?'<p class="wp-muted" role="status">正在更新本轮范围…</p>':`${failed}${scopeQuestionHTML(s,model.editable,dialogueProgress(s.progress).label,questionOptions)}`}
        ${composer()}</div>`:''}
      ${history()}
    </div>`;
  }
  function composer(){const v=model.saved,q=model.inputQuestion,current=model.currentQuestion;return `<form id="od-answer-form" class="wp-composer">
    ${questionActionsHTML(v.questionActions,model.questions,{editable:model.editable})}
    <label class="wp-sr" for="od-input">${q?'当前问题的回答':'补充或修改范围'}</label>
    <textarea class="form-input" id="od-input" rows="2" maxlength="${q?4000:updating()?8000-scopeOnlyInstruction.length-1:8000}" placeholder="${q?'输入你的回答…':updating()?'描述要调整的业务范围…':'补充业务范围或说明要调整的规则…'}" ${!model.editable?'disabled':''}>${esc(v.input)}</textarea>
    <div class="wp-actions od-compose-actions"><label class="od-input-mode" ${!q&&!current?.question_id&&updating()?'hidden':''}><span class="wp-sr">本轮内容</span><select id="od-input-mode" ${!model.editable?'disabled':''}><option value="answer" ${q?'selected':''} ${!q&&!current?.question_id?'disabled':''}>回答当前问题</option><option value="free" ${!q?'selected':''}>补充范围</option></select></label>
    <small class="od-input-context">${q&&q.question_id!==current?.question_id?esc(q.text)+' · ':''}在线模型会接收本轮输入</small><button type="submit" class="ob-button ob-primary" ${!model.editable||updating()&&!model.unsent?'disabled':''}>发送</button></div></form>`;}
  function render(){
    if(closed)return;
    const {state:s,saved:v}=model;
    const positions=Object.fromEntries(['.wp-messages','.wp-preview-body'].map(k=>[k,dialog.querySelector(k)?.scrollTop||0]));
    const open=new Map([...dialog.querySelectorAll('details[id]')].map(d=>[d.id,d.open]));
    const focused=document.activeElement;
    const focusId=dialog.contains(focused)?focused.id:null;
    const focusAction=dialog.contains(focused)?focused.dataset.od:null;
    const selection=focusId&&typeof focused.selectionStart==='number'?[focused.selectionStart,focused.selectionEnd]:null;
    const pending=v.pending||v.creation;
    const published=v.publication||s.snapshot?.status==='published';
    const updating=v.setupMode==='update';
    const reviewed=s.page==='review'&&!!v.preview;
    const stage=!v.warehouse?'name':reviewed||published?'review':'chat';
    const heading=stage==='name'?'新建数据仓':reviewed?(updating?'发布核对':'核对并发布规则'):published?(updating?'校准回执':'整理规则已发布'):updating?'规则调整向导':v.warehouse.name;
    const needsSession=v.warehouse&&!v.conversationId&&!s.warehouseMissing;
    const locked=!!(quick||legacyCreation||recoveryError);
    const unsupported=s.error&&onboardingUnavailable(s.errorCode);
    const message=writeError||(unsupported
      ? updating?'暂时无法读取盒子的范围校准服务。':'暂时无法读取盒子的建仓对话服务。'
      : '')||(s.readFailure&&!v.warehouse&&!pending&&['SEMANTICA_CONNECTION_FAILED','SEMANTICA_SERVICE_TIMEOUT','SEMANTICA_INVALID_RESPONSE'].includes(s.errorCode)
      ? '暂时无法读取数据仓。你可以先填写，恢复后再提交。':s.error);
    const nameConflict=s.errorCode==='WAREHOUSE_NAME_CONFLICT'&&!v.warehouse;
    if(nameConflict)nameError='已有同名数据仓，请修改名称。';
    const publishingEntry=['MODELING_PUBLISHED_ENTRY_FAILED','MODELING_PUBLICATION_REPLACED'].includes(s.errorCode);
    const refreshLabel=publishingEntry?(updating?'重新打开本体与关系':'重新打开资料库'):'重试读取';
    const status=recoveryError?`<div class="wp-error" role="alert">${esc(dialogueError({code:recoveryError}))}</div>`
      :quick||legacyCreation?`<div class="wp-info" role="status">${esc(message||(quick?.warehouse?'数据仓已创建，可以重新打开资料库。':'上次创建的结果待确认，请继续原请求。'))} ${button(legacyCreation?'legacy':'quick',quick?.warehouse?'重新打开资料库':'继续原请求',true,writing())}</div>`
      :pending?`<div class="wp-info" role="status">${esc(s.busy?'正在提交，请稍候。':s.error||'上次操作的结果待确认。')} ${button('recover',v.warehouse&&!v.conversationId?'继续创建会话':'继续原请求',true,s.busy)}</div>`
      :needsSession&&!s.busy?`<div class="wp-info" role="status">${updating?'校准草稿暂未就绪。':'数据仓已创建，建仓对话暂未就绪。'}${message?` <span>${esc(message)}</span>`:''} ${button('recover','继续创建会话',true,!s.loaded)}</div>`
      :directCreation()&&!writeError?`<div class="wp-info" role="status">创建后会带着通用规则进入资料库。此盒子的建仓对话需要更新服务。</div>`
      :message&&!nameConflict?`<div class="wp-error" role="alert">${esc(message)} ${button(publishingEntry?'enter':'refresh',refreshLabel,false,s.busy||s.warehouseMissing)}</div>`
      :s.busy&&!s.loaded?`<p class="wp-info" role="status">正在读取数据仓…</p>`:'';
    const body=stage==='name'?namePage():locked||s.warehouseMissing||needsSession?'':reviewed?(updating?scopeReview():review()):published?publicationPage(!publishingEntry):updating?scopePage():chatPage();
    dialog.dataset.stage=stage;
    dialog.classList.toggle('od-update',updating);
    dialog.setAttribute('aria-label',updating?'规则调整向导':'数据仓设置');
    const version=s.currentRuleVersion;
    const baseVersion=s.baseRule?.id===s.snapshot?.draft.base_ontology_id?s.baseRule?.version:null;
    dialog.innerHTML=`<div class="od-heading"><div><div class="od-crumb">${updating?'本体与关系':'数据仓'}${v.warehouse&&(updating||stage!=='chat')?' / '+esc(v.warehouse.name):''}</div><h1 id="od-title" tabindex="-1">${esc(heading)}</h1>
      ${updating?`<div class="od-calibration-meta">
        ${Number.isSafeInteger(version)?`<span>现行 v${version}</span>`:''}
        ${s.snapshot?.status==='stale'&&Number.isSafeInteger(baseVersion)?`<span>旧稿基于 v${baseVersion}</span>`:''}
        ${reviewed?'<span data-state="review">待确认 · 尚未发布</span>':''}
      </div>`:''}</div>
      <div class="od-heading-actions">${button('close',stage==='name'||published?'返回':'保存进度并返回',false,writing())}
      ${updating&&stage==='chat'?button('preview','核对并发布',true,!model.canPreview):''}</div></div>
      ${directCreation()||updating?'':`<ol class="od-steps" aria-label="建仓进度">${[['name','命名'],['chat','定义范围'],['review','核对与发布']].map(([key,label])=>`<li ${key===stage?'aria-current="step"':''}>${label}</li>`).join('')}</ol>`}
      <div class="wp-content">${status}${body}</div>`;
    for(const [selector,position]of Object.entries(positions)){const n=dialog.querySelector(selector);if(n)n.scrollTop=scrollNext&&selector==='.wp-messages'?n.scrollHeight:position;}scrollNext=false;
    for(const [id,value] of open){const el=dialog.querySelector('#'+CSS.escape(id));if(el)el.open=value;}
    const next=focusId?dialog.querySelector('#'+CSS.escape(focusId)):focusAction?dialog.querySelector('[data-od="'+CSS.escape(focusAction)+'"]'):null;
    if(next&&!next.disabled){next.focus({preventScroll:true});if(selection&&next.setSelectionRange)next.setSelectionRange(...selection);}
  }
  function formFields(isQuick){
    const name=dialog.querySelector('#od-name').value.trim();
    const purpose=dialog.querySelector('#od-purpose').value.trim();
    const min=isQuick?1:2,max=isQuick?60:30;
    if([...name].length<min||[...name].length>max)nameError=`请输入 ${min}–${max} 个字符作为数据仓名称。`;
    else if(isQuick&&[...purpose].length>500)nameError='直接建仓的说明最多可填写 500 个字符。';
    else nameError='';
    if(nameError){render();dialog.querySelector('#od-name')?.focus();return null;}
    return {name,purpose};
  }
  async function checkQuickAccess(){
    if(closed||model.saved.warehouse||!onboardingUnavailable(model.state.errorCode))return;
    try {
      const result=await call('warehouses');
      if(!closed&&Array.isArray(result?.items)){quickAvailable=true;render();}
    } catch { /* A connection failure leaves both submissions disabled. */ }
  }
  async function refreshStatus(){
    quickAvailable=false;
    await model.refresh();
    await checkQuickAccess();
  }
  async function submitQuick(){
    if(writing()||(!quick&&!model.state.loaded&&!quickAvailable))return;
    const fields=quick?null:formFields(true);
    if(!quick&&!fields)return;
    const attempted=quick?.input||{name:fields.name,description:fields.purpose};
    quickBusy=true;writeError='';render();
    try { await onQuick(fields?{name:fields.name,description:fields.purpose}:{});onComplete(); }
    catch(error){
      try { quick=readQuick(); } catch { recoveryError='MODELING_LOCAL_RECORD_INVALID'; }
      if(!quick&&!recoveryError&&!model.state.loaded){
        await model.load({fresh:true});
        await checkQuickAccess();
        model.setName(attempted.name);model.setPurpose(attempted.description);
      }
      if(error.code==='WAREHOUSE_NAME_CONFLICT'&&!quick)nameError='已有同名数据仓，请修改名称。';
      else if(error.code==='MODELING_WAREHOUSE_ENTRY_FAILED')writeError='数据仓已创建，暂时无法打开资料库。';
      else if(quick&&!quick.warehouse)writeError='上次创建的结果待确认，继续时会沿用原请求。';
      else writeError=dialogueError(error);
    } finally { quickBusy=false;render();if(nameError)dialog.querySelector('#od-name')?.focus(); }
  }
  async function submitLegacy(){
    if(writing()||!legacyCreation)return;
    legacyBusy=true;writeError='';render();
    try {
      const value=await recoverLegacy();
      legacyCreation=null;
      await model.load({warehouse:value,newWarehouse:true});
    } catch(error){
      if(error.definitive){
        model.setName(legacyCreation.answers?.warehouse_name||'');
        legacyCreation=null;
        await model.load();
      }
      writeError=error.message;
    } finally { legacyBusy=false;render(); }
  }
  dialog.addEventListener('input',e=>{if(e.target.id==='od-name'){model.setName(e.target.value);nameError='';dialog.querySelector('#od-name-error').hidden=true;e.target.setAttribute('aria-invalid','false');}if(e.target.id==='od-purpose')model.setPurpose(e.target.value);
    if(['od-name','od-purpose'].includes(e.target.id))for(const card of dialog.querySelectorAll('[data-od-template]')){const t=namePageTemplates[Number(card.dataset.odTemplate)];card.setAttribute('aria-pressed',String(model.saved.name===t.name&&(model.saved.purpose||'')===t.purpose));}
    if(e.target.id==='od-input'){
      model.setInput(e.target.value);
      if(updating()){
        const send=dialog.querySelector('#od-answer-form button[type="submit"]');
        if(send)send.disabled=!model.editable||!model.unsent;
        for(const control of dialog.querySelectorAll('[data-od-scope], .od-scope-question button')){
          control.disabled=!model.editable||model.unsent;
        }
      }
    }
    if(e.target.hasAttribute('data-od-answer'))model.setQuestionAnswer(e.target.dataset.odAnswer,e.target.value);});
  dialog.addEventListener('change',e=>{if(e.target.id==='od-confirm'){model.state.confirmed=e.target.checked&&(!updating()||model.scopePublicationAllowed);dialog.querySelector('[data-od=publish]').disabled=!model.state.confirmed;}if(e.target.id==='od-session')void model.chooseSession(e.target.value);if(e.target.id==='od-input-mode')model.setInputMode(e.target.value);});
  dialog.addEventListener('submit',async e=>{e.preventDefault();if(e.target.id==='od-name-form'){if(writing()||quick||legacyCreation||recoveryError||model.saved.pending||model.saved.creation)return;if(directCreation())return void submitQuick();if(!model.state.loaded)return;const fields=formFields(false);if(!fields)return;model.setName(fields.name);model.setPurpose(fields.purpose);await model.create();await checkQuickAccess();dialog.querySelector(model.saved.warehouse?'#od-title':'#od-name')?.focus({preventScroll:true});}if(e.target.id==='od-answer-form'){model.setInput(dialog.querySelector('#od-input').value);for(const el of dialog.querySelectorAll('[data-od-answer]'))model.setQuestionAnswer(el.dataset.odAnswer,el.value);await model.sendComposer();}if(!closed){scrollNext=true;render();}});
  function reveal(target){
    if(updating()&&model.state.page==='review')reviewTab='diff';else model.state.tab='list';
    render();const d=dialog.querySelector('#'+CSS.escape(target));if(d){
      for(let group=d;group;group=group.parentElement?.closest('details'))group.open=true;
      d.scrollIntoView({block:'nearest'});
    }
  }
  dialog.addEventListener('keydown',e=>{const n=e.target.closest('[data-ontology-focus]');if(n&&['Enter',' '].includes(e.key)){e.preventDefault();reveal(n.dataset.ontologyFocus);}});
  dialog.addEventListener('click',e=>{const template=e.target.closest('[data-od-template]');if(template){if(!template.disabled){model.applyTemplate(namePageTemplates[Number(template.dataset.odTemplate)]);dialog.querySelector('#od-name')?.focus();}return;}const n=e.target.closest('[data-ontology-focus]');if(n){reveal(n.dataset.ontologyFocus);return;}
    const scope=e.target.closest('[data-od-scope]');
    if(scope&&!scope.disabled&&model.editable&&!model.unsent){
      const prompt=scopeEditPrompt(Number(scope.dataset.odScope));
      if(prompt){model.setInputMode('free');model.setInput(prompt);render();const input=dialog.querySelector('#od-input');input?.focus();input?.setSelectionRange(prompt.length,prompt.length);}
      return;
    }
    const question=e.target.closest('[data-od-question]'),remove=e.target.closest('[data-od-remove-question]');
    if(question&&!question.disabled){activePanel='chat';if(question.dataset.questionAction==='answer'&&question.closest('.wp-current,.od-scope-question')){model.answerQuestion(question.dataset.odQuestion);dialog.querySelector('#od-input')?.focus();}else{model.stageQuestion(question.dataset.odQuestion,question.dataset.questionAction);(dialog.querySelector('[data-od-answer="'+CSS.escape(question.dataset.odQuestion)+'"]')||dialog.querySelector('#od-input'))?.focus();}return;}
    if(remove&&!remove.disabled){model.removeQuestion(remove.dataset.odRemoveQuestion);return;}
    const choice=e.target.closest('[data-od-choice]'),retry=e.target.closest('[data-od-retry]');if(choice||retry){if(!model.editable)return;
      if(retry){model.restoreReply(retry.dataset.odRetry);const a=model.saved.questionActions;if(!model.saved.input&&a.length===1&&a[0].action==='answer')model.answerQuestion(a[0].question_id,a[0].answer);}else if(choice.dataset.choiceQuestion)model.answerQuestion(choice.dataset.choiceQuestion,choice.dataset.odChoice);else model.setInput(choice.dataset.odChoice);
      render();(dialog.querySelector('[data-od-answer]')||dialog.querySelector('#od-input'))?.focus();return;}
    const b=e.target.closest('[data-od]');if(!b||b.disabled)return;const a=b.dataset.od;
    if(a==='close')return onClose();
    if(a==='models'&&onModels&&model.editable){
      b.disabled=true;
      void onModels(model.saved.warehouse,model.state.turns[0]?.context_budget?.required_context_tokens).catch(error=>{
        if(!closed){writeError=dialogueError(error);render();}
      }).finally(()=>{if(b.isConnected)b.disabled=false;});
      return;
    }
    if(a==='quick'){if(b.type!=='submit')void submitQuick();return;}if(a==='legacy')return void submitLegacy();
    if(a==='chat-panel'||a==='draft-panel'){activePanel=a==='chat-panel'?'chat':'draft';render();return;}
    if(a==='review-diff'||a==='review-graph'){reviewTab=a==='review-graph'?'graph':'diff';render();return;}
    if(a==='defer-question'){model.deferQuestion();dialog.querySelector('[data-od=resume-question]')?.focus({preventScroll:true});return;}
    if(a==='resume-question'){model.setInputMode('answer');dialog.querySelector('#od-input')?.focus();return;}
    if(['graph','list'].includes(a)){model.state.tab=a;render();return;}
    if(a==='continue'){activePanel='chat';model.state.page='chat';model.state.confirmed=false;render();dialog.querySelector('#od-input')?.focus();return;}
    if(a==='new-session'&&updating()&&!window.confirm('另开校准草稿？当前草稿和输入会保留。'))return;
    if(a==='preview')reviewTab='diff';
    const actions={start:()=>model.start(),refresh:()=>refreshStatus(),recover:()=>model.recover(),preview:()=>model.preview(),publish:()=>model.publish(),enter:()=>model.enter(),'new-session':()=>model.newSession(),more:()=>model.more()};
    if(actions[a])void actions[a]().then(()=>{if(!closed){if(['preview','new-session','publish'].includes(a)){scrollNext=true;const page=host.closest('.page-scroll');if(page)page.scrollTop=0;}render();if(a==='preview'&&model.state.page==='review'||a==='publish'&&model.saved.publication)dialog.querySelector('#od-title')?.focus({preventScroll:true});}});
  });
  render();if(!quick&&!legacyCreation&&!recoveryError)void model.load({warehouse,fresh,startUpdate}).then(checkQuickAccess);
  return {close,get busy(){return writing();},focus(){(dialog.querySelector('#od-name')||dialog.querySelector('#od-title'))?.focus({preventScroll:true});}};
}
