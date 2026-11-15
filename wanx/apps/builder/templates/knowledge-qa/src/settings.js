export function renderServiceSettings(container,{el,btn,api,config,run,modelPicker}){
  let selected=[...config.sources];
  const name=el('input',{'aria-label':'应用名称',maxlength:80}),style=el('textarea',{'aria-label':'回答风格',rows:3,maxlength:2000}),consent=el('input',{type:'checkbox','aria-label':'允许模型处理资料片段'});
  name.value=config.name;style.value=config.style;consent.checked=config.cloudAllowed;
  const sourceList=el('div',{class:'configured-sources'}),notice=el('p',{class:'muted',role:'status'});
  function list(){sourceList.replaceChildren();for(const s of selected)sourceList.append(el('div',{class:'configured-source'},el('span',{},(s.kind==='knowledge'?'知识库 · ':'文件空间 · ')+s.name),btn('移除',()=>{selected=selected.filter(x=>!(x.kind===s.kind&&x.id===s.id));list();},'text-button')));if(!selected.length)sourceList.append(el('p',{class:'muted'},'尚未配置资料范围，可以先使用通用问答。'));}
  async function choose(kind){try{const added=await api.haowen.select(kind);for(const s of added)if(!selected.some(x=>x.id===s.id&&x.kind===s.kind))selected.push(s);list();notice.textContent='资料范围尚未保存，请点击“保存应用配置”。';}catch{notice.textContent='选择未完成，请检查当前盒子和资料权限。';}}
  const form=el('form',{class:'card'},el('h3',{},'应用配置'),el('label',{},'名称',name),el('label',{},'回答风格',style),el('h3',{},'模型'),el('p',{},'默认跟随万象模型，也可为好问指定模型。'),btn('选择应用模型',modelPicker),el('label',{class:'consent-row'},consent,'允许将本轮相关资料片段交给所选模型处理'),el('p',{class:'muted'},config.disclosure),el('h3',{},'盒子里的知识与文件'),el('p',{},'配置应用可使用的范围；每条 Channel 再选择允许访问的部分。文件空间可选择整个空间、目录或单个文件。'),sourceList,el('div',{class:'actions'},btn('选择星图知识库',()=>choose('knowledge')),btn('选择文件空间',()=>choose('space'))),notice,el('button',{type:'submit',class:'primary'},'保存应用配置'));
  form.onsubmit=e=>{e.preventDefault();void run(()=>api.haowen.invoke('save',{revision:config.revision,name:name.value,style:style.value,cloudAllowed:consent.checked,sources:selected.map(({kind,id})=>({kind,id}))}));};list();
  container.append(el('div',{class:'page-heading'},el('h2',{},'好问设置'),el('p',{},'配置一次，在应用与通道中使用盒子里的知识。')),form);
  const channels=el('section',{class:'card'},el('h3',{},'Channel · 服务通道'),el('p',{},'企业微信、飞书、钉钉和微信复用万象标准通道。盒端服务运行时，关闭应用窗口仍可提供问答；盒子离线后停止服务。'),el('p',{class:'muted'},'连接机器人后，向它发送 /身份 获取人员或群的通道 ID，填入允许名单后启用服务。群内成员共享本群对话，不同群与私聊互不混入上下文。'));
  if(config.environment!=='production')channels.append(el('p',{class:'notice'},'工坊预览与正式应用隔离。请安装后在正式应用中连接通道。'));
  else if(!config.channelAvailable)channels.append(el('p',{class:'notice'},'当前盒子的授权模式尚未提供常驻通道委托；应用内问答可继续使用。'));
  else channels.append(btn('配置标准通道连接',()=>run(()=>api.haowen.channels()),'primary'));
  if(!config.channels.length)channels.append(el('p',{class:'muted'},'尚未配置通道。新连接默认不开放资料访问。'));
  for(const c of config.channels){
    const people=el('textarea',{'aria-label':c.name+'允许人员',rows:2,placeholder:'每行一个平台人员 ID'}),groups=el('textarea',{'aria-label':c.name+'允许群',rows:2,placeholder:'每行一个平台群 ID'}),enabled=el('input',{type:'checkbox','aria-label':c.name+'启用服务'}),files=el('input',{type:'checkbox','aria-label':c.name+'允许发送原文件'});
    people.value=(c.subjects||[]).join('\n');groups.value=(c.groups||[]).join('\n');enabled.checked=c.enabled;files.checked=c.allowFiles;
    const allowed=new Set((c.sources||[]).map(s=>s.kind+':'+s.id)),checks=config.sources.map(s=>{const box=el('input',{type:'checkbox'});box.checked=allowed.has(s.kind+':'+s.id);return{s,box,row:el('label',{class:'consent-row'},box,s.name)}}),split=value=>[...new Set(value.split(/[\n,，]+/).map(x=>x.trim()).filter(Boolean))];
    const policy=el('form',{class:'channel-policy'},el('h4',{},c.name+' · '+c.kind),el('p',{class:'muted'},c.connected?'连接已就绪':c.transportEnabled?'连接中或连接异常':'连接已断开'),el('label',{class:'consent-row'},enabled,'启用此通道的好问服务'),el('label',{},'允许使用的人员',people),el('label',{},'允许使用的群',groups),el('p',{},'本通道可访问的资料'),...checks.map(x=>x.row),el('label',{class:'consent-row'},files,'允许按请求发送原文件'),el('p',{class:'muted'},'发送 /文件 查看获授权的文件，发送 /文件 名称或编号 获取原件。首版上限20MB，具体交付受平台能力限制。'),el('button',{type:'submit',class:'primary'},'保存通道权限'));
    policy.onsubmit=e=>{e.preventDefault();void run(()=>api.haowen.invoke('channels.policy',{revision:config.revision,id:c.id,enabled:enabled.checked,subjects:split(people.value),groups:split(groups.value),allowFiles:files.checked,sources:checks.filter(x=>x.box.checked).map(x=>({kind:x.s.kind,id:x.s.id}))}));};channels.append(policy);
  }
  container.append(channels);
}
