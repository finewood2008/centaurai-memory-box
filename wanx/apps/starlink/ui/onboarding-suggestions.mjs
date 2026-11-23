import {OnboardingFlow, currentRuleReview} from './onboarding-state.mjs';
import {RuleReview} from './onboarding-rules.mjs';
import {ruleReviewHTML, rulePreviewHTML} from './onboarding-rules-view.mjs';
import {suggestionResultHTML} from './onboarding-suggestion-view.mjs';
import {createProgressPoller} from './onboarding-progress.mjs';

export function mountWarehouseSuggestions({
  host, warehouse, initialCreation, storage, identity, call, readUnavailableModel, onModels, onClose, onEnter, onComplete,
}) {
  const section=document.createElement('section');
  section.className='ob-container';
  section.tabIndex=-1;
  host.append(section);
  let review=null, entering=false, entryError='', modelCheck=null;
  const flow=new OnboardingFlow({call,storage,identity,warehouseId:warehouse.id,onChange:render});
  const poller=createProgressPoller({current:()=>flow,active:()=>!review&&flow.live});
  const button=(action,label,disabled=false,primary=false)=>
    `<button class="ob-button ${primary?'ob-primary':''}" data-ob="${action}" ${disabled?'disabled':''}>${label}</button>`;
  const busy=()=>entering||flow.state.busy||!!review?.state.busy;

  function render(){
    if(!flow.live)return;
    const s=flow.state;
    let content;
    if(review)content=ruleReviewHTML(review);
    else if(s.loaded)content=suggestionResultHTML(s,{button, onModels,
      unavailableModel:modelCheck?.proposalId===s.proposal?.id?modelCheck?.issue:null});
    else content=s.busy?'':button('refresh','重新读取');
    section.innerHTML=`<div class="ob-footer">${button('close','返回我的项目',busy())}</div>
      <p role="alert" class="ob-error" data-error hidden></p>
      ${s.busy?`<p role="status">${s.pending?.action==='onboarding-generate'?'正在根据建仓信息生成本体建议…':'正在读取建仓信息和本体建议…'}</p>`:''}${content}`;
    const error=entryError||s.error;
    if(error){const el=section.querySelector('[data-error]');el.textContent=error;el.hidden=false;}
    poller.sync();
    const proposal = s.proposal;
    if (!review && !s.busy && readUnavailableModel && proposal?.status==='failed' &&
        proposal.id && modelCheck?.proposalId!==proposal.id) {
      const check = modelCheck = {proposalId:proposal.id, issue:null};
      void readUnavailableModel(warehouse.id).then(issue => {
        if (!flow.live || modelCheck!==check || !issue) return;
        check.issue=issue;
        render();
      }).catch(()=>{});
    }
  }
  async function openReview(){
    if(!flow.state.ruleProposalId)return;
    review=new RuleReview({call,storage,identity,warehouseId:warehouse.id,proposalId:flow.state.ruleProposalId,onChange:render});
    await review.load();
  }
  async function enter(){
    entering=true;entryError='';render();
    try{
      const publication=review?.state.publication||currentRuleReview(flow.state.context,flow.state.proposal)?.publication;
      await onEnter(warehouse,{view:'conversation',publication});
      onComplete();
    }catch{entryError='暂时无法打开资料库。建仓和本体建议的进度已保存，可以重试。';}
    finally{entering=false;render();}
  }
  async function refresh(){
    modelCheck=null;
    await flow.openSuggestions(warehouse,initialCreation);
    if(flow.state.loaded&&currentRuleReview(flow.state.context,flow.state.proposal)?.publication)await openReview();
  }
  section.addEventListener('change',e=>{
    if(!review||busy())return;
    if(e.target.hasAttribute('data-rule-confirm')){
      review.confirm(e.target.checked);
      section.querySelector('[data-rule="publish"]').disabled=!review.state.confirmed;
    }else if(e.target.matches('select[data-rule-field]')){
      review.choose(e.target.dataset.ruleId,e.target.dataset.ruleField,e.target.value);
      render();
    }
  });
  section.addEventListener('input',e=>{
    if(!review||busy()||!e.target.matches('input[data-rule-field]'))return;
    review.choose(e.target.dataset.ruleId,e.target.dataset.ruleField,e.target.value);
    section.querySelector('.ob-rule-preview').innerHTML=rulePreviewHTML(review);
  });
  section.addEventListener('click',async e=>{
    const el=e.target.closest('button,[data-ontology-focus]');
    if(!el||el.disabled||busy())return;
    if(el.dataset.ontologyFocus){
      const target=section.querySelector('#'+CSS.escape(el.dataset.ontologyFocus));
      if(target){for(let d=target.closest('details');d;d=d.parentElement?.closest('details'))d.open=true;target.scrollIntoView({block:'nearest'});}
      return;
    }
    const action=el.dataset.ob;
    if(action==='close')return onClose();
    if(action==='enter-created')return enter();
    if(action==='rules')return openReview();
    if(action==='models'&&onModels){
      try { await onModels(); }
      catch { entryError='暂时无法打开当前星图的模型设置，请读取进度后重试。'; render(); }
      return;
    }
    if(action==='refresh')return refresh();
    if(action==='generate')return flow.generate();
    if(action==='reconsider'){
      await flow.reviewAgain();
      if(!flow.state.error)await flow.generate();
      return;
    }
    if(!review)return;
    switch(el.dataset.rule){
      case 'back': review.reset();review=null;await flow.openSuggestions(warehouse);break;
      case 'refresh': await review.refresh();break;
      case 'save': await review.save();break;
      case 'publish': await review.publish();if(review?.state.publication)await enter();break;
      case 'retry': if(review.state.pending?.action==='onboarding-rule-publish')await review.publish();else await review.save();break;
    }
  });
  void flow.openSuggestions(warehouse,initialCreation).then(()=>{
    if(flow.live&&currentRuleReview(flow.state.context,flow.state.proposal)?.publication)void openReview();
  });
  return {focus:()=>section.focus(),get busy(){return busy();},close(){poller.stop();review?.reset();flow.reset();section.remove();}};
}
