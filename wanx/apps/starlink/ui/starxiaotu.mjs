import {configurationLink} from '../shared/application-guide.mjs';
/** Project-scoped help, retrieval and navigation. */
import {ontologyQuery, renderOntologyQuery} from './starxiaotu-ontology.mjs';
import {starxiaotuSearchFailure} from './starxiaotu-records.mjs';
import {starxiaotuIntentFailure} from './starxiaotu-intent-errors.mjs';
import {starxiaotuCatalog,validateStarxiaotuDecision,starxiaotuDecisionRequest,starxiaotuCandidateLabel} from '../shared/starxiaotu-intent.mjs';
const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, character =>
  ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[character]);
const asksForExplanation = text => /[？?]|为什么|怎么|如何|是否|有没有|是什么|哪些|哪里|什么时候|多少/.test(text);

export const starxiaotuIcon = '<svg class="sx-sparkles" viewBox="0 0 24 24" aria-hidden="true"><path d="M10 2.6l1.6 4.8 4.8 1.6-4.8 1.6-1.6 4.8-1.6-4.8L3.6 9l4.8-1.6L10 2.6Zm8.7 10 1 3 3 1-3 1-1 3-1-3-3-1 3-1 1-3ZM5.1 15.4l.65 1.95 1.95.65-1.95.65L5.1 20.6l-.65-1.95-1.95-.65 1.95-.65.65-1.95Z" fill="currentColor"/></svg>';

const guide = starxiaotuCatalog.guides;
const guideKey = value => {
  const key = typeof value === 'string' ? value : value?.key || value?.view;
  return ({conversation:'library',list:'data',attribute:'entity',type:'entity',record:'data',source:'library',evidence:'library'})[key] || (guide[key] ? key : 'general');
};
const pageNames = {...starxiaotuCatalog.pages,knowledge:'数据列表'};
const allowedViews = new Set(Object.keys(starxiaotuCatalog.pages));
export function normalizeStarxiaotuResults(payload) {
  const raw = Array.isArray(payload) ? payload : Array.isArray(payload?.results) ? payload.results : [];
  const results = [], seen = new Set();
  let complete = payload?.complete === true && raw.length <= 40;
  for (const item of raw.slice(0,40)) {
    if (!item || typeof item !== 'object' || !item.target || !allowedViews.has(item.target.view)) {complete=false;continue;}
    const target = {view:item.target.view};
    for (const field of ['recordId','documentId','versionId','segmentId','kind']) {
      if (typeof item.target[field] === 'string' && item.target[field]) target[field] = item.target[field];
    }
    if (Number.isSafeInteger(item.target.start) && item.target.start >= 0) target.start = item.target.start;
    const id = typeof item.id === 'string' && item.id ? item.id : target.recordId || target.documentId;
    if (!id) {complete=false;continue;}
    const unique = [target.view,target.kind,target.recordId,target.documentId,target.versionId,target.segmentId,id].join('|');
    if (seen.has(unique)) continue;
    seen.add(unique);
    results.push({id,title:String(item.title || '未命名记录').slice(0,240),excerpt:String(item.excerpt || '').slice(0,1600),target});
  }
  return {results,complete,...(typeof payload?.message==='string'&&payload.message?{notice:payload.message.slice(0,500)}:{}),...(payload?.errorCode?{errorCode:starxiaotuSearchFailure({code:payload.errorCode}).code}:{})};
}
export function canAutoLocateStarxiaotu(results, complete = false) {
  return complete === true && results.length === 1 && ['entity','relation'].includes(results[0]?.target?.kind) && typeof results[0]?.target?.recordId === 'string' && !!results[0].target.recordId;
}

/** Keep this store separate from DOM rendering so stale-request behavior is testable. */
export function createStarxiaotuStore() {
  const sessions = new Map();
  return {
    session(key) {
      if (typeof key !== 'string' || !key) return null;
      if (!sessions.has(key)) sessions.set(key,{open:false,draft:'',turns:[],sequence:0,pending:false});
      return sessions.get(key);
    },
    isCurrent(key,session,sequence) {return sessions.get(key) === session && session.sequence === sequence;},
    clear() {sessions.clear();},
  };
}

export function classifyStarxiaotuRequest(value) {
  const text = String(value ?? '').trim();
  if (!text) return {kind:'empty',text};
  const writing = /(?:修改|改成|改为|改名|重命名|删(?:除|掉)|新增|增加|移除|设为|设成|停用|创建|保存|更新|合并|批量|写入|重新(?:提取|处理)|重提取|替换|调整(?:规则|关系|模型|本体)|导入)/.test(text);
  const explainOnly = /(?:什么是|是什么|是啥|是什么意思|有什么用|怎么用|如何使用|怎样使用|区别|关系是什么|怎么(?:修改|编辑|导入|创建)|如何(?:修改|编辑|导入|创建))/.test(text) &&
    !/(?:帮我|替我|代我|执行|直接).*(?:改|删|保存|更新|合并|创建|导入|提取)/.test(text);
  if (writing && !explainOnly) {
    const destination = /模型|脱敏|设置/.test(text) ? 'models' : /本体|规则|实体类型|关系类型|类型结构|类型定义|结构/.test(text) ? 'ontology' : 'conversation';
    return {kind:'write',text,destination};
  }
  if (/^(?:请)?(?:帮我|替我|给我)?(?:直接|自动)?(?:定位|跳到|找到|打开)/.test(text)) return {kind:'locate',text};
  if (explainOnly || /^(?:介绍|解释|了解)(?:一下)?/.test(text) || /你能做什么|能问什么|怎么提问/.test(text)) {
    const key = /模型|脱敏|设置/.test(text) ? 'models' : /项目列表|切换项目|不同项目/.test(text) ? 'warehouses' : /知识页|数据列表/.test(text) ? 'knowledge' : /本体|规则/.test(text) ? 'ontology' : /资料库|原文|来源|证据/.test(text) ? 'library' : /数据列表|记录/.test(text) ? 'data' : /关系|连线/.test(text) ? 'relation' : /属性|实体|类型/.test(text) ? 'entity' : /概览/.test(text) ? 'overview' : /星图/.test(text) ? 'graph' : 'general';
    return key==='general' && !/你能做什么|能问什么|怎么提问|介绍\s*CentaurAI|解释\s*CentaurAI/.test(text) ? {kind:'search',text} : {kind:'explain',text,key};
  }
  return {kind:'search',text};
}

const robot='<span class="sx-robot" aria-hidden="true"><span class="sx-robot-face"></span>'+starxiaotuIcon+'</span>';
export function starxiaotuWorkflowHeader(label, detail = '', action = '') {
  return `<header class="sx-task-heading"><div class="sx-task-name"><strong>${escapeHTML(label)}</strong>${detail ? `<span class="sx-task-detail" title="${escapeHTML(detail)}">${escapeHTML(detail)}</span>` : ''}</div>${action}</header>`;
}

export function createStarxiaotu({root:host,rail:sidebar,scope,project,view,materialContext,identifyIntent,search,overview,navigate,queryOntology,canEditOntology,hasProject,ask}) {
  if (!host || !sidebar) throw new TypeError('CentaurAI 需要主区和左栏容器。');
  const store = createStarxiaotuStore();
  const document = host.ownerDocument;
  const root = document.createElement('div');
  const rail = document.createElement('div');
  root.className='starxiaotu-root';
  rail.className='starxiaotu-rail';
  host.append(root);
  sidebar.insertBefore(rail,sidebar.querySelector('.starlink-rail-status'));
  const window = document.defaultView;
  let mountedScope = null, displayedFlow = '', nextTurn = 0, disposed = false;
  let observedScope = null, observedView, observedMaterial='', pageRevision = 0;
  const currentScope = (...args) => {
    const key = scope?.(...args);
    return typeof key === 'string' && key ? key : null;
  };
  const sessionNow = () => store.session(currentScope());
  const currentName = () => String(project?.() || '当前项目');
  const currentPage = () => pageNames[view?.()] || '当前页面';
  const activeMaterial=()=>{
    const value=materialContext?.();
    const title=typeof value?.title==='string'?[...value.title.trim()].slice(0,240).join(''):'';
    return {context:{focus:title?'material':'page',material_title:title},key:title?String(value.key||title):''};
  };
  const resultLabel = item => item.target.kind === 'relation' ? '关系记录' : item.target.kind === 'entity' ? '实体记录' : '资料证据';
  const guideLinks = key => guide[key].links.map(([destination,label]) => ({label,target:{view:destination,guide:true}}));
  const guideTurn = (key,ask) => ({id:++nextTurn,time:Date.now(),ask,label:'功能指引',answer:guide[key].text,links:guideLinks(key)});
  const renderLinks = (turn,links) => (links || []).map((link,index) =>
    '<button type="button" class="sx-link" data-sx-turn="'+turn.id+'" data-sx-link="'+index+'">'+escapeHTML(link.target?.guide && link.target.view===view?.()?'定位到'+(link.target.view==='ontology'?'本体规则':pageNames[link.target.view]):link.label)+'</button>').join('');
  const renderTurn = turn => '<article class="sx-turn" data-sx-turn-id="'+turn.id+'">'+(turn.ask?'<p class="sx-user">'+escapeHTML(turn.ask)+'</p>':'')+'<div class="sx-answer">'+(turn.label?'<small class="sx-intent">'+escapeHTML(turn.label)+'</small>':'')+'<p>'+escapeHTML(turn.answer)+'</p>'+
    (turn.notice?'<p class="sx-status">'+escapeHTML(turn.notice)+'</p>':'')+(turn.errorCode?'<small class="sx-error-code">错误码：'+escapeHTML(turn.errorCode)+'</small>':'')+
    (turn.pending?'<p class="sx-status" role="status">'+escapeHTML(turn.status||'正在检索当前项目…')+'</p>':'')+
    (turn.modelFallback?'<button type="button" class="sx-link" data-sx-turn="'+turn.id+'" data-sx-ask-model>直接向模型提问</button>':'')+
    (turn.ontologyQuery?renderOntologyQuery(turn.ontologyQuery):'')+
    (turn.choices||[]).map((choice,index)=>'<button type="button" class="sx-link" data-sx-turn="'+turn.id+'" data-sx-choice="'+index+'"'+(turn.resolved?' disabled':'')+'>'+escapeHTML(choice.label)+'</button>').join('')+
    (turn.results || []).map((item,index) => '<div class="sx-evidence"><strong>'+escapeHTML(item.title)+'</strong><small>'+resultLabel(item)+'</small><small class="sx-reference">'+escapeHTML(item.target.recordId?'记录 ID：'+item.target.recordId:item.target.documentId?'资料 ID：'+item.target.documentId:'结果 ID：'+item.id)+'</small>'+(item.excerpt?'<p>'+escapeHTML(item.excerpt)+'</p>':'')+
      '<button type="button" class="sx-link" data-sx-turn="'+turn.id+'" data-sx-result="'+index+'">'+(turn.choose?'定位这条记录':'打开对应页面')+'</button></div>').join('')+
    renderLinks(turn,turn.links)+(turn.retryIntent?'<button type="button" class="sx-link" data-sx-turn="'+turn.id+'" data-sx-retry-intent>重新识别</button>':'')+(turn.retryRequest?'<button type="button" class="sx-link" data-sx-turn="'+turn.id+'" data-sx-retry>重新查询</button>':'')+(turn.navigation?'<p class="sx-status" role="status">'+escapeHTML(turn.navigation)+'</p>':'')+'</div></article>';

  function alignPanel() {
    const main = root.closest('.main') || document.querySelector('.main');
    const bounds = main?.getBoundingClientRect();
    const width = window?.innerWidth || document.documentElement.clientWidth;
    const height = window?.innerHeight || document.documentElement.clientHeight;
    const gap=12;
    const left = bounds ? Math.max(gap,bounds.left+gap) : gap;
    const right = Math.min(width,bounds?.right ?? width)-gap;
    root.style.left = left+'px';
    root.style.setProperty('--sx-available-width',Math.max(0,right-left)+'px');
    const top=Math.max(gap,(bounds?.top || 0)+gap);
    const bottom=parseFloat(window?.getComputedStyle(root).bottom)||gap;
    root.style.setProperty('--sx-panel-max-height',Math.max(0,height-top-bottom)+'px');
  }

  function render(forceScroll = false) {
    if (disposed) return;
    if (rail.parentNode !== sidebar) sidebar.insertBefore(rail,sidebar.querySelector('.starlink-rail-status'));
    const key = currentScope(), session = store.session(key);
    const activeView=view?.();
    const materialStamp=JSON.stringify(activeMaterial());
    if(key!==observedScope || activeView!==observedView || materialStamp!==observedMaterial){observedScope=key;observedView=activeView;observedMaterial=materialStamp;pageRevision++;}
    root.classList.add('starxiaotu-root');
    rail.classList.add('starxiaotu-rail');
    rail.hidden = !session;
    if (!session) {root.replaceChildren();mountedScope=null;displayedFlow='';return;}
    const visible=session.open;
    const launcher = '<div class="sx-launch-card"><p class="sx-launch-note">点术语旁的<span class="sx-note-icon">'+starxiaotuIcon+'</span>提问。</p><button type="button" class="sx-launch" aria-controls="starxiaotu-panel" aria-expanded="'+visible+'" data-sx-toggle>'+robot+'<span class="sx-launch-label">CentaurAI</span><span class="sx-switch" aria-hidden="true"></span></button></div>';
    if (!rail.querySelector('[data-sx-toggle]')) rail.innerHTML = launcher;
    else rail.querySelector('[data-sx-toggle]').setAttribute('aria-expanded',String(visible));
    if (!visible) {root.replaceChildren();mountedScope=null;displayedFlow='';return;}
    const flow=session.turns.length?session.turns.map(renderTurn).join(''):'<p class="sx-welcome-note">可以问我术语、资料和入口。</p>';
    if (mountedScope !== key || !root.querySelector('.starxiaotu-panel')) {
      root.innerHTML = `<section class="starxiaotu-panel" id="starxiaotu-panel" aria-label="CentaurAI 对话">
        <header class="sx-head">${robot}<div><strong>CentaurAI</strong><small class="sx-current-context"></small></div>
          <button type="button" class="sx-collapse" data-sx-close>收起</button>
        </header>
        <div class="sx-messages" tabindex="0" role="log" aria-live="polite" aria-label="对话记录"></div>
        <form class="sx-compose">
          <label class="sx-visually-hidden" for="starxiaotu-input">向 CentaurAI 提问</label>
          <input id="starxiaotu-input" class="sx-input" placeholder="问 CentaurAI…" autocomplete="off">
          <button type="submit" class="sx-send">发送</button>
        </form>
      </section>`;
      mountedScope=key;displayedFlow='';
      root.querySelector('.sx-input').value=session.draft;
    }
    root.querySelector('.sx-current-context').textContent=currentName()+' · '+currentPage();
    const messages = root.querySelector('.sx-messages');
    const wasAtBottom = messages.scrollHeight-messages.clientHeight-messages.scrollTop < 32;
    if (displayedFlow !== flow) {
      messages.innerHTML=flow;displayedFlow=flow;
      if (forceScroll || wasAtBottom) messages.scrollTop=messages.scrollHeight;
    }
    root.querySelector('.sx-send').disabled=session.pending;
    root.querySelector('.sx-compose').setAttribute('aria-busy',String(session.pending));
    alignPanel();
  }

  async function follow(target,turn,key,session) {
    if (currentScope() !== key || store.session(key) !== session) return;
    const sequence = session.sequence;
    turn.navigation='正在打开对应页面…';render();
    try {
      const result = await navigate?.({...target});
      if (!store.isCurrent(key,session,sequence)) return;
      if (result === false || result == null || typeof result === 'object' && result.found === false || target.recordId && result !== true && result?.found !== true) {
        if(turn.decision?.intent==='navigate')turn.failed=true;
        turn.navigation=typeof result?.message === 'string' ? result.message : '没有定位到目标。可以打开对应页面继续查找；未更改任何记录。';
      } else {
        turn.navigation=typeof result?.message === 'string' ? result.message : target.recordId ? '已定位对应记录。' : '已打开对应页面。';
        if(target.recordId || target.documentId || target.guide || target.configuration){
          session.open=false;
        }
      }
    } catch {
      if (!store.isCurrent(key,session,sequence)) return;
      if(turn.decision?.intent==='navigate')turn.failed=true;
      turn.navigation='页面未能打开，请使用左侧导航进入对应页面。';
    }
    if (currentScope() === key) render();
  }

  function refreshConversation(key) {
    if(currentScope()===key)render(true);
  }

  async function askModel(question,key,session,decision,definition) {
    if(!question || !session || session.pending || !ask || currentScope()!==key)return;
    const turn={id:++nextTurn,time:Date.now(),ask:question,answer:definition || '',
      ...(definition && {label:'术语解释'}),pending:true,status:definition?'正在结合当前项目…':'CentaurAI 正在回答…',
      page:view?.()||'general',decision,materialKey:activeMaterial().key};
    const history=session.turns.filter(item=>item.model).slice(-4).map(item=>item.ask);
    session.turns.push(turn);session.pending=true;
    const sequence=++session.sequence;
    refreshConversation(key);
    try {
      const guideKey=decision?.intent==='guide'?decision.target:null;
      const reply=await ask({question,history,...(guideKey&&{guide:guideKey})});
      if(!store.isCurrent(key,session,sequence))return;
      turn.answer=reply.answer;
      if(reply.projectContext)turn.label=guideKey?'功能指引 · 参考当前项目':'参考当前项目';
      turn.model=reply.model;
      turn.results=normalizeStarxiaotuResults(reply).results;
      const entry=!definition && currentScope()===key && (reply.action!=='ontology'||canEditOntology?.()) && configurationLink(reply.action);
      if(entry)turn.links=[entry];
      else if(guideKey && !definition)turn.links=guideLinks(guideKey);
      else if(decision?.intent==='clarify')turn.choices=decision.arguments.candidates.map(candidate=>({decision:candidate,label:starxiaotuCandidateLabel(candidate)}));
    } catch(error) {
      if(!store.isCurrent(key,session,sequence))return;
      const failure=starxiaotuIntentFailure(error);
      turn.failed=!definition;
      turn.answer=definition||failure.answer.replace('意图识别','问答');
      if(!definition)turn.errorCode=failure.errorCode;
      if(!definition&&!['HOST_SESSION_EXPIRED','WAREHOUSE_CHANGED'].includes(error.code)){
        turn.links=decision?.intent==='guide'?guideLinks(decision.target):[configurationLink('dialogue-models')];
        if(decision?.intent==='clarify')turn.choices=decision.arguments.candidates.map(candidate=>({decision:candidate,label:starxiaotuCandidateLabel(candidate)}));
      }
    }
    turn.pending=false;session.pending=false;refreshConversation(key);
  }

  function explainFeature(feature, question, key, session) {
    if(hasProject?.() && ask)
      return askModel(question,key,session,{intent:'guide',target:feature,arguments:{}});
    session.turns.push(guideTurn(feature,question));
    render(true);
  }

  async function submit(question, choice, preserveDraft = false) {
    const key=currentScope(), session=store.session(key), text=String(question||'').trim();
    if (!session || session.pending || !text) return;
    const plainQuestion=/^(?:提问|问\s*CentaurAI)[：:]\s*/;
    if(!choice && (plainQuestion.test(text)||hasProject?.()===false)){
      const question=text.replace(plainQuestion,'').trim();
      if(question && [...question].length<=2000){
        session.draft='';const input=root.querySelector('.sx-input');if(input)input.value='';
        return askModel(question,key,session);
      }
      if(!question)return;
    }
    const requestPageRevision=pageRevision;
    const requestPage=view?.()||'general',material=activeMaterial();
    let request, decision;
    const selection=typeof choice==='string'?{kind:choice}:choice;
    if(selection?.decision){decision=validateStarxiaotuDecision(selection.decision);request=starxiaotuDecisionRequest(decision,text);}
    else if(selection && ['explain','search','ontology-query','project-overview','ontology-change','locate'].includes(selection.kind))request={...selection,text,key:guideKey(view?.())};
    if(!preserveDraft){session.draft='';const input=root.querySelector('.sx-input');if(input)input.value='';}
    const restoreDraft=()=>{
      if(preserveDraft || session.draft)return;
      session.draft=text;
      if(currentScope()===key && store.session(key)===session){const input=root.querySelector('.sx-input');if(input)input.value=text;}
    };
    const pauseIfMoved=turn=>{
      if(currentScope()===key && pageRevision===requestPageRevision && (view?.()||'general')===requestPage && JSON.stringify(activeMaterial())===JSON.stringify(material))return false;
      turn.pending=false;session.pending=false;
      turn.label='请求已暂停';turn.answer='页面或项目已切换，请在目标页面重新提问。';
      restoreDraft();if(currentScope()===key)render(true);return true;
    };
    if(!request) {
      const turn={id:++nextTurn,time:Date.now(),ask:text,label:'理解需求',answer:'',pending:true,status:'正在识别需要的功能…'};
      const history=session.turns.filter(t=>t.decision&&!t.pending&&!t.failed&&!['clarify','unsupported'].includes(t.decision.intent)).slice(-4).map(t=>({text:[...t.ask].slice(0,500).join(''),page:t.page||'general',decision:t.decision}));
      session.turns.push(turn);session.pending=true;const sequence=++session.sequence;render(true);
      try {
        if([...text].length>2000)throw {code:'MODELING_INTENT_INPUT_TOO_LONG'};
        if(!identifyIntent)throw {code:'MODELING_INTENT_UNAVAILABLE'};
        decision=validateStarxiaotuDecision(await identifyIntent({version:starxiaotuCatalog.version,operation_id:window.crypto.randomUUID(),text,page:requestPage,context:material.context,history,ontology_conversation:false}));
        if(!store.isCurrent(key,session,sequence))return;
        session.pending=false;turn.pending=false;
        if(pauseIfMoved(turn))return;
        request=starxiaotuDecisionRequest(decision,text);
        session.turns.splice(session.turns.indexOf(turn),1);
      } catch(error) {
        if(!store.isCurrent(key,session,sequence))return;
        if(pauseIfMoved(turn))return;
        session.pending=false;turn.pending=false;
        const failure=starxiaotuIntentFailure(error);
        const oldBox=['SEMANTICA_UPGRADE_REQUIRED','SEMANTICA_OPERATION_NOT_ALLOWED','SEMANTICA_RESOURCE_NOT_FOUND','MODELING_INTENT_DEPENDENCY_MISSING'].includes(error.code);
        const writesOntology=classifyStarxiaotuRequest(text).destination==='ontology';
        const links=oldBox&&writesOntology&&canEditOntology?.()?[...failure.links,configurationLink('ontology')]:failure.links;
        Object.assign(turn,{time:Date.now(),label:failure.label,answer:failure.answer,links,errorCode:failure.errorCode,retryIntent:failure.retry,modelFallback:oldBox&&!writesOntology&&!!ask});
        restoreDraft();
        if(currentScope()===key)render(true);return;
      }
    }
    const addTurn=turn=>{turn.time=Date.now();if(decision)turn.decision=decision;turn.page=requestPage;turn.materialKey=material.key;session.turns.push(turn);};
    if(request.kind==='ontology-change') {
      addTurn({id:++nextTurn,ask:text,label:'本体修改指引',
        answer:'打开左侧「本体 → 本体修改」，选择需要调整的实体类型或关系类型。改好后保存为草稿，核对差异，再确认发布。',
        links:canEditOntology?.()?[configurationLink('ontology')]:guideLinks('ontology')});
      render(true);return;
    }
    if(request.kind==='search' && request.scope==='active_material'){
      request.documentId=request.documentId||material.key;
      if(!/^[A-Za-z0-9_-]{1,128}$/.test(request.documentId||'')){
        addTurn({id:++nextTurn,ask:text,label:'确认来源',answer:'请先在资料库打开要查询的资料，再重新提问。'});render(true);return;
      }
    }
    if(request.kind==='explain') {
      if(hasProject?.() && ask)return askModel(request.text,key,session,decision??{intent:'guide',target:request.key,arguments:{}});
      addTurn(guideTurn(request.key,request.text));render(true);return;
    }
    if(request.kind==='navigate') {
      const turn={id:++nextTurn,ask:request.text,label:'页面导航',answer:'前往'+pageNames[request.destination]+'。',links:[{label:'打开'+pageNames[request.destination],target:{view:request.destination}}]};
      addTurn(turn);render(true);await follow({view:request.destination},turn,key,session);return;
    }
    if(request.kind==='clarify') {
      if(request.reason==='ambiguous' && request.candidates.length && ask)return askModel(text,key,session,decision);
      addTurn({id:++nextTurn,ask:request.text,label:'确认意图',answer:!request.candidates.length?'你指的是哪个页面或哪份资料？请补充名称。':request.reason==='multiple'?'你提到了多项需求，请选择先处理哪一项。':'这个问题有两种可能的意思，请选择你需要的操作。',choices:request.candidates.map(candidate=>({decision:candidate,label:starxiaotuCandidateLabel(candidate)}))});
      render(true);return;
    }
    if(request.kind==='search' && request.scope!=='active_material' && ask && asksForExplanation(text))return askModel(text,key,session,decision);
    if(request.kind==='unsupported') {
      if(ask)return askModel(text,key,session,decision);
      addTurn({id:++nextTurn,ask:text,label:'能力范围',answer:'当前支持功能指引、页面导航、项目查询、资料检索和本体操作指引，请换一个相关需求。',links:guideLinks('general')});render(true);return;
    }
    const turn={id:++nextTurn,time:Date.now(),ask:request.text,page:requestPage,label:request.kind==='ontology-query'?'本体查询':request.kind==='project-overview'?'项目概览':request.kind==='locate'?'记录定位':'资料检索',answer:'',pending:true,status:request.kind==='ontology-query'?'正在读取当前项目本体…':request.kind==='project-overview'?'正在读取当前项目统计和资料清单…':undefined};
    if(decision)turn.decision=decision;
    session.turns.push(turn);session.pending=true;const sequence=++session.sequence;render(true);
    try {
      if(request.kind==='project-overview') {
        const payload=await overview(request.metric||'summary');
        if(!store.isCurrent(key,session,sequence))return;
        const normalized=normalizeStarxiaotuResults(payload);
        turn.answer=payload.answer;turn.results=normalized.results;turn.notice=normalized.notice;
        turn.links=[{label:'打开项目概览',target:{view:'overview'}},{label:'打开资料库',target:{view:'conversation'}},{label:'查看星图',target:{view:'graph'}}];
        turn.pending=false;session.pending=false;if(currentScope()===key)render(true);return;
      }
      if(request.kind==='ontology-query') {
        const payload=await queryOntology();
        if(!store.isCurrent(key,session,sequence))return;
        turn.ontologyQuery=ontologyQuery(payload,request.text);turn.answer=turn.ontologyQuery.answer;
        turn.links=[{label:'打开本体页面',target:{view:'ontology'}}];
        turn.pending=false;session.pending=false;if(currentScope()===key)render(true);return;
      }
      const payload = await search(request.query||request.text,request.documentId?{documentId:request.documentId}:undefined);
      if (!store.isCurrent(key,session,sequence)) return;
      const normalized=normalizeStarxiaotuResults(payload);
      turn.notice=normalized.notice;turn.errorCode=normalized.errorCode;
      const records=normalized.results.filter(item=>item.target.recordId && ['entity','relation'].includes(item.target.kind));
      const candidates=request.kind==='locate' && records.length ? records : normalized.results;
      turn.pending=false;session.pending=false;turn.results=candidates;
      if(!candidates.length) {
        turn.answer=normalized.complete ? '当前项目没有找到匹配的记录或资料证据。可以补充名称、关键词，或打开对应页面核对。' : '这次检索没有找到可定位的记录。当前结果范围不完整，可以补充名称或到数据列表继续查找。';
        turn.links=[{label:'打开数据列表',target:{view:'data'}},{label:'打开资料库',target:{view:'conversation'}}];
      } else if(request.kind==='locate') {
        turn.choose=true;
        const unique=canAutoLocateStarxiaotu(candidates,normalized.complete);
        turn.answer=unique ? '找到一条匹配记录，正在尝试定位。' : normalized.complete ? '找到多条匹配结果，请选择需要定位的记录。' : '当前检索范围不完整，请选择需要定位的记录；不会自动认定只有这一条。';
        if(unique && currentScope()===key && pageRevision===requestPageRevision) await follow(candidates[0].target,turn,key,session);
        else if(unique) turn.answer='找到一条匹配记录。点击下方按钮，在当前项目中定位。';
      } else {
        turn.answer='以下是当前项目中检索到的记录和资料摘录。打开对应页面可以核对完整内容与出处。'+(!normalized.complete?' 当前结果范围不完整，可继续补充关键词。':'');
      }
    } catch(error) {
      if (!store.isCurrent(key,session,sequence)) return;
      session.pending=false;turn.pending=false;
      turn.failed=true;
      if(request.kind==='ontology-query') {
        turn.answer=error.message || '本体请求未完成，请稍后重试。';turn.links=[{label:'打开本体页面',target:{view:'ontology'}}];
      } else if(request.kind==='project-overview') {
        turn.answer='项目统计暂时无法读取，请稍后重试或打开概览查看。';
        turn.links=[{label:'打开项目概览',target:{view:'overview'}}];turn.retryRequest={...request};
      } else {
        const failure=starxiaotuSearchFailure(error);turn.answer=failure.answer;turn.errorCode=failure.code;turn.links=failure.links;turn.retryRequest={...request};
      }
    }
    if(currentScope()===key) render(true);
  }

  function onRailClick(event) {
    const button=event.target.closest('[data-sx-toggle]');if(!button || !rail.contains(button))return;
    event.preventDefault();event.stopPropagation();
    const session=sessionNow();if(!session)return;
    session.open=!session.open;render(true);
    if(session.open)root.querySelector('.sx-input')?.focus();
  }
  function onOutsideClick(event) {
    const target=event.target;
    if(!root.contains(target) && !rail.contains(target) && !target.closest?.('[data-starxiaotu-context],[data-starxiaotu-term]'))dismiss();
  }
  function dismiss() {
    const session=sessionNow();
    if(!session || !root.querySelector('.starxiaotu-panel'))return;
    session.open=false;render();
  }
  function onRootClick(event) {
    const button=event.target.closest('button');if(!button || button.disabled || !root.contains(button))return;
    event.stopPropagation();
    const key=currentScope(), session=store.session(key);if(!session)return;
    if(button.hasAttribute('data-sx-close')) {
      dismiss();rail.querySelector('[data-sx-toggle]')?.focus();return;
    }
    const turn=session.turns.find(item=>String(item.id)===button.dataset.sxTurn);if(!turn)return;
    if(button.hasAttribute('data-sx-ask-model')) {
      if(session.draft===turn.ask){session.draft='';root.querySelector('.sx-input').value='';}
      void askModel(turn.ask,key,session);return;
    }
    if(button.hasAttribute('data-sx-retry-intent')){void submit(turn.ask,undefined,true);return;}
    if(button.hasAttribute('data-sx-retry')){void submit(turn.ask,turn.retryRequest,true);return;}
    if(button.hasAttribute('data-sx-choice')) {
      const choice=turn.choices?.[Number(button.dataset.sxChoice)];
      if(!choice || turn.resolved || session.pending)return;
      if(choice.decision?.arguments?.scope==='active_material' && turn.materialKey!==activeMaterial().key){
        turn.resolved=true;session.turns.push({id:++nextTurn,ask:turn.ask,label:'来源已变化',answer:'当前阅读的资料已变化，请重新提问以确认来源。'});render(true);return;
      }
      turn.resolved=true;void submit(turn.ask,choice,true);return;
    }
    const target=button.hasAttribute('data-sx-result')?turn.results?.[Number(button.dataset.sxResult)]?.target:turn.links?.[Number(button.dataset.sxLink)]?.target;
    if(target)void follow(target,turn,key,session);
  }
  function onInput(event) {
    const session=sessionNow();if(!session)return;
    if(event.target.matches('.sx-input'))session.draft=event.target.value;
  }
  function onSubmit(event) {
    if(!event.target.matches('.sx-compose'))return;
    event.preventDefault();event.stopPropagation();
    const session=sessionNow(), question=root.querySelector('.sx-input')?.value;
    if(!session || session.pending || !question?.trim())return;
    void submit(question);
  }
  document.addEventListener('click',onOutsideClick,true);
  rail.addEventListener('click',onRailClick);
  root.addEventListener('click',onRootClick);
  root.addEventListener('input',onInput);
  root.addEventListener('submit',onSubmit);
  window?.addEventListener('resize',alignPanel);
  const resizeObserver=window?.ResizeObserver?new window.ResizeObserver(alignPanel):null;
  resizeObserver?.observe(host);
  return {
    sync(){render();},
    dismiss,
    invalidate(){store.clear();mountedScope=null;displayedFlow='';root.replaceChildren();rail.replaceChildren();rail.hidden=true;},
    explain(context,term,definition) {
      const session=sessionNow();if(!session)return;
      const key=guideKey(context);session.open=true;
      render();
      if (term) {
        const question='什么是'+term+'？';
        if (!session.pending && hasProject?.() && ask) {
          void askModel(question,currentScope(),session,{intent:'guide',target:key,arguments:{}},definition);
        } else {
          session.turns.push({id:++nextTurn,time:Date.now(),ask:question,answer:definition,label:'术语解释'});
          render(true);
        }
      } else {
        void explainFeature(key,'了解：'+guide[key].title,currentScope(),session);
      }
      root.querySelector('.sx-input')?.focus();
    },
    dispose(){
      disposed=true;store.clear();root.remove();rail.remove();
      document.removeEventListener('click',onOutsideClick,true);
      rail.removeEventListener('click',onRailClick);root.removeEventListener('click',onRootClick);
      root.removeEventListener('input',onInput);root.removeEventListener('submit',onSubmit);
      window?.removeEventListener('resize',alignPanel);
      resizeObserver?.disconnect();
    },
  };
}
