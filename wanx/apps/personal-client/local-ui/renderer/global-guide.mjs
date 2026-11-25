import {concepts,pages,guideScreenTargets,configurationLink,guidePageFacts,isGuideBackgroundClick,linkLabel} from '../starlink/shared/application-guide.mjs';
import {explicitGuideLookup,guideIntent} from './global-guide-intent.mjs';

const host=document.getElementById('academy-dialogue-host');
host.append(document.getElementById('memo-guide-template').content.cloneNode(true));
const root=host.querySelector('#memo-guide-panel'), log=root.querySelector('[role=log]'), input=root.querySelector('textarea');
const send=root.querySelector('[type=submit]'), heading=root.querySelector('[data-context]');
const connection=root.querySelector('[data-guide-connection]');
const composer=root.querySelector('form');
const suggestions=root.querySelector('.guide-page-questions');
const suggestionsToggle=root.querySelector('.guide-suggestions-toggle');
let lastMatches=null;
let boxReady=false, draftOwner='', draftBox=null;
let scope='', epoch=0, opening=0, request=0, pending=false, termContext=null, history=[];
function syncSendButton() {
  send.disabled = pending || !boxReady || !scope || !input.value.trim();
}

input.addEventListener('input', syncSendButton);
const shell=()=>window.memoGuideShell;
const project=()=>shell()?.project()?.project || null;
const current=(ticket,projectId)=>ticket===epoch && boxReady && !!scope && (projectId===undefined || project()===projectId);
function bubble(text,role='assistant') {
  const row=document.createElement('article');row.className='guide-'+role;
  if(role==='assistant'){
    const author=document.createElement('header'), logo=document.createElement('img');
    logo.src='./assets/centaurai-mark.png';logo.width=18;logo.height=18;logo.alt='';
    author.append(logo,'CentaurAI');row.append(author);
  }
  const body=document.createElement('p');body.textContent=text;row.append(body);log.append(row);log.scrollTop=log.scrollHeight;return row;
}
const sentenceSegmenter = new Intl.Segmenter('zh', {granularity:'sentence'});
function answerParagraphs(line) {
  // Older replies can arrive as one block of plain prose.
  if (line.length <= 140) return [line];
  const paragraphs = [];
  let chunk = '';
  for (const {segment} of sentenceSegmenter.segment(line)) {
    const canBreak = (chunk.match(/\*\*/g)?.length || 0) % 2 === 0;
    if (chunk && canBreak && (chunk.length + segment.length > 120 || (!paragraphs.length && chunk.length >= 38))) {
      paragraphs.push(chunk.trim());
      chunk = '';
    }
    chunk += segment;
  }
  if (chunk.trim()) paragraphs.push(chunk.trim());
  return paragraphs;
}

function appendAnswerText(parent, text) {
  let offset = 0;
  for (const match of text.matchAll(/\*\*([^*]+)\*\*/g)) {
    parent.append(text.slice(offset, match.index));
    const emphasis = document.createElement('strong');
    emphasis.textContent = match[1];
    parent.append(emphasis);
    offset = match.index + match[0].length;
  }
  parent.append(text.slice(offset));
}

function renderAnswer(row, answer) {
  const body = document.createElement('div');
  body.className = 'guide-answer';
  let list = null;
  for (const raw of answer.split('\n')) {
    const line = raw.trim();
    const item = /^(?:(\d+)[.)]|[-*+])\s+(.+)$/.exec(line);
    if (item) {
      const tag = item[1] ? 'ol' : 'ul';
      if (list?.localName !== tag) {
        list = document.createElement(tag);
        if (item[1]) list.start = Number(item[1]);
        body.append(list);
      }
      const entry = document.createElement('li');
      appendAnswerText(entry, item[2]);
      list.append(entry);
      continue;
    }
    list = null;
    if (!line) continue;
    const heading = /^#{1,6}\s+(.+)$/.exec(line);
    for (const text of heading ? [heading[1]] : answerParagraphs(line)) {
      const block = document.createElement(heading ? 'h4' : 'p');
      appendAnswerText(block, text);
      body.append(block);
    }
  }
  row.querySelector('p').replaceWith(body);
}

function button(row,label,fn) {
  const b=document.createElement('button');b.type='button';b.textContent=label;
  b.onclick=()=>Promise.resolve(fn()).catch(()=>bubble('暂时无法打开这个页面，请检查连接后重试。'));
  row.append(b);return b;
}
function showQuestions(questions) {
  const items=scope && boxReady ? questions : [];
  if (suggestions.childElementCount===items.length && items.every((text,i)=>suggestions.children[i].textContent===text))return;
  suggestions.hidePopover();
  suggestionsToggle.hidden=!items.length;
  suggestions.replaceChildren(...items.map(text=>{
    const b=document.createElement('button');
    b.type='button';b.dataset.guideQuestion='';b.textContent=text;
    b.onclick=()=>{
      suggestions.hidePopover();
      input.focus();
      termContext=null;
      status();
      void submit(text,{preserveDraft:true});
    };
    return b;
  }));
}
function status() {
  if (!shell()) return;
  const page=shell().page();
  const location=termContext?.origin;
  const rootLabel=pages[location?.page || page]?.[0] || ({provisioning:'添加盒子','client-update':'客户端更新'})[page] || '当前页面';
  const parts=location ? [location.facts?.工作台] : shell().locationParts();
  const parent=page==='help' && shell().parentPage?.();
  const labels=[pages[parent]?.[0],rootLabel,...parts].filter(Boolean);
  const path=labels.filter((label,i)=>label!==labels[i-1]).join(' › ');
  if(heading.textContent!==path)heading.textContent=heading.title=path;
}
async function open(key,trigger,question,origin) {
  const ticket=epoch, attempt=++opening, term=concepts.get(key), hostPage=shell()?.page();
  const expected=project();
  const prompt=term ? question || '什么是'+term.label+'？' : question;
  if(!scope)return;
  if(!boxReady){
    if(await shell()?.open(trigger) && !boxReady)connection.querySelector('button')?.focus();
    return;
  }
  // Opening the drawer can remount or hide the originating embedded view.
  const snapshot=term ? origin?.facts || await shell().snapshot(prompt) : undefined;
  if(attempt!==opening || !current(ticket,expected) || hostPage!==shell().page())return;
  if(!await shell()?.open(trigger) || attempt!==opening || !current(ticket,expected))return;
  if (term) {
    termContext={...term,project:expected,pageAtClick:hostPage,origin};
    void submit(prompt, {term,snapshot,preserveDraft:true,explainTerm:!question});
  }else if(question){
    termContext=null;
    void submit(question,{preserveDraft:true});
  }
  status();
  input.focus();
}
function sync(next, {ready, owner, box}) {
  if(owner!==draftOwner || (box && draftBox && box!==draftBox)) {
    input.value='';
    draftBox=null;
  }
  draftOwner=owner;
  if(box)draftBox=box;
  boxReady=ready;
  input.readOnly=!ready;
  composer.hidden=!ready;
  log.hidden=!ready;
  connection.hidden=ready;
  if(!ready){
    const markup=shell().connectionNotice();
    if(connection.dataset.markup!==markup){
      const focused=connection.contains(document.activeElement);
      connection.innerHTML=markup;
      connection.dataset.markup=markup;
      if(focused)connection.querySelector('button')?.focus({preventScroll:true});
    }
  }
  if(scope!==next) {
    epoch++;lastMatches=null;scope=next;history=[];termContext=null;pending=false;
    log.replaceChildren();
    if(scope)bubble('主人，想了解哪个功能，或想打开哪个页面？');
  }
  syncSendButton();
  if(termContext && (termContext.project!==project() || termContext.pageAtClick!==shell()?.page()))termContext=null;
  status();
  showQuestions(shell()?.questions() || []);
}
async function follow(term,expected, ticket=epoch) {
  if(!current(ticket,expected)){bubble('当前项目已切换，请在新项目中重新选择。');return;}
  const valid=()=>current(ticket);
  if (!shell().go(term.page)) {bubble('主人，当前还有编辑内容。请先保存或关闭，我再带你过去。');return;}
  if(term.view){
    const hit=await shell().navigateView({view:term.view,configuration:term.configuration,guide:true},expected,valid);
    if(!valid())return;
    if(hit?.choose){bubble('请先选择要查看的星图项目，再打开这个入口。');return;}
    if(!hit){bubble('目标暂不可用，请检查项目、连接及当前编辑状态。');return;}
  }
  if(valid() && !term.view)shell().point(term.key);
  if(valid() && term.configuration){bubble('主人，已打开「'+term.label+'」对应的界面。');return;}
  if(valid())bubble(term.view==='ontology'?'主人，本体页到了。我们先看看生效版本里的实体类型和关系。':term.definition || pages[term.page][1]);
}
function resultContext() {
  return [epoch,shell().page(),project(),shell().page()==='data' ? shell().project()?.view : ''].join('|');
}
async function openMatch(group,index) {
  const item=group?.rows[index];
  if(!item || resultContext()!==group.context){bubble('主人，请在当前页面重新查找，再选择要打开的项目。');return;}
  if(!await item.open()){bubble('这项内容的位置或状态已变化，请重新查找。');return;}
  bubble('主人，已定位到「'+item.title+'」。');
}
async function submit(text, options={}) {
  const {term:starTerm,preserveDraft,explainTerm}=options;
  if(!boxReady || !scope || !text || (pending && !preserveDraft))return;
  const ticket=epoch, selected=project(), turn=++request, hostPage=shell().page();
  const origin=termContext?.origin, page=origin?.page || hostPage;
  const valid=()=>current(ticket,selected) && turn===request;
  const previous=history.filter(entry=>entry.project===selected).slice(-4).map(entry=>entry.text);
  bubble(text,'user');
  if(!preserveDraft)input.value='';
  pending=true;syncSendButton();
  let row;
  try{
    const ordinal=text.match(/^(?:请|帮我|带我)?(?:打开|定位到|查看|去看)第([1-9一二三四五六七八九])(?:个|份|项|条)(?:结果)?[。！!]?$/);
    if(ordinal){
      const number=Number(ordinal[1]) || '一二三四五六七八九'.indexOf(ordinal[1])+1;
      await openMatch(lastMatches,number-1);return;
    }
    const intent=guideIntent(text);
    if(intent.type==='choose'){
      const options=bubble('想先打开哪个页面？');
      for(const term of intent.choices)button(options,term.label,()=>follow(term,undefined,ticket));
      return;
    }
    if(intent.type==='guide' && intent.go){await follow(intent.term,intent.term.view && selected || undefined,ticket);return;}
    const term=starTerm || intent.term || termContext;
    const faq=window.memoboxHelpContent?.categories.flatMap(c=>c.items).find(f=>text.replace(/[？?]/g,'')===f.question.replace(/[？?]/g,''));
    row=bubble('正在结合当前页面分析…');
    const pageFacts=guidePageFacts(page,options.snapshot || origin?.facts || await shell().snapshot(text));
    if(!valid() || hostPage!==shell().page()){row.remove();return;}
    const base={applicationGuide:true,question:text.slice(0,2000),history:previous,page,pageFacts,concept:term?.key,
      ...(explainTerm && {explainTerm:true}), ...(faq && {productHelp:faq.answer})};
    async function complete(extra={}){
      const reply=await window.wanxClient.action('starlink',{action:'starxiaotu-answer',input:{...base,...extra}});
      if(!reply.ok || !reply.value?.ok)throw Error(reply.code || reply.value?.code);
      if(!reply.value.value?.answer)throw Error('MODEL_UNAVAILABLE');
      return reply.value.value;
    }
    const contextAtAsk=resultContext();
    const explicitLookup=!starTerm && !origin && explicitGuideLookup(text,page);
    let answer=explicitLookup ? {lookup:explicitLookup} : await complete();
    if(!valid())return;
    let group;
    if(!explainTerm && answer.lookup && !answer.choices?.length && !origin){
      if(contextAtAsk!==resultContext()){row.querySelector('p').textContent='页面已切换，请按当前页面重新提问。';return;}
      let rows;
      try{rows=await shell().records(answer.lookup.query,answer.lookup.area);}
      catch{row.querySelector('p').textContent='当前页面的数据暂时无法读取，请确认连接后重试。';button(row,'重试',()=>submit(text,options));return;}
      if(!valid())return;
      if(contextAtAsk!==resultContext()){row.querySelector('p').textContent='页面已切换，请按当前页面重新提问。';return;}
      group={context:contextAtAsk,rows:rows.slice(0,8)};
      lastMatches=group;
      if(group.rows.length===1 && /^(?:请|帮我|带我)?(?:打开|定位到|去看)/.test(text) &&
         (group.rows[0].title===answer.lookup.query || group.rows[0].exactId)){
        row.remove();await openMatch(group,0);return;
      }
      answer=await complete({pageResults:group.rows.map(({title,source,excerpt})=>({title,source,excerpt}))});
      if(!valid())return;
    }
    renderAnswer(row,answer.answer);
    if(answer.model)row.title='盒子模型 · '+answer.model;
    history.push({project:selected,text:('用户：'+text).slice(0,2000)},
      {project:selected,text:('CentaurAI：'+answer.answer).slice(0,2000)});
    history=history.slice(-8);
    if(Object.keys(pageFacts).length){
      const details=document.createElement('details'),summary=document.createElement('summary'), facts=document.createElement('p');
      summary.textContent='本次参考 · '+(pages[page]?.[0] || '当前页面');
      facts.textContent=Object.entries(pageFacts).map(([k,v])=>k+'：'+(typeof v==='boolean'?(v?'是':'否'):v)).join('\n');
      details.append(summary,facts);row.append(details);
    }
    if(explainTerm)return;
    if(group)group.rows.forEach((item,i)=>{
      const link=button(row,(i+1)+'. '+item.title+' · '+item.source,()=>openMatch(group,i));
      if(item.excerpt){
        const excerpt=document.createElement('small');
        excerpt.className='guide-result-excerpt';
        excerpt.textContent=item.excerpt.slice(0,200);
        link.after(excerpt);
      }
    });
    if(answer.choices?.length===2){
      for(const choice of answer.choices)button(row,choice,()=>{if(current(ticket,selected) && contextAtAsk===resultContext())return submit(choice,{preserveDraft:true});});
      return;
    }
    const view=['ontology','graph','knowledge','data','tasks','overview'].includes(answer.action) ? answer.action : undefined;
    const config=view ? null : configurationLink(answer.action==='ontology-edit'?'ontology':answer.action);
    const linkedTerm=starTerm || intent.term;
    if(config)button(row,config.label,()=>follow({page:'data',...config.target,label:config.label},selected || undefined,ticket));
    else if(view)button(row,linkLabel({page:'data',view}),()=>follow({page:'data',view},selected || undefined,ticket));
    else if(linkedTerm && (!answer.destination || answer.destination===linkedTerm.page))
      button(row,linkLabel(linkedTerm),()=>follow(linkedTerm,linkedTerm.view && selected || undefined,ticket));
    else if(Object.hasOwn(pages,answer.destination))
      button(row,'打开'+pages[answer.destination][0],()=>follow({page:answer.destination},undefined,ticket));
    const prompt=answer.followup;
    if(prompt && prompt!==text)button(row,prompt,()=>{
      if(!current(ticket,selected))return;
      if(shell().page()!==hostPage){bubble('主人，页面已经切换。可以点当前页面的问题继续。');return;}
      return submit(prompt,{term,preserveDraft:true});
    });
  }catch(error){
    if(valid()){
      const message=error.message==='MODEL_NOT_CONFIGURED'?'主人，这台盒子尚未配置可用的默认文本模型。请先检查模型设置。':
        '主人，这次没能取得盒子默认模型的回答。请检查盒子连接和模型服务后重试。';
      if(row){row.querySelector('p').textContent=message;button(row,'重试',()=>submit(text,options));}
      else bubble(message);
    }
  }finally{
    if(row && !valid())row.remove();
    if(ticket===epoch && turn===request){pending=false;syncSendButton();log.scrollTop=log.scrollHeight;}
  }
}
composer.onsubmit=e=>{e.preventDefault();void submit(input.value.trim());};
input.addEventListener('keydown',event=>{
  if(event.key==='Enter' && !event.shiftKey && !event.isComposing && event.keyCode!==229){
    event.preventDefault();void submit(input.value.trim());
  }
});
document.addEventListener('click',e=>{
  if (document.body.classList.contains('academy-drawer-open') && !e.composedPath().includes(host.closest('#academy-drawer-root')) && isGuideBackgroundClick(e)) {
    shell().dismissOnBackground();
  }
  const anchor=e.target.closest('[data-guide-term]'),term=concepts.get(anchor?.dataset.guideTerm);
  if(!term||!scope)return;
  void open(term.key,anchor);
});
window.memoGuide={sync,open,showQuestions,refreshLocation:status,screenTargets:guideScreenTargets};
document.addEventListener('toggle',status,true);
shell()?.sync();
