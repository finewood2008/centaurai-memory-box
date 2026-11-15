// Trusted host UI. Credentials never enter the editable application iframe.
export function haowenPicker(request, mode) {
  return new Promise((resolve,reject)=>{
    const shade=document.createElement('div');shade.className='shade modal-shade';
    const panel=document.createElement('section');panel.className='picker modal';panel.style.cssText='max-height:85vh;overflow:auto;max-width:720px;width:90vw';shade.append(panel);document.body.append(shade);
    const selected=new Map(),node=(tag,text)=>{const n=document.createElement(tag);if(text)n.textContent=text;return n};
    const button=(label,fn)=>{const b=node('button',label);b.type='button';b.onclick=()=>Promise.resolve(fn()).catch(error);return b};
    const error=e=>{panel.querySelector('[role=alert]')?.remove();const p=node('p','未完成：'+String(e.message||e));p.setAttribute('role','alert');panel.append(p)};
    const done=value=>{shade.remove();resolve(value)};
    async function browse(parent=''){
      panel.replaceChildren(node('h2',mode==='knowledge'?'配置好问知识库':'配置盒子文件空间'),node('p','选择整个空间、目录或单个文件。仅在当前应用和当前运行环境生效；保存应用设置后使用。'));
      const result=await request({action:'catalog',kind:mode,parent});
      if(parent)panel.append(button('返回空间列表',()=>browse('')));
      for(const f of result.items){const kind=mode==='knowledge'?'knowledge':f.scopeKind||f.kind;
        const label=node('label');label.style.cssText='display:flex;gap:12px;align-items:center;margin:12px 0';const box=node('input');box.type='checkbox';const key=kind+':'+f.id;box.checked=selected.has(key);box.onchange=()=>box.checked?selected.set(key,{kind,id:f.id}):selected.delete(key);label.append(box,node('span',f.name));
        if(mode!=='knowledge'&&f.kind==='folder')label.append(button('进入目录',()=>browse(f.id)));panel.append(label);
      }
      panel.append(button('取消',()=>done([])),button('选择资料范围',async()=>done(await request({action:'select',sources:[...selected.values()]}))));
    }
    const fields={wecom:['bot_id','secret'],feishu:['app_id','app_secret','encrypt_key','verification_token'],dingtalk:['client_id','client_secret'],weixin:['bot_uin','token']},names={wecom:'企业微信',feishu:'飞书',dingtalk:'钉钉',weixin:'微信'};
    async function edit(id='',kind='wecom'){
      const detail=id?await request({action:'channel-detail',id}):{name:'',kind,values:{},configured:[]};
      panel.replaceChildren(node('h2','配置'+names[detail.kind]+'通道'),node('p','机器人凭据保存在万象盒端通道服务中。此处保存连接信息后，还需在好问设置中保存允许名单、资料范围与原文件发送权限。'));
      const name=node('input');name.setAttribute('aria-label','通道名称');name.placeholder='通道名称';name.value=detail.name;panel.append(name);
      const inputs={};for(const f of fields[detail.kind]){const label=node('label',f+(detail.configured.includes(f)?'（已配置，留空保持）':'')),input=node('input');input.setAttribute('aria-label',f);input.type=['secret','app_secret','client_secret','encrypt_key','verification_token','token'].includes(f)?'password':'text';input.autocomplete='off';input.value=detail.values[f]||'';label.append(input);label.style.cssText='display:block;margin:16px 0';panel.append(label);inputs[f]=input;}
      panel.append(button('返回',channels),button('保存通道',async()=>{await request({action:'channel-save',id,kind:detail.kind,name:name.value,values:Object.fromEntries(Object.entries(inputs).map(([k,v])=>[k,v.value]))});await channels()}));
    }
    async function channels(){
      const result=await request({action:'channels'});panel.replaceChildren(node('h2','好问 · 标准通道连接'),node('p','连接成功不等于开放使用。每条通道默认拒绝访问；请在好问设置中配置白名单和资料范围后启用。'));
      for(const r of result.items){const row=node('div');row.style.cssText='padding:16px 0;border-bottom:1px solid #ddd';row.append(node('strong',r.name+' · '+names[r.kind]),node('p',r.runtime?.connected?'已连接':r.enabled?'正在连接／连接异常':'已停用'),button('修改连接',()=>edit(r.id)),button(r.enabled?'断开连接':'连接',async()=>{await request({action:'channel-toggle',id:r.id,enabled:!r.enabled});await channels()}));panel.append(row)}
      const select=node('select');select.setAttribute('aria-label','通道类型');for(const k of result.kinds){const option=node('option',names[k]);option.value=k;select.append(option)}panel.append(select,button('添加通道',()=>edit('',select.value)),button('完成',()=>done(true)));
    }
    Promise.resolve(mode==='channels'?channels():browse()).catch(e=>{shade.remove();reject(e)});
  });
}
