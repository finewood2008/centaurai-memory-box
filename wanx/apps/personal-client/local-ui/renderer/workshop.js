window.replaceWanxWorkshopMarkup = function(root, markup) {
 const selector = 'iframe[data-studio-frame-key]';
 const current = root.querySelector?.(selector);
 if (current?.isConnected && typeof current.parentElement?.moveBefore === 'function') {
  const template = root.ownerDocument.createElement('template');
  template.innerHTML = markup;
  const next = template.content.querySelector(selector);
  if (next?.dataset.studioFrameKey === current.dataset.studioFrameKey) {
   // Move the iframe between connected parents to keep its document and message port alive.
   const previous = [...root.childNodes];
   const parent = next.parentElement;
   const sibling = next.nextSibling;
   next.remove();
   root.append(template.content);
   parent.moveBefore(current, sibling);
   for (const child of previous) child.remove();
   return;
  }
 }
 root.innerHTML = markup;
};

window.createWanxWorkshop = function({request, changed}) {
 const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const errors={WORKSHOP_UPDATE_REQUIRED:'当前盒端尚未提供工坊服务，请先更新盒端。',WORKSHOP_MARKET_SOURCE_REQUIRED:'云端尚未提供可编辑源码，请先获取允许修改的兼容应用包。',WORKSHOP_CAPABILITY_UNSUPPORTED:'此应用需要当前个人工坊尚未适配的运行能力，暂不支持定制。',WORKSHOP_SOURCE_REQUIRED:'应用未提供可编辑源码，暂不支持定制。',WORKSHOP_MODIFICATION_NOT_ALLOWED:'此应用未授予修改许可。',WORKSHOP_FORMAT_UNSUPPORTED:'源码格式不兼容当前工坊。',WORKSHOP_SOURCE_CHANGED:'来源版本已变化，请重新选择。',WORKSHOP_SOURCE_INVALID:'源码未通过完整性检查。',WORKSHOP_PERSONAL_ONLY:'万象工坊首版仅供个人使用。',HOST_SESSION_EXPIRED:'连接已变化，请重新打开工坊。',WORKSHOP_SESSION_EXPIRED:'授权已失效，请重新连接盒子。',ENGINE_NOT_CONFIGURED:'请先配置万象默认模型。',BUILD_ACTIVE:'当前仍有修改任务，请完成或停止后再管理项目。',VERSION_CHANGED:'项目已变化，请刷新后重新确认。',WORKSHOP_VERSION_PROTECTED:'此版本正在使用，不能清理。',WORKSHOP_INSTALLED_PROJECT:'已安装应用仍依赖此项目，可先保留在回收站中。',WORKSHOP_CLEANUP_PATH_INVALID:'清理目录异常，数据已保留，请检查后重试。'};
 const publicError=e=>Object.hasOwn(errors,e?.code||e?.message) ? e.code||e.message : null;
 const message=e=>errors[publicError(e)]||'操作未完成，请检查盒子连接后重试。';
 let scope='',online=false,active=false,epoch=0,items=[],selected='',query='',loaded=false,loading=false,error='',modal=null,sources=[],sourceId='',name='',operation=null,busy=false,mobileDetail=false,filter='active',menu=false,manageHash='',notice='',trashBatch=null;
 let academyStage=null,academyError=null;
 const product=window.createStudioProduct({request:(action,input)=>request(action.replace('studio.','').replace('preview.','preview.'),input),changed,
   supportError:code=>{academyError=code;},cleanup:hash=>action('workshop-clean-version',{hash})});
 const size=n=>n>=1048576?(n/1048576).toFixed(1)+' MB':Math.max(1,Math.round(n/1024))+' KB';
 const filtered=()=>items.filter(p=>Boolean(p.deletedAt)===(filter==='deleted')&&p.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
 function selection(){return items.find(p=>p.id===selected)}
 function sync(key,connected,visible){
  if(key&&key!==scope){academyStage=null;academyError=null;epoch++;scope=key;items=[];selected='';loaded=false;loading=false;error='';notice='';filter='active';menu=false;modal=null;sources=[];operation=null;trashBatch=null;busy=false;product.reset();}
  if(!connected&&online){epoch++;loaded=false;loading=false;busy=false;product.pause();}
  if(connected&&!online){error='';academyError=null;}
  online=connected;active=visible;product.sync(scope,selection(),active&&online);
  if(active&&online&&!loaded&&!loading&&!error)void refresh();
 }
 async function refresh(){if(!online||loading)return;const turn=epoch;loading=true;error='';academyError=null;changed();try{const value=await request('list');if(turn!==epoch)return;items=value.items;selected=filtered().some(p=>p.id===selected)?selected:filtered()[0]?.id||'';loaded=true;}catch(e){if(turn===epoch){error=message(e);academyError=publicError(e)}}finally{if(turn===epoch){loading=false;changed();}}}
 async function openSource(id){if(!online||!id||busy)return;const turn=epoch;modal='loading';sources=[];sourceId='';operation=null;error='';changed();try{const value=await request('sources');if(turn!==epoch)return;const source=value.items.find(s=>s.id===id);if(!source?.editable)throw Error(source?.reason||'WORKSHOP_SOURCE_REQUIRED');sources=[source];sourceId=source.id;name=(source.name+' · 我的定制').slice(0,128);modal='confirm';}catch(e){if(turn===epoch){modal=null;error=message(e);academyError=publicError(e)}}finally{if(turn===epoch)changed();}}
 async function action(action,input={}){
  if(action.startsWith('studio-product-')){
   if(action==='studio-product-tab'){academyStage=['preview','versions'].includes(input.tab)?input.tab:'project';academyError=null;}
   if(['studio-product-version','studio-product-reload'].includes(action)){academyStage='preview';academyError=null;}
   return product.action(action,input);
  }
  if(['workshop-select','workshop-back','workshop-filter','workshop-locate'].includes(action)){
   academyStage=null;academyError=null;
  }
  if(action==='workshop-filter'){filter=input.mode==='deleted'?'deleted':'active';selected=filtered()[0]?.id||'';mobileDetail=false;menu=false;changed();return;}
  if(action==='workshop-locate'){await refresh();const p=items.find(p=>p.id===input.projectId);if(p){filter=p.deletedAt?'deleted':'active';query='';selected=p.id;mobileDetail=true;changed();}return;}
  if(action==='workshop-more'){menu=!menu;changed();return;}
  if(action==='workshop-empty-trash'){
   if(busy||loading)return;const trash=items.filter(p=>p.deletedAt);if(!trash.length)return;
   trashBatch={entries:[],skipped:[],attempted:false};
   for(const p of trash){const reason=p.management?.purgeBlocked||(!Number.isSafeInteger(p.management?.revision)?'项目管理信息尚未读取，请刷新后重试。':'');if(reason)trashBatch.skipped.push({name:p.name,reason});else trashBatch.entries.push({name:p.name,state:'pending',error:'',operation:{projectId:p.id,operationId:crypto.randomUUID(),action:'purge',expectedRevision:p.management.revision,confirmedByUser:true}});}
   modal='empty-trash';menu=false;error='';changed();return;
  }
  if(action==='workshop-empty-trash-confirm'){
   if(busy||!online||modal!=='empty-trash'||!trashBatch)return;const batch=trashBatch,turn=epoch;busy=true;error='';batch.attempted=true;changed();
   try{
    for(const entry of batch.entries){
     if(turn!==epoch||!online)return;if(entry.state==='done')continue;entry.state='running';entry.error='';changed();
     try{const result=await request('manage',entry.operation);if(turn!==epoch)return;if(!result.purged)throw Error('WORKSHOP_PURGE_INCOMPLETE');entry.state='done';items=items.filter(p=>p.id!==entry.operation.projectId);}
     catch(e){if(turn!==epoch)return;entry.state='failed';entry.error=message(e);}
     changed();
    }
    if(turn!==epoch)return;const done=batch.entries.filter(e=>e.state==='done').length,remaining=batch.skipped.length+batch.entries.length-done;
    notice=(done?'已彻底删除 '+done+' 个项目并清理开发资料。':'本次未删除项目。')+(remaining?'本轮保留 '+remaining+' 个项目，请查看原因。':'');
    selected=filtered().some(p=>p.id===selected)?selected:filtered()[0]?.id||'';product.reset();if(!remaining){modal=null;trashBatch=null;}await refresh();if(turn===epoch&&!remaining&&!error){const left=items.filter(p=>p.deletedAt).length;notice+=left?'回收站还有 '+left+' 个项目，可再次清理。':'回收站已清空。';}
   }finally{if(turn===epoch){busy=false;changed();}}return;
  }

  if(['workshop-rename','workshop-delete','workshop-restore','workshop-purge','workshop-clean-version'].includes(action)){if(!selection()||busy)return;modal=action.slice(9);manageHash=input.hash||'';name=selection().name;operation=null;menu=false;error='';changed();return;}
  if(action==='workshop-manage'){
   const p=selection();if(!p||busy)return;if(!Number.isSafeInteger(p.management?.revision)){error='项目管理信息尚未读取，请关闭弹窗并刷新后重试。';changed();return;}const turn=epoch;operation||={projectId:p.id,operationId:crypto.randomUUID(),action:modal,expectedRevision:p.management.revision,...(modal==='rename'?{name:name.trim()}:{}),...(modal==='clean-version'?{artifactHash:manageHash}:{}),confirmedByUser:true};
   busy=true;error='';changed();try{const result=await request('manage',operation);if(turn!==epoch)return;notice=result.purged?'项目已彻底删除，开发资料占用已清理。':result.cleanedBytes?'已清理约 '+size(result.cleanedBytes)+' 开发资料；业务数据保留。':modal==='delete'?'项目已移入回收站，可以恢复；彻底删除后释放空间。':modal==='restore'?'项目已恢复。':'已保存';if(result.project)items=items.map(item=>item.id===result.project.id?{...item,deletedAt:result.project.deletedAt,management:result.project.management,name:result.project.name}:item);else if(result.purged)items=items.filter(item=>item.id!==p.id);if(modal==='restore')filter='active';selected=filtered().some(item=>item.id===selected)?selected:filtered()[0]?.id||'';modal=null;operation=null;product.reset();await refresh();}catch(e){if(turn===epoch){error=message(e);academyError=publicError(e)}}finally{if(turn===epoch){busy=false;changed()}}return;
  }
  if(action==='workshop-refresh')return refresh();
  if(action==='workshop-open-source')return openSource(input.sourceId);
  if(action==='workshop-cancel'){if(!busy){modal=null;operation=null;trashBatch=null;changed()}return;}
  if(action==='workshop-select'){selected=input.projectId;menu=false;mobileDetail=true;product.sync(scope,selection(),online);changed();return;}
  if(action==='workshop-back'){mobileDetail=false;changed();return;}
  if(action==='workshop-copy'){
   if(busy||!online||modal!=='confirm'||!sourceId||!name.trim())return;const turn=epoch;operation||={operationId:crypto.randomUUID(),sourceId,name:name.trim()};busy=true;error='';changed();
   try{const result=await request('copy',operation);if(turn!==epoch)return;selected=result.projectId;filter='active';modal=null;mobileDetail=true;loaded=false;await refresh();await request('open',{projectId:selected});}
   catch(e){if(turn===epoch){error=message(e);academyError=publicError(e)}}finally{if(turn===epoch){busy=false;changed();}}return;
  }
  if(action==='workshop-template-update'){if(busy||!selection()?.templateUpdate)return;const p=selection();busy=true;changed();try{await request('template.update',{projectId:p.id,artifactHash:p.latestArtifactHash,operationId:crypto.randomUUID()});await refresh();await request('open',{projectId:p.id});}catch(e){error=message(e)}finally{busy=false;changed()}return;}
  if(action==='workshop-deployment'){const turn=epoch;try{await request('deployment.open',{});}catch(e){if(turn===epoch){error=message(e);changed()}}return;}
  if(action==='workshop-open'){if(!selection())return;const turn=epoch;try{await request('open',{projectId:selected});}catch(e){if(turn===epoch){error=message(e);academyError=publicError(e);changed()}}}
 }
 function render(renderControls){
  const controls = renderControls
    ? renderControls("workshop", loading, loading || !online)
    : `<button class="button small" data-action="workshop-refresh" ${loading||!online?'disabled':''}>刷新</button>`;
  const heading=`<header class="workshop-heading wanx-section-banner" data-section="workshop"><div class="workshop-brand"><span class="personal-module-mark workshop-section-mark" role="img" aria-label="万象工坊标志"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 8.5h10M10 8.5v11M4 19.5h13"/><rect x="15" y="3" width="5.5" height="5.5" rx="1.2"/></svg></span><div><h2>万象工坊 <span class="feature-beta">Beta</span> <span class="wanx-section-english">WanX Workshop</span></h2><p>把现有应用，打磨成你的专属工具。</p></div></div><div class="applications-banner-actions"><button class="button small" data-action="workshop-deployment" ${!online?'disabled':''}>部署交付目录</button>${controls}</div></header>`;
  if(!online)return `<section class="workshop">${heading}<section class="workshop-empty"><h3>连接盒子后开始修改</h3><p>连接盒子后查看本地应用；新定制请从“我的应用”发起。</p><button class="button primary" data-action="workshop-connect">连接盒子</button></section></section>`;
  const p=selection(),list=filtered();product.sync(scope,p?.deletedAt?null:p,active&&online);
  return `<section class="workshop">${heading}${error?`<p class="notice error" role="alert">${esc(error)}</p>`:''}${notice?`<p class="workshop-notice" role="status">${esc(notice)}</p>`:''}<div class="workshop-layout ${mobileDetail?'show-detail':''}"><aside class="workshop-list"><strong>本地应用 <small>${items.filter(p=>!p.deletedAt).length}</small></strong><nav class="workshop-filters" aria-label="项目筛选"><button data-action="workshop-filter" data-mode="active" aria-pressed="${filter==='active'}">全部</button><button data-action="workshop-filter" data-mode="deleted" aria-pressed="${filter==='deleted'}">回收站 <small>${items.filter(p=>p.deletedAt).length}</small></button></nav><input aria-label="搜索本地应用" data-workshop-field="search" placeholder="搜索本地应用" value="${esc(query)}">${filter==='deleted'&&items.some(p=>p.deletedAt)?`<div class="workshop-trash-toolbar"><button class="text-button" data-action="workshop-empty-trash" ${busy||loading?'disabled':''}>清空回收站</button></div>`:''}${list.map(p=>`<button class="workshop-row ${p.id===selected?'selected':''}" data-action="workshop-select" data-project-id="${esc(p.id)}"><strong>${esc(p.name)}</strong><span>${p.deletedAt?'回收站中，可恢复':esc(p.label)} · v${esc(p.latestVersion||'0.1.0')}</span></button>`).join('')||`<p class="muted">${loading?'正在读取…':error?'读取未完成，请刷新重试。':query?'没有匹配的应用':filter==='deleted'?'回收站是空的':'请从“我的应用”发起修改。'}</p>`}</aside><article class="workshop-detail"><button class="text-button workshop-back" data-action="workshop-back">‹ 返回应用列表</button>${p?`<header><div><h3>${esc(p.name)}</h3><p>来源：${esc(p.workshop?.name||p.workshop?.applicationId)} · v${esc(p.workshop?.version)} · 独立副本与数据</p></div><div class="workshop-detail-actions">${!p.deletedAt?'<button class="button primary" data-action="workshop-open">继续修改 ↗</button>':'<button class="button primary" data-action="workshop-restore">恢复项目</button>'}<div class="workshop-menu-wrap"><button class="button small" data-action="workshop-more" aria-label="项目管理" aria-expanded="${menu}">•••</button>${menu?`<div class="workshop-menu" role="menu">${p.deletedAt?`<button data-action="workshop-purge" ${p.management?.purgeBlocked?'disabled':''}>彻底删除</button>${p.management?.purgeBlocked?'<small>已安装应用仍依赖此项目</small>':''}`:'<button data-action="workshop-rename">重命名</button><button data-action="workshop-delete">移入回收站</button>'}</div>`:''}</div></div></header><div class="workshop-meta-strip"><span><small>最新成果</small><strong>v${esc(p.latestVersion)}</strong></span><span><small>当前采用</small><strong>${p.adoptedVersion?'v'+esc(p.adoptedVersion):'尚未采用'}</strong></span><span><small>历史版本</small><strong>${p.versions?.length||0} 版 <em>· ${size(p.management?.bytes||0)}</em></strong></span></div>${p.templateUpdate?`<p class="workshop-summary">模板 v${esc(p.templateUpdate)} 已可试用。保留当前应用身份与数据，采用后才更新安装。<button class="button small" data-action="workshop-template-update" ${busy?'disabled':''}>试用模板新版</button></p>`:''}<details class="workshop-project-notes"><summary>项目说明</summary><p class="workshop-summary">${esc(p.versions?.[0]?.summary||'已建立修改副本，原应用保留。')}</p></details>${p.deletedAt?`<div class="workshop-archived"><span>↺</span><h3>项目已收起，随时可以恢复</h3><p>源码、版本和业务数据保留。已安装应用继续可用。</p><button class="button" data-action="workshop-purge" ${p.management?.purgeBlocked?'disabled':''}>彻底删除</button><small>${esc(p.management?.purgeBlocked||'彻底删除后释放项目开发资料占用的空间，无法恢复。')}</small></div>`:product.render()}`:'<div class="workshop-empty"><h3>让应用适合你的工作方式</h3><p>从“我的应用”发起修改后，定制应用会出现在这里。原版继续保留，每轮修改都能对比和恢复。</p></div>'}</article></div>${modal?dialog():''}</section>`;
 }
 function managementDialog(){const p=selection(),v=p?.versions?.find(v=>v.hash===manageHash),labels={rename:'重命名项目',delete:'移入回收站？',restore:'恢复项目？',purge:'彻底删除项目？','clean-version':'清理历史版本？'};return `<div class="workshop-shade"><section class="workshop-dialog workshop-confirm" role="dialog" aria-modal="true" aria-label="${labels[modal]}"><header><h3>${labels[modal]}</h3><button class="text-button" data-action="workshop-cancel" ${busy?'disabled':''}>取消</button></header>${error?`<p class="notice error" role="alert">${esc(error)}</p>`:''}${modal==='rename'?`<label>项目名称<input data-workshop-field="name" maxlength="128" value="${esc(name)}" ${busy?'disabled':''}></label>`:`<p><strong>${esc(p?.name)}${v?' · v'+esc(v.version):''}</strong></p><p class="muted">${modal==='delete'?'从项目列表收起，源码和版本保留，可在回收站中恢复；已安装应用不受影响。':modal==='restore'?'恢复后可以继续修改，已有版本与数据保留。':modal==='purge'?'彻底删除项目源码、历史版本、修改记录和开发缓存，并释放空间，无法恢复。应用业务数据保留。':'永久删除此版源码、预览产物和开发缓存，无法再试用或恢复此版本。其他版本和业务数据保留。'}</p>`}<button class="button ${['purge','clean-version'].includes(modal)?'danger':'primary'}" data-action="workshop-manage" ${busy||modal==='rename'&&!name.trim()?'disabled':''}>${busy?'正在处理…':modal==='rename'?'保存名称':modal==='delete'?'确认移入回收站':modal==='restore'?'恢复项目':'确认彻底删除'}</button></section></div>`;}
 function trashDialog(){
  const batch=trashBatch,done=batch.entries.filter(e=>e.state==='done').length,pending=batch.entries.length-done;
  return `<div class="workshop-shade"><section class="workshop-dialog workshop-confirm" role="dialog" aria-modal="true" aria-label="清空回收站"><header><h3>清空回收站？</h3><button class="text-button" data-action="workshop-cancel" ${busy?'disabled':''}>${batch.attempted?'完成':'取消'}</button></header><p>将彻底删除回收站中 ${batch.entries.length} 个项目的源码、历史版本、修改记录和开发缓存，释放空间，无法恢复。此操作包含搜索结果之外的项目；应用业务数据保留。</p>${busy?`<p role="status">正在清理 · 已完成 ${done} / ${batch.entries.length}</p>`:batch.attempted?`<p role="status">已删除 ${done} 个 · 保留 ${pending+batch.skipped.length} 个</p>`:''}<ul class="workshop-trash-results">${batch.entries.map(e=>`<li><strong>${esc(e.name)}</strong><span>${e.state==='done'?'已删除':e.state==='running'?'正在清理…':e.error?esc(e.error):'待删除'}</span></li>`).join('')}${batch.skipped.map(e=>`<li><strong>${esc(e.name)}</strong><span>保留：${esc(e.reason)}</span></li>`).join('')}</ul>${pending?`<button class="button danger" data-action="workshop-empty-trash-confirm" ${busy?'disabled':''}>${busy?'正在清理…':batch.attempted?'重试未完成项目':'确认清空 '+pending+' 个项目'}</button>`:''}</section></div>`;
 }
 function dialog(){if(modal==='empty-trash')return trashDialog();if(['rename','delete','restore','purge','clean-version'].includes(modal))return managementDialog();return `<div class="workshop-shade"><section class="workshop-dialog" role="dialog" aria-modal="true" aria-label="创建定制副本"><header><h3>创建定制副本</h3><button class="text-button" data-action="workshop-cancel" ${busy?'disabled':''}>取消</button></header>${error?`<p class="notice error" role="alert">${esc(error)}</p>`:''}${modal==='loading'?'<p role="status">正在检查可编辑来源…</p>':`<label>副本名称<input data-workshop-field="name" maxlength="128" value="${esc(name)}" ${busy?'disabled':''}></label><p>来源：${esc(sources.find(s=>s.id===sourceId)?.name)} · v${esc(sources.find(s=>s.id===sourceId)?.version)}</p><p class="muted">独立应用、独立数据。不会复制原应用的业务记录、账号凭据或资料授权。</p><button class="button primary" data-action="workshop-copy" ${busy||!name.trim()?'disabled':''}>${busy?'正在创建…':'创建副本并开始修改'}</button>`}</section></div>`;}
 return{sync,render,action,copilotContext(){return{stage:academyStage||(mobileDetail&&selection()?'project':'projects'),errorCode:academyError};},invalidateList(){loaded=false;},refresh,mounted:root=>product.mounted(root),field(field,value){if(field==='search'){query=value;changed()}else if(field==='name'){name=value;operation=null;const button=globalThis.document?.querySelector('[data-action=workshop-copy]');if(button)button.disabled=busy||!name.trim();}},productField:(...args)=>product.field(...args)};
};
