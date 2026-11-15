// Navigation stays stable; management data requires a live, verified identity.
window.createTeamFeatureAccess=()=>{
 const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 let account='',device='',principal='',status='disconnected',key='',reason='',revision=0;
 function context(state){
  const next=state.account?.phase==='authenticated'?JSON.stringify([state.account.accountId,state.account.clientId,state.dataIdentity?.profileId]):'';
  if(next!==account){account=next;device='';principal='';revision++}
  const selected=state.activeDeviceId||state.connection?.deviceId||state.recovery?.deviceId;
  const owner=state.dataIdentity?.selected;
  if(selected&&selected!==device){device=selected;principal='';revision++}
  if(owner)principal=JSON.stringify([owner.principalId,owner.bindingId]);
  const value=account?JSON.stringify([account,device,principal]):'';
  if(value!==key){key=value;revision++}
  return key;
 }
 function sync(state,team={}){
  context(state);reason='';let next;
  if(!state.canLaunchApplications){
   next=state.phase==='recovering'||state.recovery?'reconnecting':state.phase==='connecting'?'connecting':state.phase==='unavailable'||state.reason?'failed':'disconnected';
   reason=state.reason||'';
  }else if(team.identity&&team.available!==false)next=team.identity.permissions?.includes('applications.manage')?'ready':'denied';
  else if(/FORBIDDEN|DENIED|EXPIRED|ADMIN_REQUIRED|LOGIN_REQUIRED|DISABLED|REVOKED/.test(team.identityError||''))next='denied';
  else next=team.identityError?'verification-failed':'verifying';
  if(status!==next){status=next;revision++}
  return snapshot();
 }
 function snapshot(){return{key,deviceId:device,status,allowed:status==='ready',revision}}
 function stamp(){const r=revision,k=key;if(status!=='ready')throw Error('TEAM_ADMIN_ACCESS_UNAVAILABLE');return()=>{if(status!=='ready'||revision!==r||key!==k)throw Error('STUDIO_CONTEXT_CHANGED')}}
 function render(page){
  const kaiwu=page==='construction',busy=['connecting','reconnecting','verifying'].includes(status);
  const title={disconnected:'连接盒子后开始使用',connecting:'正在连接盒子…',reconnecting:'正在重新连接盒子…',failed:'暂时无法连接盒子',verifying:'正在核验管理员权限…','verification-failed':'暂时无法核验权限',denied:'此功能仅管理员可用'}[status]||'';
  const copy=status==='denied'?'当前账号没有此板块的管理权限。如需使用，请联系团队管理员。':busy?'当前页面与未提交输入已保留，连接和权限确认后继续。':status==='verification-failed'?'请重试身份核验；确认权限前不会读取项目或数据仓。':status==='failed'?'请检查盒子是否在线，恢复连接后可以继续。':'连接团队盒子后，使用当前账号核验权限。';
  return `<section class="team-feature-status" aria-label="${kaiwu?'开物':'星图'}连接状态"><header><span class="team-feature-mark">${kaiwu?'<img src="./assets/wanx-builder.svg" alt=""/>':'✧'}</span><div><h2>万象·${kaiwu?'开物':'星图'} ${kaiwu?'<span class="feature-beta">Beta</span>':''}<small>${kaiwu?'WanX Builder':'WanX Starlink'}</small></h2><p>${kaiwu?'从想法到应用，持续构建、试用和改进。':'连接团队资料，探索可追溯的知识。'}</p></div></header><div class="team-feature-state" role="${status==='failed'||status==='verification-failed'?'alert':'status'}" aria-busy="${busy}">${busy?'<span class="activity-spinner" aria-hidden="true"></span>':'<span class="team-feature-status-symbol" aria-hidden="true">'+(status==='denied'?'◇':'○')+'</span>'}<h3>${title}</h3><p>${copy}</p>${reason?`<small>连接原因：${esc(reason)}</small>`:''}<div>${!busy&&status!=='denied'?`<button class="button primary" data-action="team-feature-retry">${status==='disconnected'?'连接盒子':'重试'}</button>`:''}<button class="button" data-action="show-boxes">前往盒子</button></div></div></section>`;
 }
 return{context,sync,snapshot,stamp,render};
};
