import {dialogueTemplates} from './onboarding-templates.mjs';
import {messageFor,samples} from './onboarding-state.mjs';
import {OnboardingHome,shouldResumeDialogue} from './onboarding-home-state.mjs';
import {readWorkbenchReply} from './native-workbench.js';
import {mountOnboardingDialogue} from './onboarding-dialogue.mjs';

const escape = value => String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function createOnboardingUI({bridge, enter, leave}) {
  const root=document.querySelector('#onboarding-shell');
  let flow=null, identity=null, blocked='', visible=false, opening=0, navigation=0, warehouseDialogue=null;
  const button=(action,text,disabled=false,primary=false)=>`<button type="button" class="ob-button ${primary?'ob-primary':''}" data-ob="${action}" ${disabled?'disabled':''}>${text}</button>`;
  function welcome(s) {
    const symbol=(paths)=>`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
    const archive=symbol('<path d="M4 4h16v5H4zM6 9v12h12V9M10 13h4"/>');
    const icons=[symbol('<path d="M12 3v17M7 21h10M4 7h16M6 7l-3 9h6L6 7ZM18 7l-3 9h6l-3-9Z"/>'),symbol('<circle cx="9" cy="7" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3M16 4a3 3 0 0 1 0 6M18 14a5 5 0 0 1 3 4v3"/>'),symbol('<path d="m7 7-5 5 5 5m10-10 5 5-5 5M14 4l-4 16"/>')];
    return `<div class="ob-welcome"><section class="ob-welcome-hero"><div class="ob-welcome-badge"><span>${archive}</span>欢迎使用星图</div><h1>${s.warehouses.length?'从一个知识仓开始':'从第一个知识仓开始'}</h1><p>告诉星图你准备整理什么资料、希望解决什么问题，逐步把材料整理成可查询、可核查的知识。</p>
      <div class="ob-welcome-start">${button(s.creation?'recover-creation':'dialogue-new',s.creation?'恢复未完成的创建':s.warehouses.some(w=>w.state==='active')?'＋ 创建新知识仓':'＋ 创建第一个知识仓',s.busy||!s.loaded||!!blocked,true)}<small>下一步：命名，然后通过对话明确范围</small></div><p class="ob-welcome-hint">先创建知识仓，再与助手逐步梳理服务对象、用途和本体范围，无需提前上传文件。</p></section>
      <section class="ob-welcome-flow"><h2>从用途到知识，分步完成</h2><ol>${[
        ['命名，创建知识仓','只需填写名称，创建后进入建仓对话。'],
        ['通过对话明确本体范围','逐轮梳理服务对象、用途、类型、关系和属性，核对完整范围后统一确认发布。'],
        ['上传材料，核对知识','通过对话明确目标，抽取结果可逐项核对原文依据。'],
      ].map(([title,description],i)=>`<li><div class="ob-welcome-step"><span>${i+1}</span><i></i></div><h3>${title}</h3><p>${description}</p></li>`).join('')}</ol></section>
      ${!s.warehouses.some(w=>w.state==='active')?`<section class="ob-welcome-templates"><h2>不知道怎么开始？试试这些场景</h2><p class="ob-field-hint">选择模板后，可修改知识仓名称和用途，确认创建后再开始对话。</p><div class="ob-samples">${samples.map((sample,i)=>`<button type="button" class="ob-sample" data-ob="template-${i}" ${s.busy||!s.loaded||blocked||s.creation?'disabled':''}><span class="ob-welcome-sample-title">${icons[i]}<strong>${escape(sample.name)}</strong></span><p>${escape(sample.material_types)}</p><p>${escape(sample.purpose)}</p><span class="ob-sample-link">使用此模板 →</span></button>`).join('')}</div></section>`:''}
      ${s.warehouses.length?`<div class="ob-section-head"><h2>继续已有的工作</h2><span>${s.warehouses.length} 座个人知识仓</span></div><div class="ob-existing">${s.warehouses.map(w=>`<div class="ob-existing-row"><button data-ob="enter" data-id="${escape(w.id)}" ${s.busy||w.state!=='active'?'disabled':''}><span><strong>${escape(w.name)}</strong><small>${escape(w.description || '个人知识仓')}</small></span><span>进入 →</span></button><button data-ob="dialogue-resume" data-id="${escape(w.id)}" ${s.busy||!s.loaded||w.state!=='active'?'disabled':''}>继续建仓对话</button></div>`).join('')}</div>`:''}</div>`;
  }
  function render() {
    if(!visible||!flow)return;
    const s=flow.state;
    root.dataset.page='welcome';root.classList.remove('ob-review-open');delete root.dataset.reviewKey;
    const scroll=root.querySelector('.ob-scroll')?.scrollTop||0;
    root.innerHTML=`<aside class="ob-sidebar"><div class="ob-brand"><img src="../resources/icon.png" alt=""/><div><strong>万象·星图</strong><small>WanX · Starlink</small></div></div><p class="ob-space-label">个人空间</p><div class="ob-nav-item">✧ <span>开始工作</span></div><div class="ob-private"><span>◉</span><div>你的个人知识空间<small>仅当前账号可访问</small></div></div><div class="ob-account"><span class="ob-avatar">${escape(identity?.user.name?.slice(0,1))}</span><span>${escape(identity?.user.name)}</span><span class="ob-online">已连接</span></div></aside><main class="ob-main"><header class="ob-topbar"><span>个人知识仓 <span class="ob-slash">/</span> 开始工作</span>${button('exit','返回工作区',s.busy)}</header><div class="ob-scroll"><div class="ob-container">
      ${blocked?`<div class="ob-error" role="alert">${escape(messageFor({code:blocked}))}</div>`:''}
      ${s.error?`<div class="ob-error" role="alert">${escape(s.error)} ${button('refresh','重新读取',s.busy)}</div>`:''}
      ${s.creation?'<div class="ob-notice">此前的创建请求尚未完成。恢复时沿用原操作号，创建成功后进入建仓对话。</div>':''}
      ${s.notice?`<div class="ob-notice" role="status">${escape(s.notice)}</div>`:''}
      ${!s.loaded&&!blocked&&!s.error?'<div class="ob-loading" role="status">正在读取个人知识仓…</div>':''}
      ${welcome(s)}</div></div></main>`;
    if(!s.loaded||blocked)root.querySelectorAll('[data-ob]:not([data-ob="exit"]):not([data-ob="refresh"])').forEach(el=>{el.disabled=true;});
    root.querySelector('.ob-scroll').scrollTop=scroll;
  }
  async function open(value,{fresh=false,warehouseId=null,startup=false,preferredWarehouseId=null}={}) {
    // Detach the previous view before closing its dialogue, so onClose cannot
    // refresh a superseded account or leave a late callback on the new launcher.
    visible=false;warehouseDialogue?.close();flow?.reset();
    const current=++opening;identity=value.identity;visible=true;root.hidden=false;document.querySelector('#app').hidden=true;
    blocked=identity.dataScope!=='personal'?'MODELING_HOST_CREATION_REQUIRED':value.status?.local_data_gate_mode==='required'?'MODELING_GATE_REQUIRED':'';
    // Keep the legacy record reader only to recover existing warehouses and
    // uncertain creation requests. No form, suggestion generation or old review UI.
    flow=new OnboardingHome({storage:window.localStorage,identity,onChange:render,call:async(action,input)=>{
      if(current!==opening||!visible)throw Object.assign(Error(),{code:'HOST_SESSION_EXPIRED'});
      if(blocked)throw Object.assign(Error(),{code:blocked});
      const result=readWorkbenchReply(await bridge.call(action,input));
      if(current!==opening||!visible)throw Object.assign(Error(),{code:'HOST_SESSION_EXPIRED'});
      return result;
    }});
    render();if(!blocked)await flow.load();if(current!==opening||!visible||blocked||!flow.state.loaded)return;
    if(warehouseId){const warehouse=flow.state.warehouses.find(w=>w.id===warehouseId&&w.state==='active');if(warehouse)openDialogue({warehouse});else{flow.state.error=messageFor({code:'MODELING_RESOURCE_NOT_FOUND'});render();}return;}
    if(fresh){if(!flow.state.creation)openDialogue({fresh:true});return;}
    if(startup){
      const home=flow,route=navigation;
      const resume=await shouldResumeDialogue({storage:window.localStorage,identity,warehouses:home.state.warehouses,call:(action,input)=>home.read(action,input)});
      if(current!==opening||!visible||home!==flow||route!==navigation||warehouseDialogue)return;
      if(resume){openDialogue();return;}
      const warehouse=!flow.state.creation&&!flow.state.pending&&flow.state.warehouses.find(w=>w.id===preferredWarehouseId&&w.state==='active');
      if(warehouse)await enterWarehouse(flow,warehouse);
    }
  }
  function close(){visible=false;warehouseDialogue?.close();root.hidden=true;document.querySelector('#app').hidden=false;}
  function openDialogue(options={}) {
    if(warehouseDialogue||blocked||!flow?.state.loaded||flow.state.busy)return;
    if(flow.state.creation){flow.state.notice='请先恢复此前的创建请求，再继续建仓对话。';render();return;}
    const current=flow,epoch=opening;
    warehouseDialogue=mountOnboardingDialogue({...options,storage:window.localStorage,identity,
      call:async(action,input)=>{if(current!==flow||epoch!==opening||!visible||blocked)throw Object.assign(Error(),{code:'HOST_SESSION_EXPIRED'});const result=readWorkbenchReply(await bridge.call(action,input));if(current!==flow||epoch!==opening||!visible)throw Object.assign(Error(),{code:'HOST_SESSION_EXPIRED'});return result;},
      onEnter:async warehouse=>{const isCurrent=()=>current===flow&&epoch===opening&&current.live&&visible;if(!isCurrent())return;await enter(warehouse,{isCurrent});if(isCurrent()){close();current.reset();}},
      onClose:()=>{warehouseDialogue=null;if(current===flow&&current.live&&visible)void current.refresh();}});
  }
  async function enterWarehouse(current,warehouse) {
    if(!warehouse||current!==flow||!current.live||!visible||!current.state.loaded||blocked)return;
    const isCurrent=()=>flow===current&&current.live&&visible;
    await current.run(async()=>{try{await enter(warehouse,{isCurrent});if(isCurrent()){close();current.reset();}}catch{if(isCurrent())current.state.error='知识仓已保留，进入失败，请重新读取后再试。';}});
  }
  async function recoverCreation(){
    const current=flow;if(!current?.state.creation||current.state.busy||!current.state.loaded||blocked)return;
    await current.create({generate:false});
    if(current===flow&&current.live&&visible&&!current.state.error&&!current.state.creation&&current.state.warehouse)openDialogue({warehouse:current.state.warehouse});
  }
  root.addEventListener('click',event=>{
    const target=event.target.closest('[data-ob]');if(!target||target.disabled||!flow)return;
    navigation++;
    const action=target.dataset.ob;
    if(action==='dialogue-new')openDialogue({fresh:true});
    if(action.startsWith('template-')){const template=dialogueTemplates[Number(action.slice(9))];if(template)openDialogue({fresh:true,template});}
    if(action==='dialogue-resume'){const warehouse=flow.state.warehouses.find(w=>w.id===target.dataset.id&&w.state==='active');if(warehouse)openDialogue({warehouse});}
    if(action==='recover-creation')void recoverCreation();
    if(action==='refresh')void flow.refresh();
    if(action==='exit'){close();leave();}
    if(action==='enter')void enterWarehouse(flow,flow.state.warehouses.find(w=>w.id===target.dataset.id&&w.state==='active'));
  });
  return {open,close,get visible(){return visible;},reset(){opening++;visible=false;warehouseDialogue?.close();flow?.reset();flow=null;root.replaceChildren();close();}};
}
