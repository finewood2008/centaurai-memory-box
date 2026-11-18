import {knowledgeCurrent,publicationCurrent,retainedMaterialResults} from './conversation-progress.mjs';
import {visibleMaterialIntents} from './material-continuation.mjs';
import {warehouseMaterialEntries,materialSourceRemoved} from './material-library.mjs';
import {materialAgentTools,materialAutomaticCard,materialAgentFeedback} from './material-agent.mjs';
import {canDeleteMaterial} from './material-deletion.mjs';
import {materialWorkflowLabel} from './material-state.mjs';
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const labels={awaiting_upload:'等待上传',parsing:'正在解析',awaiting_goal:'核对正文与目标',ready_for_confirmation:'待确认计划',queued:'排队中',running:'抽取中',awaiting_review:'待核对知识',failed:'处理失败',cancelled:'已停止',stale:'来源已变化'};
export function materialListHTML(flow,reader=false){
  if(!flow)return '<p>正在读取材料…</p>';
  const s=flow.state,off=s.busy||!s.loaded||!!flow.saved.pending||!!flow.saved.upload||!!flow.saved.intakeSubmission||!!flow.saved.roundOpening;
  const groups={...s.materialIndex,[flow.saved.conversationId]:s.intents};
  const placeholders=Object.entries(groups).flatMap(([conversationId,items])=>visibleMaterialIntents(flow,items||[]).filter(i=>!i.document_id&&!materialSourceRemoved(i)).map(i=>({...i,conversationId})));
  const entries=warehouseMaterialEntries(flow).map(row=>{
    const links=row.links.filter(link=>!flow.saved.resumedIntents?.[link.intent.id]);
    const link=links.find(link=>link.conversationId===flow.saved.conversationId&&link.intent.id===s.selectedIntent)||links[0];
    return {...link?.intent,id:link?.intent.id||row.document.id,document_id:row.document.id,conversationId:link?.conversationId,original_name:row.document.original_name||link?.intent.original_name,
      inventory:true,workflow:row.document.workflow,documentStatus:row.document.status,linked:!!link};
  }).concat(placeholders);
  const status=i=>{
    const label=materialWorkflowLabel(i.workflow);if(label)return label;
    if(i.workflow&&(s.librarySelection||i.conversationId!==flow.saved.conversationId||i.id!==s.selectedIntent))return i.workflow.label;
    if(i.inventory&&!i.linked)return ({ready:'正文已解析',queued:'解析排队中',processing:'解析中',parsing:'解析中',failed:'解析失败'}[i.documentStatus]||'查看材料状态');
    const selected=i.conversationId===flow.saved.conversationId&&i.id===s.selectedIntent,d=selected?s.detail:i;
    if(retainedMaterialResults(d))return knowledgeCurrent(d,selected?s.knowledge:null)?'已发布 · 已读取生效知识':d.review?.status==='discarded'?'草稿已放弃':d.review?.draft_id?'继续核对草稿':'已停止抽取 · 结果可核对';
    return ['cancelled','stale','failed'].includes(i.status)?labels[i.status]:selected&&knowledgeCurrent(s.detail,s.knowledge)?'已发布 · 已读取生效知识':i.publication_effective||publicationCurrent(i)?'服务端已发布':flow.saved.materialContinuations?.[i.id]?.mode==='draft'?'继续核对草稿':labels[i.status]||i.status||'待处理';
  };
  const empty = !s.loaded ? s.error ? '资料列表暂不可读' : '正在读取资料列表…'
    : s.warehouseMaterialError ? '资料列表暂不可读' : '这个仓还没有资料';
  const query=reader?String(s.readerQuery||'').trim().toLocaleLowerCase():'';
  const visible=query?entries.filter(i=>String(i.original_name||'').toLocaleLowerCase().includes(query)):[...entries];
  if(reader&&s.readerSort==='name')visible.sort((a,b)=>String(a.original_name||'').localeCompare(String(b.original_name||''),'zh-CN',{numeric:true}));
  const total = s.loaded ? `<small>${query?`${visible.length} / `:''}${s.warehouseMaterialTotal??entries.length}</small>` : '';
  const tools=reader?`<div class="mw-reader-list-tools"><input id="cv-material-query" type="text" autocomplete="off" aria-label="搜索资料名称" placeholder="${s.warehouseMaterialMore?'搜索已加载的资料':'搜索资料'}" value="${esc(s.readerQuery)}">
    <select id="cv-material-sort" aria-label="资料排序"><option value="recent">最近</option><option value="name" ${s.readerSort==='name'?'selected':''}>名称</option></select></div>`:'';
  const rowHTML=i=>{
    const label=status(i),name=i.original_name||'待上传材料';
    const selected=s.librarySelection?s.librarySelection.document.id===i.document_id:i.conversationId===flow.saved.conversationId&&i.id===s.selectedIntent;
    const tone=label?.includes('待核对')||label?.includes('草稿')||label?.includes('待发布')?'pending':label?.includes('发布')&&!label?.includes('未发布')?'published':/失败|停止/.test(label)?'issue':'';
    return `<button type="button" class="mw-material ${selected?'selected':''}" ${selected?'aria-current="true"':''}
      data-cv="${i.inventory?'library-select':'material-select'}" data-session="${esc(i.conversationId)}" data-id="${esc(i.inventory?i.document_id:i.id)}" ${off?'disabled':''} ${reader?`title="${esc(name)} · ${esc(label)}" aria-label="${esc(name)} · ${esc(label)}"`:''}>
      <span class="mw-file-icon" aria-hidden="true">▤</span><span><strong>${esc(name)}</strong>${reader?'':`<small>${esc(label)}</small>`}</span>${reader?`<span aria-hidden="true" class="mw-reader-dot ${tone?`is-${tone}`:''}"></span>`:''}</button>`;
  };
  return `<header><strong>资料</strong>${total}</header>
    ${tools}
    ${flow.saved.materialDeletion?`<p role="alert">材料删除结果尚未确认。</p><button class="btn btn-secondary" data-cv="material-delete" ${s.busy?'disabled':''}>恢复删除请求</button>`:''}
    <div class="mw-material-list">${visible.map(rowHTML).join('')||`<p class="mw-list-empty">${query?'没有匹配的资料':empty}</p>`}</div>
    ${s.warehouseMaterialError?'<p role="alert">全仓材料列表读取失败，当前仅保留已读取的材料。</p><button class="btn btn-secondary" data-cv="material-refresh">重试读取材料</button>':''}
    ${s.warehouseMaterialMore?'<button class="btn btn-secondary" data-cv="library-more">加载更多仓库材料</button>':''}
    ${s.materialIndexError?'<p role="alert">部分材料列表未读取成功。</p><button class="btn btn-secondary" data-cv="material-refresh">重试读取列表</button>':''}
    ${s.hasMore?'<button class="btn btn-secondary" data-cv="material-more">加载更多材料</button>':''}
    `;
}

export function materialLibraryHTML(flow){
  const selected=flow.state.librarySelection;if(!selected)return '';
  const d=selected.document,w=d.workflow,links=w?.conversations?.filter(l=>l.conversation_status==='active').map(l=>({conversationId:l.conversation_id,intent:{id:l.intent_id}}))||[],off=flow.state.busy;
  const destination=(view,label)=>`<button class="btn btn-secondary" data-warehouse-id="${esc(flow.warehouseId)}" data-warehouse-view="${view}">${label}</button>`;
  return `<div class="material-workspace"><aside class="mw-library" aria-label="材料列表">${materialListHTML(flow)}</aside>
    <section class="mw-review" aria-label="材料状态"><header><div><small>当前仓库材料</small><h2>${esc(d.original_name||d.id)}</h2></div><div class="mw-material-tools"><button class="btn btn-secondary" data-cv="library-select" data-id="${esc(d.id)}" ${off?'disabled':''}>读取最新状态</button><button class="btn btn-secondary" data-cv="material-delete" ${canDeleteMaterial(flow)?'':'disabled'}>删除材料</button></div></header>
    <div class="mw-review-content">${materialAgentTools(flow)}${materialAutomaticCard(flow)}<h3>${esc(w?.label||'材料状态待确认')}</h3>
      ${w?`<p>${w.processing_mode==='dialogue'?'对话核对 · 确认后发布':'自动处理'}${w.publication?' · 当前正文已有已发布结果':''}</p>${w.tasks.map(t=>`<p>${esc(t.stage)} · ${esc(t.completed_units)} / ${t.total_units??'待确定'} 单元</p>`).join('')}`:''}
      <p>正文解析状态不代表知识已发布。处理任务和已发布结果可在下方查看。</p><div class="conversation-toolbar">${destination('tasks','查看处理任务')}${destination('graph','查看已发布知识')}</div>
      ${links.length?`<h3>已有材料会话</h3><p>选择需要继续的会话，恢复其目标、草稿与处理进度。</p>${links.map(({conversationId,intent})=>`<p><button class="btn btn-secondary" data-cv="material-select" data-session="${esc(conversationId)}" data-id="${esc(intent.id)}" ${off?'disabled':''}>继续会话 · ${esc(d.original_name||'当前材料')}</button></p>`).join('')}`:w?.actions.start_dialogue.allowed?'<p>开始对话后先核对正文与目标，确认处理计划后才开始抽取。</p><button class="btn btn-primary" data-cv="library-start" '+(off?'disabled':'')+'>开始对话核对</button>':`<p>${esc(w?.actions.start_dialogue.reason||'请读取最新材料状态')}</p>`}
      ${w?.publication?'<p>开始对话将基于当前原文核对目标；现有发布结果会保留，新结果需确认后才生效。</p>':''}
      ${w?.draft&&!links.length?'<p>这份材料已有核对草稿，可在材料编辑器中读取并恢复编辑权。</p><button class="btn btn-secondary" data-cv="library-review" '+(off?'disabled':'')+'>查看现有材料草稿</button>':''}
      ${flow.state.hasMore?'<button class="btn btn-secondary" data-cv="material-more">读取更多材料会话</button>':''}
      ${flow.state.error?`<p role="alert">${esc(flow.state.error)}</p>`:''}</div></section>
    <section class="mw-assistant"><header><strong>材料助手</strong></header><div class="mw-review-content">${materialAgentFeedback(flow)}<p>查看材料不会自动启动抽取、创建草稿或发布知识。</p><p>进入已有材料会话后，可继续对话核对。</p></div></section></div>`;
}

// Move the real confirmation controls, preserving their handlers and disabled state.
// Forms remain in the review area; HTML's form attribute keeps submission native.
export function mountMaterialWorkspace(root){
  const review=root.querySelector('.mw-review-content'),actions=root.querySelector('.mw-confirm-actions');
  if(!review)return;
  const session=root.querySelector('.conversation-session');if(session){session.querySelector('[data-cv="new"]')?.remove();root.querySelector('.mw-library').append(session);}
  const operations=root.querySelector('.cv-materials');
  if(operations){
    if(operations.querySelector('.cv-material')){
      operations.querySelector('summary').textContent='材料处理与恢复操作';
      const body=document.createElement('div');body.className='mw-recovery-body';
      while(operations.children.length>1)body.append(operations.children[1]);
      operations.append(body);operations.classList.add('mw-recovery-menu');
      root.querySelector('.mw-material-tools').append(operations);
    }else operations.remove();
  }
  const welcome=root.querySelector('.mw-welcome');
  if(welcome){
    const reveal=event=>{
      if(event.type==='keydown'&&!['Enter',' '].includes(event.key))return;
      const node=event.target.closest('[data-ontology-focus]');if(!node)return;
      const target=document.getElementById(node.dataset.ontologyFocus);if(!target||!welcome.contains(target))return;
      event.preventDefault();for(let el=target;el&&el!==welcome;el=el.parentElement)if(el.tagName==='DETAILS')el.open=true;
      target.scrollIntoView({block:'nearest'});target.querySelector('summary')?.focus({preventScroll:true});
    };
    welcome.addEventListener('click',reveal);welcome.addEventListener('keydown',reveal);
  }
  if(!actions)return;
  root.querySelectorAll('.conversation-composer .cv-attachment-strip,.conversation-composer [data-cv="upload"],.conversation-composer [data-cv="documents"]').forEach(el=>el.remove());
  const selector=['instruction-read','instruction-prepare','instruction-confirm','instruction-abandon','change-exclusion-apply','change-exclusion-cancel','change-suggest-labels','change-continue-extraction','material-edit-existing','change-discard-prepare','change-discard-confirm','change-discard-cancel','intake-confirm','intake-original-goal','intake-start-goal','plan','confirm-plan','candidates','merge','review','begin-edit','change-preview','change-publish','change-publish-rules','change-claim','claim-review','change-open-draft','open-review','change-apply','change-answer','change-revise','change-defer','change-recover'].map(a=>`[data-cv="${a}"]`).join(',');
  for(const control of review.querySelectorAll(selector)){
    if(control.closest('details:not([open])'))continue;
    if(control.type==='submit'&&control.form)control.setAttribute('form',control.form.id);
    // Keep workflow actions in the review area. Duplicate only buttons in the
    // assistant pane; shared confirmation inputs retain a single DOM owner.
    const shortcut=control.cloneNode(true);shortcut.removeAttribute('id');actions.append(shortcut);
  }
  for(const id of ['cv-publish-confirmed','cv-rule-confirmed','cv-keep-existing']){
    const input=review.querySelector('#'+id);if(input?.closest('label'))input.closest('label').classList.add('mw-review-confirmation');
  }
  const publicationBlocker=review.querySelector('.cv-publication-blocked');
  if(publicationBlocker)actions.prepend(publicationBlocker);
  const staleDraftAction=review.querySelector('.cv-draft-stale [data-cv="advanced-review"]');
  if(staleDraftAction)actions.append(staleDraftAction);
  const proposal=root.querySelector('.conversation-messages .cv-proposal-current');
  if(proposal&&!review.querySelector('.mw-proposal-review')){
    const diff=proposal.querySelector('[data-cv-disclosure^="proposal-"]');
    if(diff){const block=document.createElement('section');block.className='mw-proposal-review';const heading=document.createElement('h3');heading.textContent='本轮修改差异';block.append(heading,diff);review.prepend(block);}
  }
  const empty=actions.querySelector('.mw-no-action');if(empty&&actions.querySelector('button'))empty.remove();
  const card=actions.closest('.mw-confirm-card');if(card)card.hidden=!actions.querySelector('button,input,label,.cv-publication-blocked');
}

export function openMaterialUpload(flow){
  if(document.querySelector('#mw-upload-dialog'))return;
  const dialog=document.createElement('dialog');dialog.id='mw-upload-dialog';dialog.className='mw-upload-dialog';
  dialog.setAttribute('aria-labelledby','mw-upload-title');
  let note='',closed=false,working=false;
  function render(){
    const s=flow.state,staged=flow.intake.staged,busy=working;
    dialog.innerHTML=`<header><div><h2 id="mw-upload-title">导入材料</h2><p>选择一份材料，导入后先解析并核对正文。</p></div><button type="button" class="btn btn-secondary" data-upload="cancel" ${busy?'disabled':''}>关闭</button></header>
      <div class="mw-upload-body"><div class="mw-upload-zone"><span aria-hidden="true">↑</span><strong>${staged?esc(staged.name):'关联当前仓已有材料'}</strong><p>新文件请通过页面右上角从万象空间导入。</p><button class="btn btn-secondary" data-upload="documents" ${busy?'disabled':''}>关联已有材料</button></div>
      ${s.documents.length?`<div class="mw-link-list">${s.documents.map(d=>`<button class="btn btn-secondary" data-document="${esc(d.id)}" ${busy?'disabled':''}>${esc(d.original_name||d.id)}</button>`).join('')}${s.documentMore?'<button class="btn btn-secondary" data-upload="more">加载更多</button>':''}</div>`:''}
      <label for="mw-upload-note">材料说明（选填）</label><textarea id="mw-upload-note" rows="3" maxlength="8000" placeholder="例如：这是一份采购合同，重点关注付款与违约责任。" ${busy?'disabled':''}>${esc(note)}</textarea>
      ${s.error?`<p role="alert">${esc(s.error)}</p>`:''}</div><footer><button class="btn btn-secondary" data-upload="cancel" ${busy?'disabled':''}>取消</button><button class="btn btn-primary" data-upload="submit" ${busy||!staged?'disabled':''}>${staged?.kind==='document'?'关联并开始核对':'上传并解析'}</button></footer>`;
  }
  function close(){closed=true;dialog.close();dialog.remove();}
  async function cancel(){if(working)return;working=true;render();try{await flow.intake.remove();if(!flow.intake.staged){flow.state.documents=[];close();}}finally{working=false;if(!closed&&dialog.isConnected)render();}}
  dialog.addEventListener('cancel',event=>{event.preventDefault();void cancel();});
  dialog.addEventListener('input',event=>{if(event.target.id==='mw-upload-note')note=event.target.value;});
  dialog.addEventListener('click',async event=>{
    const b=event.target.closest('button');if(!b||b.disabled||working)return;
    const action=b.dataset.upload;
    if(action==='cancel'){await cancel();return;}
    if(action==='submit'){
      // A preflight failure leaves the file and note editable in this dialog.
      // Once durable submission has taken ownership, recovery belongs to the workspace.
      working=true;render();await flow.intake.submit({isolated:true,note});working=false;
      if(!dialog.isConnected)return;
      if(!flow.intake.staged){close();if(flow.state.materialPage==='import'&&flow.state.detail?.document_id&&!flow.saved.pending)await flow.importer.select(flow.state.detail.document_id);}else render();return;
    }
    working=true;render();
    await (b.dataset.document?flow.intake.stageDocument(b.dataset.document):flow.listDocuments(action==='more'?flow.state.documentOffset:0));
    working=false;if(!closed&&dialog.isConnected)render();
  });
  document.body.append(dialog);render();dialog.showModal();
}
