import {materialProgress,retainedMaterialResults} from './conversation-progress.mjs';
import {currentMaterialWorkflow,publishedMaterial,pendingMaterialDraft} from './material-state.mjs';

export function latestChange(flow) {
  const c=flow?.changes,items=(c?.state.proposals||[]).filter(p=>!c?.record.changeTarget||(c.record.proposalTargets?.[p.id]||'facts')===c.record.changeTarget);
  const remembered=items.find(p=>p.id===c.record.lastProposal)||items[0]||null;
  return items.reduce((latest,p)=>Date.parse(p.created_at)>Date.parse(latest?.created_at)?p:latest,remembered);
}

// Choose a single next action from receipts, never from the last page visited.
export function nextConversationStep(flow) {
  if(!flow?.state.loaded)return 'loading';
  const s=flow.state,d=s.detail,c=flow.changes,p=latestChange(flow);
  const w=currentMaterialWorkflow(flow),publishedBaseline=!!d&&w?.document_version_id===d.document_version_id&&publishedMaterial(w)&&!pendingMaterialDraft(w)&&w.stage!=='awaiting_review';
  if(flow.saved.pending||flow.reviewPending||flow.claimPending||flow.releasePending||c?.record.pending||c?.claimRequest)return 'recovery';
  if(flow.intake?.record&&!retainedMaterialResults(d)){
    if(flow.intake.unavailable)return 'stopped';
    if(!flow.intake.sourceReviewed)return flow.intake.source?'source-review':'parsing';
  }
  if(!d)return 'upload';
  if(['cancelled','stale'].includes(d.status)&&!retainedMaterialResults(d))return 'stopped';
  // Active work takes precedence over old drafts retained for recovery.
  if(['queued','running'].includes(d.status)||['queued','running'].includes(d.execution?.status))return 'extracting';
  if(c?.state.exclusion)return 'draft';
  const publication=c?.state.publication||d.outcome?.publication;
  if(['queued','running','submitted'].includes(publication?.status)||!publishedBaseline&&c?.state.summary?.status==='submitted'&&!publication&&!c?.independent)return 'receipt';
  if(!c?.independent&&!publishedBaseline&&(c?.state.summary?.status==='discarded'||!c?.state.summary&&d.review?.status==='discarded'&&(!c?.record.draftId||c.record.draftId===d.review.draft_id)))return 'discarded';
  if(['queued','running','generating'].includes(s.turn?.status))return 'reading';
  if(flow.instructions?.open)return 'instruction';
  if(s.merge)return 'merge';
  if(c?.independent){
    if(['generating','prepared','needs_clarification','failed','stale'].includes(p?.status)&&p.id!==c.record.deferredProposal)return 'proposal';
    if(c.record.ontologyDraftId)return 'rules';
    if(c.record.rulesPublished&&c.record.rulesPublished.ontologyId===s.ontology?.id&&c.record.rulesPublished.documentVersionId===d.document_version_id)return 'rules-ready';
  }
  if(c?.state.leases?.length)return 'draft';
  if(c?.state.summary?.status==='editing'&&c.state.summary.stale_reason)return 'draft';
  // Recover access to the material before displaying a remembered proposal.
  if(!publishedBaseline&&!c?.state.summary&&(d.review?.draft_id||c?.record.draftId&&!c.record.previousIntent)&&!materialProgress(d,s.knowledge).published)return 'draft';
  if(['generating','prepared','needs_clarification','failed','stale'].includes(p?.status)&&p.id!==c?.record.deferredProposal)return 'proposal';
  // A changed goal retains the document draft, but the new intent still needs
  // its own plan and an explicit merge of its extraction results.
  if(c?.record.previousIntent&&!d.review?.draft_id&&d.source_status==='available'){
    if(d.execution||d.status==='awaiting_review')return 'candidates';
    if(!d.execution){
      if(!d.goal?.goal||s.goalDirty||d.status==='awaiting_goal')return 'goal';
      if(d.status==='ready_for_confirmation')return 'plan';
    }
  }
  if(c?.state.summary){
    if(c.state.summary.status!=='editing')return publishedBaseline||materialProgress(d,s.knowledge).published?'published':'receipt';
    return c.state.preview?'publication':'draft';
  }
  if(c?.record.draftId||d.review?.draft_id){
    if(publishedBaseline||materialProgress(d,s.knowledge).published)return 'published';
    return 'draft';
  }
  if(c?.record.ontologyDraftId)return 'rules';
  const workflow=currentMaterialWorkflow(flow);
  if(workflow?.document_version_id===d.document_version_id&&publishedMaterial(workflow)&&!pendingMaterialDraft(workflow)&&workflow.stage!=='awaiting_review')return 'published';
  if(d.execution||d.status==='awaiting_review')return 'candidates';
  if(!d.document_version_id||d.source_status!=='available'||d.status==='parsing')return 'parsing';
  if(!d.goal?.goal||s.goalDirty||flow.intake?.record?.goalNeedsConfirmation||d.status==='awaiting_goal')return 'goal';
  if(d.status==='ready_for_confirmation')return 'plan';
  return 'goal';
}

// Routing only selects a read/reply or an unapplied proposal. It never authorizes writes.
export function materialQuestion(text){
  const value=String(text||'').trim();
  return /^(?:请|帮我)?(?:解释|介绍|总结|概括|分析|检查|看看|不要修改|不修改)/.test(value)||/(?:为什么|为何|如何|怎么|怎样|是否|能否|可否|请问|哪里有问题|有什么问题|哪些问题|需要修正吗)/.test(value)||/[?？]$/.test(value);
}
export function conversationInputRoute(text,flow) {
  const value=String(text||'').trim(),s=flow.state;
  if(s.messageMode==='question')return 'question';
  if(/^(?:请|帮我)?(?:确认发布|发布(?:本篇|当前材料)?知识|开始抽取|确认抽取|确认计划|确认目标|应用修改)[。！!\s]*$/.test(value))return 'confirmation';
  if(materialQuestion(value))return 'question';
  if(s.messageMode==='change')return 'change';
  if(!s.detail?.document_version_id)return 'question';
  // Questions and negated instructions stay in the reading path, even with edit vocabulary.
  if(/^(?:为什么|为何|怎么|如何|是否|能否|可否|请问|解释|介绍|总结|概括|不要修改|不修改)/.test(value)||/[?？]$/.test(value))return 'question';
  if(s.composerContext||latestChange(flow)?.status==='needs_clarification'&&latestChange(flow)?.id!==flow.changes.record.deferredProposal)return 'change';
  return /(?:改为|改成|修改|调整|更名|重命名|合并|归为|排除|不需要|不用关注|只(?:关注|保留|整理|抽取)|重点关注|目标(?:是|改)|我(?:希望|想要)|增加|新增|补充|删除|去掉|保留|不要抽取)/.test(value)?'change':'question';
}
