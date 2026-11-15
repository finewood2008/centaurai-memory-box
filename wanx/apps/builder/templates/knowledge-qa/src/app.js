import {renderServiceSettings} from './settings.js';
import {brandMark} from './brand.js';
import {createConversations,decode} from './conversation.js';
import {mount as mountAdvanced} from './advanced.js';
const errors={HAOWEN_MODEL_CONSENT_REQUIRED:'请先在设置中确认所选模型可处理本轮相关资料片段。',HAOWEN_CONFIG_CHANGED:'配置刚刚变化，请刷新后重试。',HAOWEN_AUDIENCE_REQUIRED:'启用通道前，请填写允许使用的人员或群。',HAOWEN_CHANNEL_PRODUCTION_ONLY:'通道连接仅在正式安装的应用中配置；工坊预览保持独立。',HAOWEN_CHANNEL_DELEGATION_REQUIRED:'当前盒子的授权模式尚未开放常驻通道授权，应用内问答可以继续使用。',SOURCE_LIMIT:'每个会话最多使用 10 个来源，请先移除部分来源。',QUESTION_INVALID:'请输入 1—4000 字的问题。',MODEL_INVALID_OUTPUT:'回答格式未完成，请重试。',RECORD_CHANGED:'会话已被其他窗口更新，请刷新后重试。',RUNTIME_MODEL_UNAVAILABLE:'当前模型不可用，请重新选择。',CONFIG_INVALID:'请填写应用名称和回答风格。',SERVICE_NOT_OPEN:'业务模式尚未完成配置和验收，请进入高级功能，或切回普通对话。'};
function el(tag,attrs={},...children){const node=document.createElement(tag);for(const[k,v]of Object.entries(attrs)){if(k.startsWith('on'))node.addEventListener(k.slice(2).toLowerCase(),v);else if(k==='class')node.className=v;else if(v!==undefined&&v!==false)node.setAttribute(k,v===true?'':String(v));}for(const c of children.flat())if(c!=null)node.append(c instanceof Node?c:document.createTextNode(String(c)));return node;}
export async function mount(root,api){
  const repo=createConversations(api);let state,currentId='',draft='',busy=false,error='',page='chat',models=null;
  const current=()=>state.conversations.find(c=>c._id===currentId);
  const btn=(label,action,cls='')=>el('button',{type:'button',class:cls,disabled:busy,onclick:()=>void action()},label);
  async function refresh(){state=await repo.load();if(!state.conversations.some(c=>c._id===currentId))currentId=state.conversations[0]?._id||'';render();}
  async function run(job){if(busy)return;busy=true;error='';render();try{await job();}catch(e){error=errors[e.message]||(/SEMANTICA|KNOWLEDGE/.test(e.message)?'星图暂不可用，请检查星图服务和当前账号的知识库授权后重试。':'操作未完成，请检查万象连接、资料权限与模型后重试。');}finally{busy=false;await refresh();}}
  async function ensure(){if(!currentId){const row=await repo.create();currentId=row._id;state=await repo.load();}return current();}
  async function newChat(){await run(async()=>{const row=await repo.create();currentId=row._id;draft='';page='chat';});}
  async function send(retry){const question=retry?state.messages.filter(m=>m.conversationId===currentId&&m.role==='user'&&m.created<retry.created).at(-1)?.content:draft;if(!question?.trim())return;await run(async()=>{const row=await ensure();draft='';await repo.send(row,question,retry,async()=>{state=await repo.load();render();});});}
  async function sources(kind){await run(async()=>{const row=await ensure();const selected=kind==='file'?await api.files.select():await api.knowledge.select();if(!selected.length)return;const previous=decode(row.sources);const combined=[...previous,...selected.map(s=>({id:s.id,name:s.name,kind}))];const unique=combined.filter((s,i)=>combined.findIndex(v=>v.id===s.id&&v.kind===s.kind)===i);if(unique.length>10)throw Error('SOURCE_LIMIT');await repo.update(row,{sources:JSON.stringify(unique)});});}
  function modal(title,body){const shade=el('div',{class:'overlay'}),box=el('section',{class:'dialog','aria-label':title},el('h2',{},title),body,el('div',{class:'actions'},el('button',{onclick:()=>shade.remove()},'关闭')));shade.append(box);root.append(shade);}
  async function modelPicker(){await run(async()=>{models=await api.model.list();});if(!models)return;const select=el('select',{'aria-label':'默认模型'},el('option',{value:''},'跟随万象默认模型'),models.models.map(m=>el('option',{value:m.id},m.provider+' · '+m.name)));select.value=models.modelId||'';const box=el('div',{},el('p',{class:'muted'},'与工坊的应用主模型共用配置；选择在下一轮生效。'),select,el('button',{class:'primary',onclick:async()=>{try{models=await api.model.select({modelId:select.value||null,expectedRevision:models.revision,operationId:crypto.randomUUID()});root.querySelector('.overlay')?.remove();render();}catch{box.append(el('p',{class:'error'},'模型选择未保存，请关闭并重新选择。'));}}},'保存选择'));modal('应用主模型',box);}
  function copy(text){const input=el('textarea',{'aria-label':'复制回答',readonly:true},text);root.append(input);input.select();const copied=document.execCommand('copy');input.remove();if(!copied)modal('复制回答',el('textarea',{readonly:true,rows:10},text));}
  function settings(container){
    if(state.service){renderServiceSettings(container,{el,btn,api,config:state.service,run,modelPicker});container.append(el('div',{class:'card subtle'},el('h3',{},'高级功能'),el('p',{},'口径、人工处理与回归测试，仅在业务问答模式中生效。'),btn('打开高级功能',()=>{page='advanced';render();})));return;}

    container.append(el('div',{class:'page-heading'},el('h2',{},'设置'),el('p',{},'保留简单的默认行为，按需调整。')));
    const name=el('input',{'aria-label':'应用名称',maxlength:80,required:true}),style=el('textarea',{'aria-label':'回答风格',rows:4,maxlength:2000,required:true});name.value=state.preferences.name;style.value=state.preferences.instructions;
    const form=el('form',{class:'card'},el('label',{},'应用名称',name),el('label',{},'回答风格',style),el('button',{type:'submit',class:'primary',disabled:busy},'保存设置'));form.onsubmit=e=>{e.preventDefault();void run(()=>repo.savePreferences(state.preferences,{name:name.value,instructions:style.value}));};container.append(form,el('div',{class:'card'},el('h3',{},'万象能力'),el('p',{},'模型、空间资料与星图知识库均通过万象连接使用；不需要在应用里填写 Key。'),btn('选择默认模型',modelPicker)),el('div',{class:'card subtle'},el('h3',{},'高级功能'),el('p',{},'保留口径、资料审核、人工处理和回归测试。普通对话不会自动启用这些规则。'),btn('打开高级功能',()=>{if(busy)return;page='advanced';render();})));
  }
  function chat(container){
    const row=current(),messages=state.messages.filter(m=>m.conversationId===currentId);
    const transcript=el('div',{class:'transcript','aria-label':'对话消息'});
    if(!messages.length)transcript.append(el('section',{class:'welcome'},el('span',{class:'welcome-mark'},'知'),el('h2',{},'从一个问题开始'),el('p',{},'直接提问，或在设置中连接盒子里的知识库、文件空间与通道。'),el('div',{class:'suggestions'},['帮我理清一个问题的思路','根据资料整理关键要点','和我一起探索业务应用'].map(q=>btn(q,()=>{draft=q;render();})))));
    for(const m of messages){const card=el('article',{class:'message '+m.role},el('small',{},m.role==='user'?'你':'好问'));if(m.role==='user')card.append(el('p',{class:'answer-text'},m.content));else{
      if(m.status==='running')card.append(el('p',{role:'status'},busy?'正在思考…':'上次回答未完成。'));
      if(m.content)card.append(el('div',{class:'grounded'},el('small',{},row?.business?'业务回答':'资料依据'),el('p',{class:'answer-text'},m.content)));
      if(m.supplement)card.append(el('div',{},el('small',{},decode(m.sourceScope).length?'通用知识补充':'回答'),el('p',{class:'answer-text'},m.supplement)));
      for(const n of decode(m.notes))card.append(el('p',{class:'muted'},n));
      for(const e of decode(m.evidence)){
        const item=el('details',{class:'evidence'},el('summary',{},'['+e.id+'] '+e.title));
        // External excerpts are displayed only after a live source permission check.
        // Cached evidence stays in the historical record, never in the rendered DOM.
        if(!e.kind)item.append(el('p',{},e.text));
        else if(state.service?state.service.sources.length>0:decode(row?.sources).some(s=>s.kind===e.kind&&s.id===(e.sourceId||e.warehouseId)))item.append(btn('查看当前来源',async()=>{try{modal(e.title,el('pre',{},await repo.evidence(e,current())));}catch{modal('来源暂不可用',el('p',{},'该来源可能已被移除或撤权，请重新选择后查看。'));}}));
        else item.append(el('p',{class:'muted'},'此来源已从本会话移除，引用原文不再展示。'));
        card.append(item);
      }
      if(m.status==='complete')card.append(btn('复制回答',()=>copy([m.content,m.supplement].filter(Boolean).join('\n\n')),'text-button'));
      if(['failed','running'].includes(m.status)&&!busy)card.append(btn('重试回答',()=>send(m)));
    }transcript.append(card);}
    const composer=el('form',{class:'composer'}),input=el('textarea',{'aria-label':'输入问题',placeholder:'问点什么，或结合资料继续聊…',rows:3,maxlength:4000,disabled:busy});input.value=draft;input.oninput=()=>draft=input.value;input.onkeydown=e=>{if((e.metaKey||e.ctrlKey)&&e.key==='Enter'){e.preventDefault();void send();}};
    const chips=el('div',{class:'source-chips'});
    if(state.service){for(const s of state.service.sources)chips.append(el('span',{class:'source-chip'},(s.kind==='knowledge'?'◈ ':'▤ ')+s.name));}
    else for(const s of decode(row?.sources))chips.append(btn((s.kind==='file'?'▤ ':'◈ ')+s.name+' ×',()=>run(()=>repo.update(current(),{sources:JSON.stringify(decode(current().sources).filter(v=>!(v.kind===s.kind&&v.id===s.id)))}))));
    const mode=btn(row?.business?'业务问答 · 退出':'业务问答模式',()=>run(async()=>{const c=await ensure();await repo.update(c,{business:!c.business});}),'text-button');
    composer.append(chips,input,el('div',{class:'composer-tools'},el('div',{},...(state.service?[btn('配置模型与资料',()=>{page='settings';render();})]:[btn('＋ 空间资料',()=>sources('file')),btn('◈ 星图知识库',()=>sources('knowledge')),btn(models?.selected?.name||'模型',modelPicker)])),el('button',{type:'submit',class:'primary',disabled:busy},busy?'生成中…':'发送 ↑')),el('details',{class:'conversation-options'},el('summary',{},row?.business?'高级 · 业务问答已启用':'高级选项'),el('p',{class:'muted'},'业务模式会应用高级功能中的口径、人工处理与验收规则。'),mode));composer.onsubmit=e=>{e.preventDefault();void send();};container.append(transcript,composer,el('p',{class:'chat-footnote'},'AI 回答请结合实际核对。资料引用与通用补充分开展示。'));transcript.scrollTop=transcript.scrollHeight;
  }
  function render(){
    root.replaceChildren();
    if(page==='advanced'){const returnBar=el('header',{class:'advanced-return'},btn('← 返回智能问答',()=>{page='chat';void refresh();}),el('span',{},'高级功能 · 仅在业务问答模式中应用规则')),body=el('div');root.append(returnBar,body);void mountAdvanced(body,api);return;}
    const sidebar=el('aside',{class:'chat-sidebar'},el('div',{class:'chat-brand'},brandMark(),el('h1',{},state.preferences.name)),btn('＋ 新对话',newChat,'new-chat'));
    const history=el('nav',{'aria-label':'会话历史'});for(const c of state.conversations)history.append(btn(c.title,()=>{if(busy)return;currentId=c._id;draft='';page='chat';render();},c._id===currentId&&page==='chat'?'active':''));sidebar.append(history,el('div',{class:'chat-sidebar-bottom'},btn('设置与通道',()=>{if(busy)return;page=page==='settings'?'chat':'settings';render();}),el('small',{},'万象工坊 · 可继续定制')));
    const content=el('div',{class:page==='chat'?'chat-content':'content settings-content'}),main=el('main',{class:'chat-main'},el('header',{class:'chat-topbar'},el('span',{},page==='settings'?'应用设置':current()?.title||'新对话'),btn('刷新',()=>run(async()=>{}),'text-button')));if(error)main.append(el('p',{class:'notice',role:'alert'},error));main.append(content);root.append(el('div',{class:'chat-app'},sidebar,main));if(page==='settings')settings(content);else chat(content);
  }
  await refresh();
}
