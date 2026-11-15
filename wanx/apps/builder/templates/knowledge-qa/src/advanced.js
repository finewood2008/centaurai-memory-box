import {brandMark} from './brand.js';
import {createRepository} from './repository.js';

const labels={draft:'草稿',published:'已发布',retired:'已下线',pending:'待处理',replying:'答复处理中',replied:'已答复',answer:'资料回答',canon:'标准口径',handoff:'待人工处理',resolved:'已解决',unresolved:'未解决',human:'请求人工'};
const errors={RUN_TOO_LARGE:'本次回归结果超过当前存储限制，请缩减测试集或资料片段后重跑。',RECORD_CHANGED:'内容已被其他操作更新，请关闭编辑框并刷新后重试。',ACCEPTANCE_REQUIRED:'请先完成回归试答和逐题人工评分，再开放使用。',SERVICE_NOT_OPEN:'服务尚未开放，或资料和规则变化后需要重新验收。',TESTS_REQUIRED:'请先添加至少一道测试题。',MATERIAL_REQUIRED:'请先发布可用资料。',MODEL_INVALID_OUTPUT:'模型返回格式无效，请检查应用主模型后重试。',FILES_UNAVAILABLE:'当前运行环境尚未提供资料选择，请手动录入资料。',DOCUMENT_INVALID:'请输入标题与正文，正文需小于 180 KB。',CANON_INVALID:'请输入问法与标准答案，答案不超过 16000 字。',CONFIG_INVALID:'请检查名称、角色说明与阈值。',REPLY_INVALID:'该记录不可答复，或答复为空。',TEST_INVALID:'请填写测试题与预期结果。',SCORE_INVALID:'请为每题填写 0 到 1 的人工评分。',QUESTION_INVALID:'请输入不超过 4000 字的问题。'};
function el(tag,attrs={},...children){const node=document.createElement(tag);for(const[key,value]of Object.entries(attrs)){if(key.startsWith('on'))node.addEventListener(key.slice(2).toLowerCase(),value);else if(key==='class')node.className=value;else if(key==='text')node.textContent=value;else if(value!==undefined&&value!==false)node.setAttribute(key,value===true?'':String(value));}for(const child of children.flat()){if(child!==null&&child!==undefined)node.append(child instanceof Node?child:document.createTextNode(String(child)));}return node;}
const stamp=value=>new Date(value).toISOString().slice(0,16).replace('T',' ')+' UTC';
const parse=value=>{try{return JSON.parse(value)}catch{return []}};

export async function mount(root,api){
  const repo=createRepository(api);let data,tab='overview',notice='',busy=false,selectedTurn='',questionDraft='',candidates=[],candidateType='',accepted=false;
  const nav=[['overview','概览'],['ask','问答与会话'],['documents','资料'],['canons','口径库'],['handoffs','人工处理'],['tests','回归测试'],['settings','设置与记录']];
  async function refresh(){data=await repo.snapshot();accepted=await repo.gate(data);render();}
  async function run(job){if(busy)return;busy=true;root.querySelectorAll('button').forEach(b=>b.disabled=true);try{await job();notice='';if(!root.querySelector('.overlay'))await refresh();}catch(error){notice=errors[error.message]||'操作未完成，请检查应用连接、主模型与输入后重试。';const target=root.querySelector('.notice');if(target){target.textContent=notice;target.hidden=false;}}finally{busy=false;root.querySelectorAll('button').forEach(b=>b.disabled=false);}}
  const button=(text,job,kind='')=>el('button',{type:'button',class:kind,onclick:()=>run(job)},text);
  const badge=status=>el('span',{class:'badge '+status},labels[status]||status);
  const empty=text=>el('div',{class:'empty'},text);
  const heading=(title,description)=>el('div',{class:'page-heading'},el('h2',{},title),el('p',{},description));
  function showDialog(title,fields,save){
    const overlay=el('div',{class:'overlay'}),form=el('form',{class:'dialog','aria-label':title}),inputs={};
    form.append(el('h2',{},title));
    for(const field of fields){const input=field.options?el('select',{name:field.key,'aria-label':field.label},field.options.map(([v,t])=>el('option',{value:v},t))):el(field.multiline?'textarea':'input',{name:field.key,'aria-label':field.label,type:field.type||'text',maxlength:field.max||16000,required:field.required,rows:field.multiline?8:undefined});input.value=field.value??'';inputs[field.key]=input;form.append(el('label',{},field.label,input));}
    const err=el('p',{class:'error','role':'alert'}),actions=el('div',{class:'actions'},el('button',{type:'button',onclick:()=>overlay.remove()},'取消'),el('button',{type:'submit',class:'primary'},'确认保存'));form.append(err,actions);
    form.onsubmit=async event=>{event.preventDefault();if(busy)return;busy=true;actions.querySelectorAll('button').forEach(b=>b.disabled=true);try{await save(Object.fromEntries(Object.entries(inputs).map(([k,v])=>[k,v.value])));overlay.remove();notice='';await refresh();}catch(error){err.textContent=errors[error.message]||'未能保存。内容仍保留，请检查后重试。';}finally{busy=false;root.querySelectorAll('button').forEach(b=>b.disabled=false);}};
    overlay.append(form);root.append(overlay);form.querySelector('input,textarea,select')?.focus();
  }
  function confirm(title,description,save){showDialog(title,[{key:'confirmation',label:description,required:true}],async value=>{if(value.confirmation!=='确认')throw Error('CONFIRM_REQUIRED');await save();});}
  function documentForm(row){showDialog(row?'编辑资料并存为草稿':'录入资料',[{key:'title',label:'资料标题',value:row?.title,required:true,max:160},{key:'body',label:'资料正文',value:row?.body,multiline:true,required:true,max:180000}],v=>repo.saveDocument({...v,sourceId:row?.sourceId},row));}
  function canonForm(row){showDialog(row?'编辑口径并存为草稿':'新增口径草稿',[{key:'question',label:'问法（每行一种；首版使用规范化精确匹配）',value:row?.question,required:true,multiline:true,max:4000},{key:'answer',label:'标准答案（发布后原文使用）',value:row?.answer,required:true,multiline:true},{key:'category',label:'分类',value:row?.category||'通用',max:100}],v=>repo.saveCanon(v,row));}
  function testForm(row){showDialog(row?'编辑测试题':'添加测试题',[{key:'question',label:'问题',value:row?.question,required:true,max:4000},{key:'expected',label:'预期结果',value:row?.expected||'answer',options:[['answer','有依据回答'],['handoff','转人工处理']]},{key:'contains',label:'答案应包含的文字（可留空）',value:row?.contains,max:1000}],v=>repo.saveTest(v,row));}
  function render(){
    root.replaceChildren();const shell=el('div',{class:'knowledge-app'}),sidebar=el('aside',{class:'sidebar'});
    sidebar.append(el('div',{class:'brand'},brandMark(),el('div',{},el('h1',{},data.settings.name),el('p',{},'基于资料与审核口径的知识问答'))));
    const menu=el('nav',{'aria-label':'应用页面'});for(const[id,title]of nav)menu.append(el('button',{class:tab===id?'active':'','aria-current':tab===id?'page':undefined,onclick:()=>{if(busy)return;tab=id;candidates=[];notice='';render();}},title));sidebar.append(menu,el('div',{class:'sidebar-foot'},'资料、记录与模型调用均通过万象受控运行时。'));
    const main=el('main',{class:'workspace'}),top=el('header',{class:'topbar'},el('span',{},'个人应用 / '+(nav.find(n=>n[0]===tab)?.[1]||'')),el('div',{class:'status-line'},el('span',{class:'dot '+(data.settings.enabled&&accepted?'live':'')}),el('span',{role:'status'},data.settings.enabled&&accepted?'已开放网页问答':'试答与配置中'),button('刷新',refresh)));
    main.append(top,el('p',{class:'notice',role:'alert',hidden:!notice},notice));const content=el('div',{class:'content'});main.append(content);shell.append(sidebar,main);root.append(shell);
    ({overview,ask,documents,canons,handoffs,tests,settings}[tab]||overview)(content);
    if(busy)root.querySelectorAll('button').forEach(b=>b.disabled=true);
  }
  function overview(c){
    c.append(heading('把资料变成有依据的回答','先准备资料和口径，再用真实问题检查回答；解决不了的问题留给人工处理。'));
    const stats=[['已发布资料',data.documents.filter(d=>d.status==='published').length],['已发布口径',data.canons.filter(d=>d.status==='published').length],['待人工处理',data.handoffs.filter(d=>d.status==='pending').length],['问答记录',data.turns.length]];
    c.append(el('div',{class:'stats'},stats.map(([label,n])=>el('article',{},el('span',{},label),el('strong',{},n)))));
    const steps=[['说明用途',!!data.settings._id,'settings'],['发布资料或口径',data.documents.some(d=>d.status==='published')||data.canons.some(d=>d.status==='published'),'documents'],['添加并运行测试',data.runs.length>0,'tests'],['人工评分验收',accepted,'tests']];
    c.append(el('section',{class:'card'},el('h3',{},'初始化进度'),el('div',{class:'checklist'},steps.map(([name,done,target],i)=>el('button',{onclick:()=>{tab=target;render();}},el('span',{class:'step '+(done?'done':'')},done?'✓':i+1),el('span',{},name),el('small',{},done?'已准备':'去完成 →')))),el('div',{class:'actions'},button(data.settings.enabled?'暂停正式问答':'开放网页问答',()=>repo.open(!data.settings.enabled),'primary'),el('span',{class:'muted'},'开放前需通过试答与人工评分。'))));
    c.append(el('div',{class:'columns'},el('section',{class:'card'},el('h3',{},'开始试答'),el('p',{},'使用当前已发布的资料与口径，检查回答、引用和人工处理。'),button('进入问答',async()=>{tab='ask';})),el('section',{class:'card subtle'},el('h3',{},'当前接入范围'),el('p',{},'本版支持网页问答、文本资料、口径审核、人工处理记录和回归测试。'),el('p',{class:'muted'},'高级业务流程使用本应用已发布的资料与口径。普通对话可按需使用星图知识库；企业微信尚未接通，人工答复仅保存在本应用中。'))));
  }
  function ask(c){
    c.append(heading('问答与会话','只使用已发布资料。引用不合格、没有依据或模型不可用时记录为待人工处理。'));
    const form=el('form',{class:'card ask-form'}),textarea=el('textarea',{'aria-label':'输入问题',placeholder:'例如：如何申请培训证明？',rows:3,maxlength:4000,required:true});textarea.value=questionDraft;textarea.oninput=()=>questionDraft=textarea.value;
    const trial=el('input',{type:'checkbox','aria-label':'试答模式',checked:true});
    form.append(textarea,el('div',{class:'actions'},el('label',{class:'inline'},trial,'试答模式（不要求开放服务）'),el('button',{type:'submit',class:'primary'},'发送问题')));
    form.onsubmit=event=>{event.preventDefault();void run(async()=>{const turn=await repo.ask(textarea.value,trial.checked);selectedTurn=turn._id;questionDraft='';});};c.append(form);
    const selected=data.turns.find(t=>t._id===selectedTurn)||data.turns[0];
    if(selected){const card=el('section',{class:'card answer'},badge(selected.kind),el('h3',{},selected.question),el('p',{class:'answer-text'},selected.answer));
      const evidence=parse(selected.evidence);if(evidence.length){card.append(el('h4',{},'引用资料'));for(const e of evidence)card.append(el('details',{class:'evidence'},el('summary',{},'['+e.id+'] '+e.title+' · 片段 '+e.fragment),el('p',{},e.text),el('small',{},'资料摘要 '+e.digest.slice(0,12))));}
      if(selected.canonId)card.append(el('p',{class:'muted'},'按已发布口径原文回答。'));
      if(selected.ticketId){const ticket=data.handoffs.find(t=>t._id===selected.ticketId);card.append(el('p',{class:'muted'},'人工处理单：'+selected.ticketId));if(ticket?.status==='replied')card.append(el('div',{class:'human-answer'},el('h4',{},'人工答复'),el('p',{},ticket.answer)));}
      card.append(el('div',{class:'actions'},selected.feedback?badge(selected.feedback):['resolved','unresolved','human'].map(v=>button(labels[v],()=>repo.feedback(selected,v)))));c.append(card);
    }
    const history=el('section',{class:'card'},el('h3',{},'会话记录'));if(!data.turns.length)history.append(empty('还没有问答记录，从第一个问题开始。'));
    for(const turn of data.turns)history.append(el('button',{class:'history-row',onclick:()=>{selectedTurn=turn._id;render();}},el('span',{},turn.question),el('span',{class:'muted'},labels[turn.kind]+' · '+stamp(turn.created))));c.append(history);
  }
  function documents(c){
    c.append(heading('资料','通过万象选择文本资料，或手动录入。导入内容先成为草稿，确认发布后才能用于回答。'),el('div',{class:'toolbar'},button('选择空间资料',repo.importFiles,'primary'),button('手动录入',async()=>documentForm()),el('span',{class:'muted'},'支持当前工坊允许的 txt / md / csv / json 文本；每份正文小于 180 KB。')));
    if(!data.documents.length)c.append(empty('尚未添加资料。选择资料或手动录入，审核发布后即可用于问答。'));
    for(const row of data.documents){const card=el('article',{class:'card'},el('div',{class:'row'},el('h3',{},row.title),badge(row.status)),el('p',{class:'excerpt'},row.body.slice(0,220)),el('p',{class:'muted'},(row.sourceId?'来自用户选择的空间文件':'手动录入')+' · '+stamp(row.updated)),el('div',{class:'actions'},button('查看与编辑',async()=>documentForm(row)),button(row.status==='published'?'下线':'确认发布',async()=>confirm(row.status==='published'?'下线资料':'发布资料','输入“确认”继续；发布范围仅为当前个人应用。',()=>repo.documentStatus(row,row.status==='published'?'retired':'published'))),button('删除',async()=>confirm('删除资料','输入“确认”删除这份应用资料。不会删除空间原文件。',()=>repo.remove('documents',row)),'danger')));c.append(card);}
  }
  async function suggestions(type){candidateType=type;candidates=await repo.suggest(type);}
  function candidateCards(c){if(!candidates.length)return;c.append(el('h3',{},'AI 候选内容 · 请检查后保存'));candidates.forEach((row,index)=>{const card=el('article',{class:'card'},el('h4',{},row.question||'候选问题'),el('p',{},row.answer||('预期：'+row.expected)),button(candidateType==='canons'?'保存为待审核草稿':'加入测试集',async()=>{if(candidateType==='canons')await repo.saveCanon(row,null,'ai_draft');else await repo.saveTest(row);candidates=candidates.filter((_,i)=>i!==index);}));c.append(card);});}
  function canons(c){
    c.append(heading('口径库','发布的口径优先按原文回答。AI 起草和人工答复都从草稿开始，发布需要人工确认。'),el('div',{class:'toolbar'},button('新增口径',async()=>canonForm(),'primary'),button('AI 起草候选',()=>suggestions('canons'))));candidateCards(c);
    const search=el('input',{type:'search',placeholder:'搜索问题、答案或分类','aria-label':'搜索口径'}),list=el('div');c.append(search,list);
    function show(){list.replaceChildren();const shown=data.canons.filter(r=>(r.question+r.answer+r.category).includes(search.value));if(!shown.length)list.append(empty('没有匹配的口径。'));
      for(const row of shown)list.append(el('article',{class:'card'},el('div',{class:'row'},el('h3',{},row.question),badge(row.status)),el('p',{class:'answer-text'},row.answer),el('p',{class:'muted'},row.category+' · 版本 '+row.version+' · '+({manual:'手工录入',human_reply:'人工答复',ai_draft:'AI 草稿'}[row.source]||row.source)),el('div',{class:'actions'},button('编辑',async()=>canonForm(row)),button(row.status==='published'?'下线':'审核发布',async()=>confirm(row.status==='published'?'下线口径':'审核并发布口径','已检查答案与适用范围？输入“确认”继续。',()=>repo.reviewCanon(row,row.status==='published'?'retired':'published'))),button('历史版本',async()=>showJSON('口径历史',data.canon_history.filter(h=>h.canonId===row._id))))));}
    search.oninput=show;show();
  }
  function handoffs(c){
    c.append(heading('人工处理','此版本将人工请求与答复保存在应用中，不包含企业微信通知或主动推送。'));
    if(!data.handoffs.length)c.append(empty('没有人工处理记录。'));
    for(const row of data.handoffs){const card=el('article',{class:'card'},el('div',{class:'row'},el('h3',{},row.question),badge(row.status)),el('p',{class:'muted'},row.reason+' · '+stamp(row.created)),el('p',{class:'muted'},'处理单号 '+row._id));if(row.answer)card.append(el('p',{class:'answer-text'},row.answer));
      if(row.status==='pending')card.append(button('填写人工答复',async()=>showDialog('人工答复',[{key:'answer',label:'答复（保存后自动进入口径待审核）',multiline:true,required:true}],v=>repo.reply(row,v.answer)),'primary'));
      if(row.status==='replied')card.append(el('p',{class:'muted'},'答复已保存，关联口径仍需单独审核发布。'));if(row.status==='replying')card.append(el('p',{class:'error'},'答复处理尚未完成，可继续保存已有答复。'),button('恢复答复处理',()=>repo.reply(row,row.answer)));c.append(card);}
  }
  function tests(c){
    c.append(heading('回归测试','同一组问题反复试答，并由人逐题评分。测试不会新增会话或人工处理单。'),el('div',{class:'toolbar'},button('添加测试题',async()=>testForm(),'primary'),button('AI 生成候选题',()=>suggestions('tests')),button('运行回归',repo.runTests)));candidateCards(c);
    const questions=el('section',{class:'card'},el('h3',{},'测试集 · '+data.tests.length+' 题'));if(!data.tests.length)questions.append(empty('添加有依据和无依据的问题，检查两种结果。'));
    for(const row of data.tests)questions.append(el('div',{class:'test-row'},el('div',{},el('strong',{},row.question),el('p',{class:'muted'},(row.expected==='handoff'?'应转人工':'应回答')+(row.contains?' · 应含：'+row.contains:''))),el('div',{class:'actions'},button('编辑',async()=>testForm(row)),button('删除',async()=>confirm('删除测试题','输入“确认”删除此题。',()=>repo.remove('tests',row))))));c.append(questions);
    for(const row of data.runs){const results=parse(row.results),previous=data.runs.find(r=>r._id===row.previousId),old=parse(previous?.results||'[]'),card=el('section',{class:'card'},el('div',{class:'row'},el('h3',{},stamp(row.created)),el('span',{class:'badge'},row.reviewed?'已评分':'待人工评分')));const inputs=[];
      for(const result of results){const prior=old.find(x=>x.id===result.id);const score=el('input',{type:'number',min:0,max:1,step:0.1,'aria-label':result.question+' 人工评分',placeholder:'0—1'});score.value=result.humanScore??'';inputs.push({id:result.id,score});card.append(el('div',{class:'result-row'},el('div',{},el('strong',{},result.question),el('p',{class:'muted'},(result.passed?'预期检查通过':'预期检查未通过')+(prior?' · 上次：'+(prior.passed?'通过':'未通过'):'')),el('p',{class:'answer-text'},result.answer),el('details',{},el('summary',{},'检查检索依据'),el('pre',{},JSON.stringify(result.evidence,null,2)))),el('label',{},'人工评分',score)));}
      card.append(button('确认并保存逐题评分',async()=>{const values=results.map((r,i)=>({...r,humanScore:inputs[i].score.value.trim()===''?NaN:Number(inputs[i].score.value)}));await repo.reviewRun(row,values);},'primary'));c.append(card);}
  }
  function showJSON(title,value){const overlay=el('div',{class:'overlay'}),area=el('textarea',{readonly:true,rows:18,'aria-label':title});area.value=JSON.stringify(value,null,2);const box=el('section',{class:'dialog'},el('h2',{},title),el('p',{class:'muted'},'内容仅包含当前应用的数据，可选择文字手动复制。'),area,el('button',{onclick:()=>overlay.remove()},'关闭'));overlay.append(box);root.append(overlay);}
  function settings(c){
    c.append(heading('设置与记录','配置版本可恢复；恢复配置不会删除或恢复业务记录。应用主模型请在万象工坊详情中选择。'));
    const form=el('form',{class:'card'}),inputs={};for(const[key,label,multi]of [['name','应用名称'],['persona','角色说明',true],['handoffWords','转人工关键词（逗号或换行分隔）',true],['handoffMessage','转人工提示语',true],['threshold','资料检索阈值（0.1—1）'],['acceptance','人工评分通过标准（0—1）']]){const input=el(multi?'textarea':'input',{'aria-label':label,name:key,rows:3,type:['threshold','acceptance'].includes(key)?'number':'text',step:0.05,maxlength:4000,required:true});input.value=data.settings[key];inputs[key]=input;form.append(el('label',{},label,input));}
    form.append(el('button',{class:'primary',type:'submit'},'保存为新版本'));form.onsubmit=event=>{event.preventDefault();void run(()=>repo.saveSettings({...Object.fromEntries(Object.entries(inputs).map(([k,i])=>[k,i.value])),threshold:Number(inputs.threshold.value),acceptance:Number(inputs.acceptance.value)}));};c.append(form,el('p',{class:'muted'},'本应用使用当前万象个人账号的授权；不提供独立登录、成员角色或多人权限管理。阈值是应用检索规则，不是效果保证。'));
    const versions=el('section',{class:'card'},el('h3',{},'配置历史'));for(const row of data.config_versions.slice().sort((a,b)=>b.created-a.created)){const value=parse(row.snapshot);versions.append(el('div',{class:'history-row'},el('span',{},'v'+value.revision+' · '+row.note+' · '+stamp(row.created)),button('查看',async()=>showJSON('配置版本',value)),button('恢复为新版本',async()=>confirm('恢复配置','输入“确认”将该配置保存为新版本，并暂停正式问答。',()=>repo.saveSettings(value,'恢复自 v'+value.revision)))));}c.append(versions);
    c.append(el('section',{class:'card'},el('h3',{},'操作记录'),el('p',{class:'muted'},'使用当前应用数据契约保存的业务操作记录，不宣称为不可篡改的服务端审计。'),button('查看与导出当前应用记录',async()=>{await repo.audit('export','current-app');showJSON('应用数据导出',await repo.snapshot());}),el('div',{class:'audit-list'},data.audit.slice(0,30).map(row=>el('p',{},stamp(row.created)+' · '+row.action+' · '+row.detail)))));
  }
  await refresh();
}
