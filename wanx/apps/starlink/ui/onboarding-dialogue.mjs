import {OnboardingDialogue,dialogueError,onboardingUnavailable} from './onboarding-dialogue-state.mjs';
import {ontologyGraphHTML,ontologyDefinitionsHTML,ontologyChangesHTML} from './onboarding-ontology-view.mjs';
import {questionCardsHTML,questionLedgerHTML,questionActionsHTML,turnInputHTML} from './onboarding-dialogue-questions.mjs';
import {identityKey,scopePatchError} from '../shared/onboarding-contract.mjs';
import {dialogueTemplates} from './onboarding-templates.mjs';
import {reviewChecklistHTML} from './onboarding-review-view.mjs';
import {trialHTML} from './onboarding-trial-view.mjs';
import {scopeCardsHTML,scopeEditPrompt,scopeFields,scopeChangeLabels} from './onboarding-scope-workspace.mjs';
const namePageTemplates=[...dialogueTemplates,{label:'空白模板',description:'清空名称和资料与用途，从空白开始填写',name:'',purpose:''}];
const goalChoices=[
  ['追溯产品决策','评审前我想查清某项功能为什么这样设计、哪份材料记录了决定。','产品决策'],
  ['查清项目进展','准备项目会议时，我想知道哪些任务还没完成、由谁负责。','项目进展'],
  ['整理个人知识','需要回顾时，我想找到某个主题的关键结论和出处。','个人知识'],
];
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const profileFields = {occupation:'职业／角色',service_objects:'服务对象',focus_objects:'关注对象'};
const fields={focus_objects:'关注对象',service_objects:'服务对象',purposes:'用途',industry:'行业',occupation:'职业／角色',material_sources:'资料来源',questions_to_answer:'希望回答的业务问题',excluded_scope:'排除范围',uncertain_items:'未确定项'};
const words=v=>(Array.isArray(v)?v.join('；'):v)||'尚未明确';
export const dialogueScopeHTML=scope=>`<dl class="od-scope">${Object.entries(fields).map(([key,label])=>`<div><dt>${label}</dt><dd>${esc(words(scope?.[key]))}</dd></div>`).join('')}</dl>`;
const modelErrors=new Set(['MODELING_CONTEXT_BUDGET','MODEL_BILLING_REQUIRED','MODEL_CONFIG_CHANGED','MODEL_NOT_CONFIGURED','LLM_NOT_CONFIGURED','MODELING_ONBOARDING_MODEL_FAILED']);
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

export function dialogueSideHTML({snapshot,preview=null,tab='graph',editable=false,turns=[],goal='',hasInput=false,focusedDraft=false}){
  const d=preview||snapshot?.draft;if(!d)return '';
  const proposed=!!preview||snapshot.status==='published'||d.ontology_proposed===true||d.ontology_proposed==null&&d.revision>0;
  const mainQuestion=d.scope?.questions_to_answer?.[0];
  const aim=mainQuestion||d.scope?.purposes?.[0]||goal;
  const scope=`<details id="od-scope-details" class="od-scope-details"><summary>范围卡片</summary>
    ${snapshot?scopeCardsHTML(snapshot,{editable,hasInput}):dialogueScopeHTML(d.scope)}</details>`;
  const rulesTabs=`<div class="wp-tabs"><button type="button" class="btn btn-secondary" data-od="graph" aria-pressed="${tab==='graph'}">关系图</button><button type="button" class="btn btn-secondary" data-od="list" aria-pressed="${tab==='list'}">类型与属性</button></div>`;
  const completeRules=`${rulesTabs}${tab==='graph'?ontologyGraphHTML(d.schema,d.changes||[],'od'):ontologyDefinitionsHTML(d.schema,'od')}`;
  const content=proposed?(preview||focusedDraft?completeRules:`<details id="od-full-rules"><summary>查看完整类型与关系</summary>${completeRules}</details>${scope}`):
    `<section class="od-scope-waiting" role="status"><h3>等待明确业务范围</h3><p>先逐步明确服务对象和用途。形成本体建议后，会在这里展示类型、关系和属性供你核对。</p></section>${scope}<details id="od-current-rules"><summary>查看当前规则</summary><p class="wp-muted">这是仓库已有的生效规则，不是根据本次回答生成的建议。</p>${ontologyDefinitionsHTML(d.schema,'od-current')}</details>`;
  const ledger=preview?'':`<details id="od-ledger"><summary>查看问题与回答记录</summary>${questionLedgerHTML(d.question_states??d.questions,{editable,historyOnly:true})}</details>`;
  const basis=!preview&&proposed?ontologyBasis(d,turns,editable&&!hasInput):'';
  const ruleBasis=focusedDraft&&basis?`<details id="od-draft-basis"><summary>查看定义依据与调整</summary>${basis}</details>`:basis;
  const changes=proposed?`<details id="od-rule-changes"><summary>${preview?'相对生效规则的变化':'本轮类型与关系变化'}</summary>${ontologyChangesHTML(d.changes||[],d.schema)}</details>`:'';
  const scopeChanges=!preview&&(d.scope_changes||[]).length?`<details id="od-scope-changes"><summary>本轮范围变化</summary>${d.scope_changes.map(c=>`<p><b>${esc(fields[c.field]||c.field)}</b><br>修改前：${esc(words(c.before))}<br>修改后：${esc(words(c.after))}</p>`).join('')}</details>`:'';
  return `<aside class="wp-preview" aria-label="本体草稿"><header><h2>${preview?'待确认的整理规则':focusedDraft?'本体草稿':'这张星图会记住什么'}</h2><span class="wp-badge">${preview?'待发布':snapshot.status==='published'?'已发布':proposed?'草稿':'待明确'}</span></header><div class="wp-preview-body">${aim?`<section class="od-draft-aim"><h3>${mainQuestion?'希望回答的问题':'星图目标'}</h3><p>${esc(aim)}</p></section>`:''}${focusedDraft?content+ruleBasis:ruleBasis+content}${ledger}${changes}${scopeChanges}</div></aside>`;
}

function ontologyBasis(draft, turns, editable){
  const summaryKinds=['entity_types','relation_types'];
  const entries=summaryKinds.flatMap(kind=>{
    const all=draft.schema?.[kind]||[];
    const changes=new Set(turns.flatMap(turn=>(turn.draft?.changes||[])
      .filter(change=>change.kind===kind&&change.after).map(change=>change.name)));
    return [...all.filter(rule=>changes.has(rule.name)),...all.filter(rule=>!changes.has(rule.name))]
      .slice(0,3).map(rule=>[kind,rule]);
  });
  if(!entries.length)return '';
  return `<div class="od-rule-basis">${entries.map(([kind,rule],index)=>{
    const turn=turns.find(item=>item.status==='succeeded'&&item.draft?.changes?.some(change=>
      change.kind===kind&&change.name===rule.name&&change.after));
    const input=[turn?.content,...(turn?.question_actions||[]).filter(action=>action.action==='answer').map(action=>action.answer)]
      .filter(value=>value?.trim()).join('；');
    const label=rule.label||rule.name;
    const targets=(side)=>(rule[side]||[]).map(name=>draft.schema.entity_types.find(type=>type.name===name)?.label||name).join('、');
    return `<details id="od-rule-basis-${index}"><summary><small>${kind==='entity_types'?'实体类型':'关系类型'}</small> ${esc(label)}</summary>
      ${rule.definition?`<p>${esc(rule.definition)}</p>`:''}
      ${kind==='relation_types'?`<p>${esc(targets('source_types'))} → ${esc(targets('target_types'))}</p>`:''}
      ${input?`<blockquote>该轮用户输入 · ${esc(input)}</blockquote>`:turn?.kind==='opening'?'<p class="wp-muted">来自开场整理，可对照上方星图目标核对。</p>':'<p class="wp-muted">当前记录没有这条定义对应的输入。</p>'}
      <button class="btn btn-secondary" type="button" data-od-rule="${esc(label)}" data-od-rule-name="${esc(rule.name)}" data-od-kind="${kind}" ${editable?'':'disabled'}>调整这条定义</button>
    </details>`;
  }).join('')}</div>`;
}

function readLegacyScopePrompt(storage,identity,warehouseId){
  try {
    const edits=JSON.parse(storage.getItem('starlink.warehouse-scope.v1.'+identityKey(identity)+'.'+warehouseId)||'{}');
    const lines=Object.entries(scopeFields).filter(([key])=>typeof edits?.[key]==='string')
      .map(([key,label])=>`「${label}」改为：${edits[key].trim()||'清空'}`);
    const text=lines.length?`请更新以下整理范围：\n${lines.join('\n')}`:'';
    return text;
  } catch { return ''; }
}

export function mountOnboardingDialogue({ host, storage, identity, call, onEnter, onClose, onComplete, onModels, onSuggestions,
  warehouse=null, fresh=false, quick=null, legacyCreation=null, recoveryError=null, recoverLegacy, onQuick, readQuick, readUnavailableModel, startUpdate=false }) {
  const dialog=document.createElement('section');dialog.className='od-dialog od-inline';dialog.setAttribute('aria-label','星图设置');host.append(dialog);
  let timer=null,closed=false,quickBusy=false,legacyBusy=false,writeError='',nameError='',quickAvailable=false;
  const modelProblems=new Map();
  const canSend=()=>model.editable&&!trial.busy&&model.unsent;
  let legacyScopePrompt=warehouse&&readLegacyScopePrompt(storage,identity,warehouse.id);
  let trial={busy:false,documents:null,documentId:'',result:null,error:'',warehouseId:null};
  const trialsCurrent=()=>trial.warehouseId===model.saved.warehouse?.id;
  const canTrial=()=>model.canPreview&&!model.unsent;

  const model=new OnboardingDialogue({call,storage,identity,guidedRules:true,onEnter:async(...args)=>{
    await onEnter(...args);
    if(model.saved.entryPending){
      model.saved.entryPending=false;
      try{model.persist();}catch{model.saved.entryPending=true;}
    }
    onComplete();
  },onChange:()=>{
    if(model.saved.setupMode==='suggestions' && model.saved.warehouse && model.state.loaded && !model.state.busy && !model.state.error){
      onSuggestions(model.saved.warehouse);
      return;
    }
    render();schedule();checkTurnModel();
  }});
  const close=()=>{if(closed)return;closed=true;clearTimeout(timer);model.dispose();dialog.remove();};
  const writing=()=>quickBusy||legacyBusy||model.state.busy||trial.busy;
  const directCreation=()=>quickAvailable&&!model.state.loaded&&!model.saved.warehouse;
  const updating=()=>model.saved.setupMode==='update';
  function schedule(){clearTimeout(timer);if(!closed&&model.generating&&!model.state.pollError)timer=setTimeout(async()=>{await model.poll();schedule();},3000);}
  function checkTurnModel(){
    const turn=model.state.turns[0],id=model.saved.warehouse?.id;
    if(!readUnavailableModel||!id||turn?.status!=='failed'||!modelErrors.has(turn.error_code)||modelProblems.has(turn.resource_id))return;
    modelProblems.set(turn.resource_id,null);
    void readUnavailableModel(id).then(problem=>{
      if(problem&&!closed){modelProblems.set(turn.resource_id,problem);render();}
    }).catch(()=>{ /* The reported turn error remains available when model settings cannot be read. */ });
  }
  function namePage(){
    const {state:s,saved:v}=model,locked=!!(quick||legacyCreation||v.pending||v.creation||recoveryError);
    const direct=directCreation();
    const readonly=locked||writing()&&s.loaded;
    const name=quick?.input.name||legacyCreation?.answers?.warehouse_name||v.creation?.name||v.name;
    const purpose=quick?.input.description??v.creation?.purpose??v.purpose??'';
    const profile = quick?.input.warehouseScope || v.creation?.warehouseScope || v.profileInputs || {};
    return `<form id="od-name-form" class="wp-name-card">
      <p class="od-opening-prompt">你希望这张星图帮你查到什么？</p><label class="wp-sr" for="od-purpose">${direct?'星图说明':'星图目标'}</label><textarea class="form-input" id="od-purpose" rows="3" maxlength="${direct&&[...purpose].length<=500?500:16000}" placeholder="例如：评审前想查清某项功能为什么这样设计，以及决定记录在哪里。" ${readonly?'readonly':''}>${esc(purpose)}</textarea>
      ${!locked&&!direct?`<div class="od-goal-choices" aria-label="星图目标示例">${goalChoices.map(([label],i)=>`<button type="button" class="btn btn-secondary" data-od-goal="${i}" ${readonly?'disabled':''}>${label}</button>`).join('')}</div>`:''}
      <label for="od-name">星图名称</label><input class="form-input" id="od-name" value="${esc(name)}" maxlength="60" required aria-describedby="od-name-error" aria-invalid="${!!nameError}" placeholder="例如：产品研究" ${readonly?'readonly':''}>
      <p class="od-name-error" id="od-name-error" role="alert" ${nameError?'':'hidden'}>${esc(nameError)}</p>
      <details id="od-profile"><summary>补充整理范围（选填）</summary>
      ${Object.entries(profileFields).map(([key,label])=>{
        const value=profile[key]||'';
        const placeholder={occupation:'例如：设备运维主管',service_objects:'例如：生产部（每行一项）',focus_objects:'例如：A 产线的空压机（每行一项）'}[key];
        return `<label for="od-${key}">${label} <small>选填</small></label><textarea class="form-input" id="od-${key}" data-profile="${key}" rows="1" maxlength="${key==='occupation'?200:1805}" placeholder="${placeholder}" ${readonly?'readonly':''}>${esc(Array.isArray(value)?value.join('\n'):value)}</textarea>`;
      }).join('')}
      </details>
      ${locked?'':templateCards()}
      ${direct?'':'<p class="wp-muted">在线模型会接收星图名称和你填写的内容。</p>'}
      <div class="wp-actions"><button type="submit" class="btn btn-primary" ${direct?'data-od="quick"':''} ${!direct&&!s.loaded||writing()||locked?'disabled':''}>${direct?'创建星图':'继续配置初始本体'}</button></div>
    </form>`;
  }
  function templateCards(){const {state:s,saved:v}=model;return `<details id="od-templates" class="od-templates"><summary>使用场景模板</summary><p class="wp-muted">填入名称和用途，可以继续编辑。</p><div class="od-template-grid">${namePageTemplates.map((t,i)=>`<button type="button" class="od-template-card" data-od-template="${i}" aria-pressed="${v.name===t.name&&(v.purpose||'')===t.purpose}" ${!s.loaded&&!directCreation()||writing()?'disabled':''}><strong>${esc(t.label)}</strong><span>${esc(t.description)}</span></button>`).join('')}</div></details>`;}
  function currentCard(){
    const {snapshot,turns}=model.state;
    if(!snapshot)return '';
    if(model.generating)return '<p class="od-thinking" role="status">正在整理你的本体…</p>';
    if(snapshot.status==='stale')return `<article class="wp-assistant wp-current"><p>生效规则或星图目标已变化。请基于最新规则继续对话。</p>${button('new-session','基于现行规则继续',true,writing()||!!model.saved.pending)}</article>`;
    const question=model.currentQuestion;
    if(model.state.page==='review')return '';
    if(snapshot.can_start&&turns[0]?.status==='failed'&&turns[0]?.kind==='opening')return '';
    if(question){
      const selectedAnswer=model.inputQuestion?.question_id===question.question_id?model.saved.input:null;
      return `<article class="wp-assistant wp-current">${questionCardsHTML([question],{editable:model.editable,selectedAnswer})}</article>`;
    }
    if(updating()&&!turns.length){
      const purpose=snapshot.seed?.purpose?.purpose||snapshot.draft.scope?.purposes?.[0];
      return `<article class="wp-assistant wp-current"><p>你想让这张星图记住哪些新内容？也可以说说要调整哪个类型、关系或属性。</p>
        ${purpose?`<details id="od-current-purpose"><summary>当前星图目标</summary><p>${esc(purpose)}</p></details>`:''}</article>`;
    }
    if(!turns.length)return '<article class="wp-assistant wp-current"><p>可以说说这张星图会用来做什么、要记住哪些内容。</p></article>';
    return '';
  }
  function retryTurn(turn){
    if(turn.kind==='opening')return model.state.snapshot?.can_start?button('start','重试生成',false,!model.editable):'';
    return `<button type="button" class="ob-button" data-od-retry="${esc(turn.resource_id)}" ${!model.editable?'disabled':''}>恢复本轮输入</button>`;
  }
  function messages(){
    const {snapshot,turns,sessions}=model.state;
    const selected=model.saved.conversationId;
    const options=sessions.map((session,index)=>{
      const time=Date.parse(session.created_at);
      return `<option value="${esc(session.id)}" ${session.id===selected?'selected':''}>${Number.isFinite(time)?sessionTime.format(time):'会话 '+(index+1)}</option>`;
    });
    const history=sessions.length>1?`<details id="od-previous-chats"><summary>对话记录</summary><label class="od-session-selector">选择记录<select id="od-session" ${writing()||model.generating||model.saved.pending?'disabled':''}>${options.join('')}</select></label></details>`:'';
    const latest=turns[0];
    const timeline=[...turns].reverse().map(turn=>{
        const error=turn.status==='failed';
        const models=error&&turn===latest&&onModels&&modelErrors.has(turn.error_code);
        const problem=modelProblems.get(turn.resource_id);
        const reply=turn.answer||error ? `<div class="sx-answer wp-assistant">
          ${turn.answer?`<p>${esc(turn.answer)}</p>`:''}${error?`<p role="status">${esc(problem?'处理模型「'+problem.name+'」'+problem.status+'。':dialogueError(turn))}</p><div class="wp-actions">${models?button('models','打开模型设置',false,!model.editable):''}${retryTurn(turn)}</div>`:''}</div>` : '';
        return `<div class="sx-turn">${turnInputHTML(turn,model.questions)}${reply}</div>`;
    });
    return `${history}${snapshot?.turns.has_more?button('more','加载更早的消息',false,writing()):''}
      ${timeline.join('')}`;
  }
  function draftCard(){
    const {snapshot,currentRuleVersion,page}=model.state;
    const draft=snapshot?.draft;
    if(!draft||model.generating||['stale','published'].includes(snapshot.status))return '';
    const preview=page==='review'?model.saved.preview:null;
    const proposed=draft.ontology_proposed??draft.revision>0;
    const canReview=model.canPreview&&(updating()||proposed);
    if(!preview&&(!proposed||updating()&&!draft.revision)&&!canReview)return '';
    const busy=writing()||!!model.saved.pending||model.unsent;
    const details=preview?reviewChecklistHTML({
      snapshot,preview,version:currentRuleVersion,deferredQuestionId:model.saved.deferredQuestionId,actions:'',
    }):dialogueSideHTML({
      snapshot,tab:model.state.tab,turns:model.state.turns,focusedDraft:true,editable:model.editable,hasInput:model.unsent,
    });
    const reviewCurrent=!updating()||model.updatePublicationAllowed;
    const canPublish=!!preview&&model.editable&&reviewCurrent;
    const changes=preview?.changes||draft.changes||[];
    const names=changes.slice(0,4).map(change=>esc((!change.before?'新增 ':!change.after?'停用 ':'修改 ')+((change.after||change.before)?.label||change.name))).join('、');
    const range=preview?scopeChangeLabels(snapshot,preview.scope):[];
    const detailsId=preview?'od-inline-review-details':'od-inline-draft-details';
    return `<article class="od-thread-draft" ${preview?'id="od-review" tabindex="-1"':''}>
      <h2>${preview?'发布核对':'本体草稿'}</h2>
      ${preview&&range.length?`<p>范围调整 · ${esc(range.slice(0,4).join('、'))}${range.length>4?'等':''}</p>`:''}
      ${names?`<p>${changes.length} 项规则改动 · ${names}${changes.length>4?'等':''}</p>`:''}
      <details id="${detailsId}"><summary>${preview?'查看范围变化与规则差异':'查看草稿'}</summary>${details}</details>
      ${preview&&!reviewCurrent?`<p class="wp-muted">请重新读取现行本体后再核对。${button('refresh','重新读取',false,writing())}</p>`:''}
      ${preview&&reviewCurrent?'<p class="wp-muted">确认发布后，新资料会按本次规则整理。</p>':''}
      <div class="wp-actions">${preview?button('publish','确认发布本体',true,busy||!canPublish):button('preview','核对草稿',true,busy||!canReview)}</div>
      <details id="${preview?'od-review-trial':'od-try'}"><summary>用资料试跑</summary>${trialHTML({
        ...(trialsCurrent()?trial:{documents:null}),ready:canTrial(),
        outdated:trial.result&&trial.result.draft_digest!==snapshot.draft_digest,
        result:trial.result?.draft_digest===snapshot.draft_digest&&!model.unsent?trial.result:null,
      })}</details>
    </article>`;
  }
  function publicationCard(){
    const {snapshot:s}=model.state,p=s?.publication||model.saved.publication;
    const published=s?.status==='published'||p;
    if(!published)return '';
    const replaced=s?.publication_effective===false;
    const version=Number.isSafeInteger(p?.version_number)?' v'+p.version_number:'';
    const text=replaced?'已有更新的生效版本。':p?.changed===false?'整理范围已更新，沿用本体'+version+'。':'本体'+version+'已发布。';
    return `<article class="wp-assistant od-publication" role="status"><p>${text}</p><div class="wp-actions">
      ${button('enter',updating()?'查看生效本体':'打开资料库',true,writing()||!!model.saved.pending)}
      ${updating()?button('new-session','继续调整',false,writing()||!!model.saved.pending):''}</div></article>`;
  }
  function composer(){
    const v=model.saved,q=model.inputQuestion,current=model.state.page==='review'?null:model.currentQuestion;
    if(['published','stale'].includes(model.state.snapshot?.status))return '';
    const disabled=!model.editable||trial.busy;
    return `<form id="od-answer-form" class="wp-composer">
      ${questionActionsHTML(v.questionActions,model.questions,{editable:model.editable})}
      <div class="sx-compose">
        <label class="wp-sr" for="od-input">描述项目规则</label>
        <textarea class="sx-input form-input" id="od-input" rows="2" maxlength="${q?4000:8000}" placeholder="${q?'回答当前配置问题…':'描述要补充或调整的规则…'}" ${disabled?'disabled':''}>${esc(v.input)}</textarea>
        <button type="submit" class="sx-send" ${!canSend()?'disabled':''}>发送</button>
      </div>
      <div class="wp-actions od-compose-actions">
        ${current&&q?`<button type="button" class="text-link" data-od="free-input" ${disabled?'disabled':''}>说另一件事</button>`:current?`<button type="button" class="text-link" data-od="answer-input" ${disabled?'disabled':''}>回答当前问题</button>`:''}
        <small class="od-input-context">在线模型会接收本轮输入</small>
      </div></form>`;
  }
  function chatPage(){
    const s=model.state;
    const goal=s.snapshot?.seed?.purpose?.purpose||model.saved.purpose;
    return `<div class="sx-ontology-grid">
      <section class="starxiaotu-panel wp-chat od-chat-thread" aria-label="本体设置对话">
        <div class="sx-messages wp-messages od-thread-messages" tabindex="0" role="log" aria-label="对话记录">
          ${!updating()&&goal?`<article class="wp-user"><p>${esc(goal)}</p></article>`:''}
          ${messages()}${currentCard()}${publicationCard()}</div>
        ${legacyScopePrompt&&model.editable?`<div class="od-legacy-scope">${legacyScopePrompt.length<=8000
          ?button('legacy-scope','带入之前的范围草稿',false,model.unsent)
          :`<details id="od-legacy-scope"><summary>查看之前的范围草稿</summary><pre>${esc(legacyScopePrompt)}</pre></details>`}</div>`:''}
        ${composer()}
      </section>
      <aside class="sx-ontology-draft" aria-label="本体草稿与发布核对">${draftCard()||'<h2>本体草稿</h2><p>有可核对的变更后，会显示在这里。</p>'}</aside>
      </div>`;
  }
  function render(){
    if(closed)return;
    const {state:s,saved:v}=model;
    const thread=dialog.querySelector('.od-thread-messages');
    const atEnd=!thread||thread.scrollHeight-thread.clientHeight-thread.scrollTop<45;
    const position=thread?.scrollTop||0;
    const open=new Map([...dialog.querySelectorAll('details[id]')].map(d=>[d.id,d.open]));
    const focused=document.activeElement;
    const focusId=dialog.contains(focused)?focused.id:null;
    const focusAction=dialog.contains(focused)?focused.dataset.od:null;
    const selection=focusId&&typeof focused.selectionStart==='number'?[focused.selectionStart,focused.selectionEnd]:null;
    const pending=v.pending||v.creation;
    const shownWarehouse=v.warehouse||warehouse;
    const published=v.publication||s.snapshot?.status==='published';
    const stage=shownWarehouse?'chat':'name';
    const needsSession=v.warehouse&&!v.conversationId&&!s.warehouseMissing;
    const locked=!!(quick||legacyCreation||recoveryError);
    const unsupported=s.error&&onboardingUnavailable(s.errorCode);
    const message=writeError||(unsupported
      ? updating()?'此盒端暂不支持本体对话，请更新盒端服务。':'暂时无法读取盒子的星图创建对话服务。'
      : '')||(s.readFailure&&!v.warehouse&&!pending&&['SEMANTICA_CONNECTION_FAILED','SEMANTICA_SERVICE_TIMEOUT','SEMANTICA_INVALID_RESPONSE'].includes(s.errorCode)
      ? '暂时无法读取星图。你可以先填写，恢复后再提交。':s.error);
    const nameConflict=s.errorCode==='WAREHOUSE_NAME_CONFLICT'&&!v.warehouse;
    if(nameConflict)nameError='已有同名星图，请修改名称。';
    const publishingEntry=['MODELING_PUBLISHED_ENTRY_FAILED','MODELING_PUBLICATION_REPLACED'].includes(s.errorCode);
    const refreshLabel=publishingEntry?(updating()?'重新打开本体':'重新打开资料库'):'重试读取';
    const status=recoveryError?`<div class="wp-error" role="alert">${esc(dialogueError({code:recoveryError}))}</div>`
      :quick||legacyCreation?`<div class="wp-info" role="status">${esc(message||(quick?.warehouse?'星图已创建，可以重新打开资料库。':'上次创建的结果待确认，请继续原请求。'))} ${button(legacyCreation?'legacy':'quick',quick?.warehouse?'重新打开资料库':'继续原请求',true,writing())}</div>`
      :pending?`<div class="wp-info" role="status">${esc(s.busy?'正在提交，请稍候。':s.error||'上次操作的结果待确认。')} ${button('recover',v.warehouse&&!v.conversationId?'继续创建会话':'继续原请求',true,s.busy)}</div>`
      :needsSession&&!s.busy?`<div class="wp-info" role="status">${updating()?'本体对话暂未就绪。':'星图已创建，本体对话暂未就绪。'}${message?` <span>${esc(message)}</span>`:''} ${button('recover','继续创建会话',true,!s.loaded)}</div>`
      :directCreation()&&!writeError?`<div class="wp-info" role="status">创建后会带着通用规则进入资料库。此盒子的星图创建对话需要更新服务。</div>`
      :message&&!nameConflict?`<div class="wp-error" role="alert">${esc(message)} ${button(publishingEntry?'enter':'refresh',refreshLabel,false,s.busy||s.warehouseMissing)}</div>`
      :s.busy&&!s.loaded?`<p class="wp-info" role="status">正在读取星图…</p>`:'';
    const body=stage==='name'?namePage():locked||s.warehouseMissing||needsSession||!s.snapshot&&!published?'':chatPage();
    dialog.dataset.stage=stage;
    dialog.setAttribute('aria-label',stage==='name'?'新建星图':'本体设置');
    const version=s.currentRuleVersion;
    const crumb=shownWarehouse?`<div class="od-crumb">${esc(shownWarehouse.name)}${Number.isSafeInteger(version)?' · 本体 v'+version:''}</div>`:'';
    dialog.innerHTML=`<div class="od-heading"><div>${crumb}<h1 id="od-title" tabindex="-1">${stage==='name'?'新建星图':'本体设置'}</h1></div>
      ${button('close',stage==='name'||published?'返回':'保存进度并返回',false,writing())}</div>
      <div class="wp-content">${status}${body}</div>`;
    const nextThread=dialog.querySelector('.od-thread-messages');
    if(nextThread)nextThread.scrollTop=atEnd?nextThread.scrollHeight:position;
    for(const [id,value] of open){const el=dialog.querySelector('#'+CSS.escape(id));if(el)el.open=value;}
    const next=focusId?dialog.querySelector('#'+CSS.escape(focusId)):focusAction?dialog.querySelector('[data-od="'+CSS.escape(focusAction)+'"]'):null;
    if(next&&!next.disabled){next.focus({preventScroll:true});if(selection&&next.setSelectionRange)next.setSelectionRange(...selection);}
  }
  function formFields(isQuick){
    const name=dialog.querySelector('#od-name').value.trim();
    const purpose=dialog.querySelector('#od-purpose').value.trim();
    const profile = {};
    for(const key of Object.keys(profileFields)){
      const value = dialog.querySelector('#od-'+key).value.trim();
      if(value)profile[key]=key==='occupation'?value:value.split(/\r?\n/).map(item=>item.trim()).filter(Boolean);
    }
    const invalid=scopePatchError(profile);
    const min=isQuick?1:2,max=isQuick?60:30;
    let errorField='name';
    if([...name].length<min||[...name].length>max)nameError=`请输入 ${min}–${max} 个字符作为星图名称。`;
    else if(isQuick&&[...purpose].length>500){
      nameError='星图说明最多可填写 500 个字符。';errorField='purpose';
    }else if(invalid){
      nameError=`请检查「${profileFields[invalid]}」：职业最多 200 字，对象最多 6 项、每项最多 300 字。`;errorField=invalid;
    }
    else nameError='';
    if(nameError){render();dialog.querySelector('#od-'+errorField)?.focus();return null;}
    return Object.keys(profile).length ? {name,purpose,warehouseScope:profile} : {name,purpose};
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
    try {
      await onQuick(fields?{name:fields.name,description:fields.purpose,warehouseScope:fields.warehouseScope}:{});
      if(model.live){
        model.saved.name='';model.saved.purpose='';model.saved.profileInputs={};
        try{model.persist();}catch{/* Creation succeeded even if clearing the local draft failed. */}
      }
      onComplete();
    }
    catch(error){
      try { quick=readQuick(); } catch { recoveryError='MODELING_LOCAL_RECORD_INVALID'; }
      if(!quick&&!recoveryError&&!model.state.loaded){
        await model.load({fresh:true});
        await checkQuickAccess();
        model.setName(attempted.name);model.setPurpose(attempted.description);
      }
      if(error.code==='WAREHOUSE_NAME_CONFLICT'&&!quick)nameError='已有同名星图，请修改名称。';
      else if(error.code==='MODELING_WAREHOUSE_ENTRY_FAILED')writeError='星图已创建，暂时无法打开资料库。';
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
  dialog.addEventListener('input',e=>{if(e.target.id==='od-name'){model.setName(e.target.value);nameError='';dialog.querySelector('#od-name-error').hidden=true;e.target.setAttribute('aria-invalid','false');}if(e.target.id==='od-purpose')model.setPurpose(e.target.value);if(e.target.dataset.profile)model.setProfileInput(e.target.dataset.profile,e.target.value);
    if(['od-name','od-purpose'].includes(e.target.id))for(const card of dialog.querySelectorAll('[data-od-template]')){const t=namePageTemplates[Number(card.dataset.odTemplate)];card.setAttribute('aria-pressed',String(model.saved.name===t.name&&(model.saved.purpose||'')===t.purpose));}
    if(e.target.id==='od-input'){
      e.target.setCustomValidity('');
      model.setInput(e.target.value);
      for(const choice of dialog.querySelectorAll('[data-od-choice][aria-pressed]')){
        const selected=(choice.dataset.choiceQuestion||undefined)===model.inputQuestion?.question_id&&choice.dataset.odChoice===e.target.value;
        choice.setAttribute('aria-pressed',String(selected));
      }
      const preview=dialog.querySelector('[data-od=preview]');
      if(preview)preview.disabled=!model.canPreview||model.unsent||writing();
      const publish=dialog.querySelector('[data-od=publish]');
      if(publish)publish.disabled=model.unsent||writing()||!model.editable||updating()&&!model.updatePublicationAllowed;
      const send=dialog.querySelector('#od-answer-form button[type="submit"]');
      if(send)send.disabled=!canSend();
      const intake=dialog.querySelector('[data-od=use-intake]');
      if(intake)intake.disabled=!model.editable||model.unsent;
      const legacy=dialog.querySelector('[data-od=legacy-scope]');
      if(legacy)legacy.disabled=model.unsent;
      for(const control of dialog.querySelectorAll('[data-od-rule], [data-od-scope]')){
        control.disabled=!model.editable||model.unsent||writing();
      }
      for(const control of dialog.querySelectorAll('[data-od=trial-load], [data-od=trial-more], [data-od=trial-run]')){
        control.disabled=!canTrial()||writing()||control.dataset.od==='trial-run'&&!trial.documentId;
      }
      const result=dialog.querySelector('.od-trial > .od-trial-compare');
      if(result)result.hidden=model.unsent;
    }
    if(e.target.hasAttribute('data-od-answer'))model.setQuestionAnswer(e.target.dataset.odAnswer,e.target.value);});
  dialog.addEventListener('change',e=>{if(e.target.id==='od-trial-document'){trial.documentId=e.target.value;trial.result=null;trial.error='';render();}if(e.target.id==='od-session')void model.chooseSession(e.target.value);});
  async function submit(e){
    e.preventDefault();
    if(e.target.id==='od-name-form'){
      if(writing()||quick||legacyCreation||recoveryError||model.saved.pending||model.saved.creation)return;
      if(directCreation())return void submitQuick();
      if(!model.state.loaded)return;
      const fields=formFields(false);if(!fields)return;
      model.setName(fields.name);model.setPurpose(fields.purpose);
      await model.create(fields.warehouseScope);await checkQuickAccess();
      dialog.querySelector(model.saved.warehouse?'#od-title':'#od-name')?.focus({preventScroll:true});
    }
    if(e.target.id==='od-answer-form'&&!trial.busy&&model.editable){
      if(!canSend())return;
      const value=dialog.querySelector('#od-input').value;
      model.setInput(value);
      for(const el of dialog.querySelectorAll('[data-od-answer]'))model.setQuestionAnswer(el.dataset.odAnswer,el.value);
      if(model.unsent)await model.sendComposer();
    }
    render();
  }
  dialog.addEventListener('submit',submit);
  function reveal(target){
    model.state.tab='list';
    render();const d=dialog.querySelector('#'+CSS.escape(target));if(d){
      for(let group=d;group;group=group.parentElement?.closest('details'))group.open=true;
      d.scrollIntoView({block:'nearest'});
    }
  }
  async function runTrial(load) {
    if(!canTrial()||writing())return;
    const snapshot=model.state.snapshot;
    const ids=model.ids();
    if(!trialsCurrent())trial={documents:null,documentId:'',warehouseId:ids.warehouseId};
    const selected=trial.documents?.find(doc=>doc.id===trial.documentId);
    if(!load&&!selected)return;
    trial.busy=true;trial.error='';trial.result=null;render();
    try {
      if(load){
        const offset=load==='more'?trial.nextOffset:0;
        const result=await model.read('conversation-material-workflows',{warehouseId:ids.warehouseId,offset,limit:50});
        if(!Array.isArray(result?.items))throw Error('SEMANTICA_INVALID_RESPONSE');
        const documents=result.items.filter(row=>row.document?.status==='ready'&&row.document_version_id)
          .map(row=>({id:row.document_id,version:row.document_version_id,title:row.document.original_name}));
        trial.documents=[...new Map([...(offset?trial.documents:[]),...documents].map(doc=>[doc.id,doc])).values()];
        const next=offset+result.items.length;
        trial.nextOffset=result.items.length&&next<result.total?next:null;
      }else{
        const result=await model.read('conversation-onboarding-trial',{...ids,operationId:model.uuid(),
          revision:snapshot.draft.revision,draftDigest:snapshot.draft_digest,documentId:selected.id,documentVersionId:selected.version});
        if(result?.publication_performed!==false||result.conversation_id!==ids.conversationId||
            result.draft_digest!==snapshot.draft_digest||result.document_id!==selected.id||
            result.document_version_id!==selected.version||typeof result.source?.text!=='string'||
            !Array.isArray(result.entities)||!Array.isArray(result.relations))throw Error('SEMANTICA_INVALID_RESPONSE');
        trial.result=result;
      }
    }catch(error){
      if(error.code==='MODELING_SOURCE_CHANGED'){trial.documents=null;trial.documentId='';trial.nextOffset=null;}
      const messages={MODELING_TRIAL_NO_TEXT:'这份材料暂无可试跑的正文。',MODELING_SOURCE_CHANGED:'材料正文已更新，请重新选择。',
        MODELING_TRIAL_TIMEOUT:'试跑超时，请重试。',MODELING_TRIAL_OUTPUT:'模型未返回可核对的结果，请重试。',
        MODELING_ONBOARDING_STALE:'草稿已更新，请重新读取后试跑。',
        SEMANTICA_OPERATION_NOT_ALLOWED:'当前盒端尚不支持试跑，可以直接进入发布核对。',
        SEMANTICA_UPGRADE_REQUIRED:'当前盒端需要更新后才能试跑，可以直接进入发布核对。',
        SEMANTICA_RESOURCE_NOT_FOUND:'未找到试跑接口或所选资料。可以重新选择资料，或直接进入发布核对。'};
      trial.error=messages[error.code]||'无法完成试跑，请检查盒子连接和抽取模型后重试。';
    }finally{
      trial.busy=false;render();
      if(trial.result)dialog.querySelector('.od-trial')?.scrollIntoView({block:'nearest'});
    }
  }
  dialog.addEventListener('keydown',e=>{
    if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing&&e.keyCode!==229&&e.target.id==='od-input'){
      e.preventDefault();
      if(canSend())e.target.form.requestSubmit();
      return;
    }
    const n=e.target.closest('[data-ontology-focus]');if(n&&['Enter',' '].includes(e.key)){e.preventDefault();reveal(n.dataset.ontologyFocus);}});
  dialog.addEventListener('click',e=>{
    const goal=e.target.closest('[data-od-goal]');
    if(goal){
      if(!goal.disabled){
        const answer=goalChoices[Number(goal.dataset.odGoal)][1];
        const previous=model.saved.purpose?.trim();
        const combined=previous&&!previous.split('\n').includes(answer)?previous+'\n'+answer:previous||answer;
        if([...combined].length<=16000)model.setPurpose(combined);
        if(!model.saved.name.trim())model.setName(goalChoices[Number(goal.dataset.odGoal)][2]);
        render();dialog.querySelector('#od-purpose')?.focus();
      }
      return;
    }
    const rule=e.target.closest('[data-od-rule]');
    if(rule){
      if(!rule.disabled&&!writing()&&model.editable&&!model.unsent){
        const kind=rule.dataset.odKind==='entity_types'?'实体类型':'关系类型';
        model.setInputMode('free');model.setInput(`调整${kind}「${rule.dataset.odRule}」（${rule.dataset.odRuleName}）。我的要求是：`);
        render();dialog.querySelector('#od-input')?.focus();
      }
      return;
    }
    const template=e.target.closest('[data-od-template]');if(template){if(!template.disabled){model.applyTemplate(namePageTemplates[Number(template.dataset.odTemplate)]);dialog.querySelector('#od-name')?.focus();}return;}const n=e.target.closest('[data-ontology-focus]');if(n){reveal(n.dataset.ontologyFocus);return;}
    const scope=e.target.closest('[data-od-scope]');
    if(scope&&!scope.disabled&&model.editable&&!model.unsent){
      const prompt=scopeEditPrompt(Number(scope.dataset.odScope));
      if(prompt){model.setInputMode('free');model.setInput(prompt);render();const input=dialog.querySelector('#od-input');input?.focus();input?.setSelectionRange(prompt.length,prompt.length);}
      return;
    }
    const question=e.target.closest('[data-od-question]'),remove=e.target.closest('[data-od-remove-question]');
    if(question&&!question.disabled){if(question.dataset.questionAction==='answer'&&question.closest('.wp-current,.od-scope-question')){model.answerQuestion(question.dataset.odQuestion);dialog.querySelector('#od-input')?.focus();}else{model.stageQuestion(question.dataset.odQuestion,question.dataset.questionAction);(dialog.querySelector('[data-od-answer="'+CSS.escape(question.dataset.odQuestion)+'"]')||dialog.querySelector('#od-input'))?.focus();}return;}
    if(remove&&!remove.disabled){model.removeQuestion(remove.dataset.odRemoveQuestion);return;}
    const choice=e.target.closest('[data-od-choice]'),retry=e.target.closest('[data-od-retry]');if(choice||retry){if(!model.editable)return;
      if(retry){model.restoreReply(retry.dataset.odRetry);const a=model.saved.questionActions;if(!model.saved.input&&a.length===1&&a[0].action==='answer')model.answerQuestion(a[0].question_id,a[0].answer);}else if(choice.dataset.choiceQuestion)model.answerQuestion(choice.dataset.choiceQuestion,choice.dataset.odChoice);else model.setInput(choice.dataset.odChoice);
      render();(dialog.querySelector('[data-od-answer]')||dialog.querySelector('#od-input'))?.focus();return;}
    const b=e.target.closest('[data-od]');if(!b||b.disabled)return;const a=b.dataset.od;
    if(trial.busy&&!['graph','list'].includes(a))return;
    if(a==='close')return onClose();
    if(a==='legacy-scope'&&legacyScopePrompt&&!model.unsent&&model.editable){
      model.setInputMode('free');model.setInput(legacyScopePrompt);legacyScopePrompt='';render();dialog.querySelector('#od-input')?.focus();return;
    }
    if(['trial-load','trial-more','trial-run'].includes(a))return void runTrial(a==='trial-more'?'more':a==='trial-load');
    if(a==='models'&&onModels&&model.editable){
      b.disabled=true;
      void onModels(model.saved.warehouse,model.state.turns[0]?.context_budget?.required_context_tokens).catch(error=>{
        if(!closed){writeError=dialogueError(error);render();}
      }).finally(()=>{if(b.isConnected)b.disabled=false;});
      return;
    }
    if(a==='quick'){if(b.type!=='submit')void submitQuick();return;}if(a==='legacy')return void submitLegacy();
    if(a==='free-input'||a==='answer-input'){model.setInputMode(a==='free-input'?'free':'answer');dialog.querySelector('#od-input')?.focus();return;}
    if(['graph','list'].includes(a)){model.state.tab=a;render();return;}
    if(a==='publish'){
      if(writing()||!model.editable||model.unsent||model.state.page!=='review'||updating()&&!model.updatePublicationAllowed)return;
      model.state.confirmed=true;
    }
    if(a==='new-session'&&model.unsent&&!window.confirm('将保留未发送的内容，是否基于现行规则继续？'))return;
    const actions={start:()=>model.start(),refresh:()=>refreshStatus(),recover:()=>model.recover(),preview:()=>model.preview(),publish:()=>model.publish(),enter:()=>model.enter(),'new-session':()=>model.newSession(),more:()=>model.more()};
    if(actions[a])void actions[a]().then(()=>{
      render();
      if(a==='preview'&&model.state.page==='review'){
        const review=dialog.querySelector('#od-review');
        review?.focus({preventScroll:true});
        review?.scrollIntoView({block:'nearest'});
      }
    });
  });
  render();
  if(!quick&&!legacyCreation&&!recoveryError)void model.load({warehouse,fresh,startUpdate}).then(checkQuickAccess);
  return {close,get busy(){return writing();},focus(){(dialog.querySelector('#od-name')||dialog.querySelector('#od-title'))?.focus({preventScroll:true});}};
}
