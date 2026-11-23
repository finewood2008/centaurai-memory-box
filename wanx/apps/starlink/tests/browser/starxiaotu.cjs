// Actual assembled Starlink UI; synthetic bridge data only, HTTP(S) denied.
const {app,BrowserWindow} = require('electron');
const {mkdir,writeFile,readFile,copyFile,rm} = require('node:fs/promises');
const {resolve,join} = require('node:path');
const assert = require('node:assert/strict');
const root=resolve(__dirname,'../../../..');
const output=process.env.WANX_STARLINK_TEST_OUTPUT || join(root,'evidence/browser');
const runtime=process.env.WANX_STARLINK_TEST_RUNTIME || resolve(__dirname,'../../../personal-client/build/app');
const interactive=process.env.WANX_STARXIAOTU_INTERACTIVE==='1';
app.setPath('userData',join(output,interactive?'interactive-profile':'isolated-profile'));
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const errors=[],checks=[],geometry=[];
let win,deadline,js;
async function until(read,predicate,message) {
  for(let i=0;i<100;i++) {const value=await read();if(predicate(value))return value;await delay(100);}
  throw new Error(message);
}
async function image(name) {await delay(250);if(js){await js('document.getAnimations().filter(animation=>animation.animationName==="sx-enter").forEach(animation=>animation.finish())');assert.equal(await js('document.querySelector(".starxiaotu-panel")?getComputedStyle(document.querySelector(".starxiaotu-panel")).opacity:"1"'),'1','capture before helper opacity settled');}await win.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');await writeFile(join(output,name+'.png'),(await win.webContents.capturePage()).toPNG());}
app.whenReady().then(async()=>{
  deadline=setTimeout(()=>{console.error('STARXIAOTU_BROWSER_TIMEOUT');win?.destroy();app.exit(1);},120000);
  await mkdir(output,{recursive:true});
  await rm(join(output,'failure.json'),{force:true});
  const renderer=join(runtime,'local-ui/renderer');
  const host=await readFile(join(__dirname,'panel-host.js'),'utf8');
  const fixture=String.raw`
window.fixtureLongGraph={nodes:Array.from({length:100},(_,i)=>({entity_id:'n'+String(i).padStart(3,'0'),canonical_name:i===97||i===98?'同名客户':i===99?'远端记录099':'记录'+String(i).padStart(3,'0'),entity_type:'PERSON'})),edges:Array.from({length:99},(_,i)=>({fact_id:'relation'+String(i+1).padStart(3,'0'),subject_entity_id:'n000',object_entity_id:'n'+String(i+1).padStart(3,'0'),relation_type:'WORKS_ON',evidence:[]}))};
window.fixtureOverrides.graph=async()=>({ok:true,value:window.fixtureLongGraph});
window.fixtureOverrides.search=async()=>({ok:true,value:{items:[]}});
`;
  await writeFile(join(renderer,'starxiaotu-host.js'),host+fixture);
  const layout=`<link rel="stylesheet" href="styles.css"><link rel="stylesheet" href="data.css"><link rel="stylesheet" href="personal-layout.css"><link rel="stylesheet" href="material-theme.css"><style>body{margin:0;background:#faf7f2;font:13px system-ui}</style><div class="app-layout starlink-layout"><header class="topbar">星图 · 独立合成数据验收</header><header class="wanx-section-banner starlink-banner" data-section="starlink"><div class="personal-module-title"><div><h2>知识星图 <span class="wanx-section-english">Starlink</span></h2><p>本窗口仅使用合成验收数据，所有外网请求被阻断。</p></div></div></header><div class="page-content data-page-content"><div id="starlink-panel-region" class="starlink-panel-region"></div></div></div>`;
  await writeFile(join(renderer,'starxiaotu-test.html'),'<!doctype html><html lang="zh" data-sample="false"><meta charset="utf-8"><title>星小图 · 客户端合成验收</title><body data-wanx-surface="main">'+layout+'<script src="data-view.js"></script><script src="starxiaotu-host.js"></script></html>');
  win=new BrowserWindow({show:false,width:1280,height:900,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
  win.webContents.session.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(_details,callback)=>callback({cancel:true}));
  win.webContents.on('console-message',(_event,level,message)=>{if(level>=3&&!message.includes('Content-Security-Policy'))errors.push(message);});
  await win.loadFile(join(renderer,'starxiaotu-test.html'));
  const frame=await until(()=>win.webContents.mainFrame.frames,frames=>frames.some(frame=>frame.url.endsWith('/starlink/ui/index.html')),'actual panel iframe missing').then(frames=>frames.find(frame=>frame.url.endsWith('/starlink/ui/index.html')));
  js=code=>frame.executeJavaScript(code);
  const hostJs=code=>win.webContents.executeJavaScript(code);
  const {default:intentCatalog}=await import('../../shared/starxiaotu-catalog.mjs');
  const {starxiaotuNeedle}=await import('../../ui/starxiaotu-records.mjs');
  const intentFixture=(await readFile(join(__dirname,'../fixtures/starxiaotu-intents.mjs'),'utf8')).replace("import catalog from '../../shared/starxiaotu-catalog.mjs';",'const catalog='+JSON.stringify(intentCatalog)+';').replace("import {starxiaotuNeedle} from '../../ui/starxiaotu-records.mjs';",'const starxiaotuNeedle='+starxiaotuNeedle.toString()+';').replace('export function syntheticStarxiaotuDecision','function syntheticStarxiaotuDecision');
  await hostJs(intentFixture+'\nwindow.fixtureOverrides["assistant-intent"]=async input=>typeof input.body.ontology_conversation==="boolean"?({ok:true,value:syntheticStarxiaotuDecision(input.body)}):({ok:false,code:"MODELING_INTENT_INVALID",status:422});void 0;');
  await hostJs(`window.fixtureOverrides["starxiaotu-answer"]=async input=>{
    const guide=input.question==='什么是本体版本？'?'本体版本是一套实体和关系规则的快照。':catalog.guides[input.guide]?.text;
    const mixed=input.question==='帮我看看合同';
    const action=mixed?'ontology':input.question==='修改脱敏规则'?'sensitive':null;
    return {ok:true,value:{answer:mixed?'现有本体有合同类型。如果你想调整合同字段，可打开本体配置。':guide||'当前项目的合成资料回答。',action,model:'test-model',projectContext:true,items:[]}};
  };void 0;`);
  await until(()=>js('document.querySelector("#crumb-warehouse").textContent'),text=>text==='迁移验收仓','fixture project failed to initialize');
  await until(()=>js('document.querySelectorAll("#graph-scene [data-node]").length'),n=>n===100,'long synthetic graph did not load');
  if(interactive) {clearTimeout(deadline);app.on('window-all-closed',()=>app.quit());win.show();win.focus();await image('interactive-ready');await writeFile(join(output,'interactive-startup.json'),JSON.stringify({ready:true,network:'HTTP(S) denied',data:'synthetic',profile:app.getPath('userData'),runtime,at:new Date().toISOString()},null,2));console.log('STARXIAOTU_INTERACTIVE_READY');return;}
  const selectProject=async id=>{
    await js('document.querySelector("#crumb-warehouse").click();document.querySelector('+JSON.stringify('#warehouse-picker [data-warehouse-id="'+id+'"]')+').click()');
    await until(()=>js('document.querySelector("#crumb-warehouse").textContent'),text=>text===(id==='fixture'?'迁移验收仓':'第二验收仓'),'project switch did not settle '+id);
    await until(()=>js('document.querySelectorAll("#graph-scene [data-node]").length'),n=>n===100,'project graph did not load '+id);
  };
  const go=async view=>{
    const wasOpen=await js('Boolean(document.querySelector("#starxiaotu-panel"))');
    await js('document.querySelector('+JSON.stringify('.starlink-rail [data-view="'+view+'"]')+').click()');
    await until(()=>js(view==='ontology'?'!document.querySelector("#view-workbench").hidden':'!document.querySelector('+JSON.stringify('#view-'+view)+').hidden'),Boolean,'view did not open '+view);
    if(wasOpen&&!await js('Boolean(document.querySelector("#starxiaotu-panel"))'))await js('document.querySelector("[data-sx-toggle]").click()');
  };
  const input=async text=>js('(()=>{const input=document.querySelector("#starxiaotu-input");input.value='+JSON.stringify(text)+';input.dispatchEvent(new Event("input",{bubbles:true}));})()');
  const openHelper=()=>js('document.querySelector("#starxiaotu-panel")||document.querySelector("[data-sx-toggle]").click();void 0');
  const submit=async text=>{
    if(!await js('Boolean(document.querySelector(".starxiaotu-panel"))'))await js('document.querySelector("[data-sx-toggle]").click()');
    await input(text);
    await js('document.querySelector("form.sx-compose").requestSubmit()');
    await until(()=>js('!document.querySelector(".sx-send")?.disabled'),Boolean,'helper request did not settle '+text);
  };
  const last=()=>js('document.querySelector(".sx-turn:last-of-type")?.innerText || ""');
  assert.equal(await js('document.querySelectorAll(".starlink-rail [data-sx-toggle]").length'),1);
  assert.equal(await js('Boolean(document.querySelector("[data-sx-toggle] > .sx-robot + .sx-launch-label"))'),true);
  assert.equal(await js('document.querySelector("[data-sx-toggle] .sx-robot").getBoundingClientRect().width'),26);
  assert.equal(await js('Boolean(document.querySelector("#starlink-rail #starlink-sidebar-project, #starlink-rail #starlink-current-name"))'),true);
  assert.equal(await js('Boolean(document.querySelector("#starlink-rail #starlink-sidebar-import"))'),true);
  assert.equal(await js('document.querySelectorAll(".starxiaotu-panel").length'),0);
  assert.notEqual(await hostJs('getComputedStyle(document.querySelector(".starlink-banner")).display'),'none');
  assert.equal(await js('getComputedStyle(document.querySelector(".starxiaotu-rail")).position'),'static');
  assert.equal(await js('document.querySelectorAll("#knowledge-list .sx-sparkles,#relation-list tbody .sx-sparkles").length'),0);
  checks.push('default closed; one embedded rail entry; no repeated row icons');
  await image('01-default-closed');
  await go('overview');
  const marker=await js('(()=>{const h=document.querySelector("#page-title"),b=h.querySelector("[data-starxiaotu-context]");const height=h.getBoundingClientRect().height;const path=b.querySelector("path").getAttribute("d");b.style.display="none";const without=h.getBoundingClientRect().height;b.style.display="";return {height,without,path,launcher:document.querySelector("[data-sx-toggle] path").getAttribute("d"),icon:b.querySelector("svg").getBoundingClientRect().width,heat:b.getBoundingClientRect().width};})()');
  assert.equal(marker.height,marker.without);assert.equal(marker.path,marker.launcher);assert.ok(marker.icon<=12&&marker.heat>=24);
  await js('document.querySelector("#page-title [data-starxiaotu-context]").click()');
  assert.notEqual(await hostJs('getComputedStyle(document.querySelector(".starlink-banner")).display'),'none');
  assert.match(await last(),/了解：概览/);
  await input('项目A未发送草稿');
  assert.equal(await js('document.querySelectorAll(".sx-use-sources,[data-sx-model-prompt]").length'),0);
  assert.match(await js('getComputedStyle(document.querySelector("#starxiaotu-panel")).backgroundImage'),/rgba\(255, 253, 249, 0\.78\)/);
  assert.equal(await js('Boolean(document.querySelector(".sx-robot .sx-robot-face"))'),true);
  await js('document.querySelector(".sx-head strong").click()');
  assert.equal(await js('Boolean(document.querySelector("#starxiaotu-panel"))'),true);
  await js('document.querySelector("#page-title").click()');
  assert.equal(await js('Boolean(document.querySelector("#starxiaotu-panel"))'),false);
  await js('document.querySelector("[data-sx-toggle]").click()');
  assert.equal(await js('document.querySelector("#starxiaotu-input").value'),'项目A未发送草稿');
  await hostJs('document.querySelector(".topbar").click()');
  assert.equal(await js('Boolean(document.querySelector("#starxiaotu-panel"))'),false);
  await js('document.querySelector("[data-sx-toggle]").click()');
  checks.push('translucent panel; inside clicks stay open; iframe and shell outside clicks close without losing conversation or draft');
  const pageContexts={ontology:'本体',conversation:'资料库',knowledge:'数据列表',graph:'星图',overview:'概览'};
  for(const [view,label] of Object.entries(pageContexts)) {
    await go(view);
    assert.equal(await js('document.querySelector("#starxiaotu-input").value'),'项目A未发送草稿');
    assert.match(await js('document.querySelector(".sx-messages").innerText'),/了解：概览/);
    assert.equal(await js('document.querySelector(".sx-current-context").textContent.split(" · ").at(-1)'),label);
  }
  assert.deepEqual(await js('[...document.querySelectorAll(".sx-head button")].map(button=>button.textContent)'),['收起']);
  assert.equal(await js('Boolean(document.querySelector("[data-sx-help], #sx-help-region, .sx-page-guide, [data-sx-route], .sx-workflow-options"))'),false);
  assert.equal(await js('document.querySelector(".sx-head").nextElementSibling.matches(".sx-messages")'),true);
  await go('graph');
  await js('document.querySelector("[data-mode=list]").click()');
  await openHelper();
  await until(()=>js('document.querySelector(".sx-current-context")?.textContent'),text=>text?.endsWith('数据列表'),'list context did not update');
  await js('document.querySelector("[data-mode=graph]").click()');
  await openHelper();
  await until(()=>js('document.querySelector(".sx-current-context")?.textContent'),text=>text?.endsWith('星图'),'graph context did not update');
  assert.equal(await js('document.querySelector("#graph-space").hidden'),false);
  await go('overview');
  assert.equal(await js('document.querySelector("#starxiaotu-input").value'),'项目A未发送草稿');
  checks.push('the floating panel opens directly into the conversation and preserves page context and draft across views');
  checks.push('same AI sparkles and title height; conversation and draft survive reopening on every project page');
  await js('document.getAnimations().filter(animation=>animation.animationName==="sx-enter").forEach(animation=>animation.finish())');
  const panelGeometry=await js('(()=>{const p=document.querySelector(".starxiaotu-panel").getBoundingClientRect(),m=document.querySelector("#content").getBoundingClientRect();return {left:p.left,mainLeft:m.left,right:p.right,mainRight:m.right,top:p.top,mainTop:m.top,bottom:p.bottom,viewport:innerHeight,viewportWidth:innerWidth};})()');
  assert.ok(Math.abs(panelGeometry.left-panelGeometry.mainLeft-12)<2 && panelGeometry.right-panelGeometry.left<=422,JSON.stringify(panelGeometry));
  assert.ok(panelGeometry.right<Math.min(panelGeometry.mainRight,panelGeometry.viewportWidth)-150 && panelGeometry.viewport-panelGeometry.bottom<=13,JSON.stringify(panelGeometry));
  assert.ok(panelGeometry.top>panelGeometry.mainTop+100 && panelGeometry.bottom-panelGeometry.top<=522,JSON.stringify(panelGeometry));
  geometry.push(panelGeometry);
  await image('02-overview-helper');
  await go('ontology');
  await js('document.querySelector("#page-title [data-starxiaotu-context]").click()');
  await until(last,text=>/本体定义资料的分类、属性和关系/.test(text),'ontology help did not answer');
  assert.doesNotMatch(await last(),/会议纪要|本体 ID/);
  assert.deepEqual(await js('[...document.querySelectorAll(".sx-turn:last-of-type [data-sx-link]")].map(b=>b.textContent)'),['定位到本体规则']);
  await js('window.savedOntologySection=document.querySelector("#view-workbench").firstElementChild;document.querySelector(".sx-turn:last-of-type [data-sx-link]").click()');
  await until(()=>js('!document.querySelector(".starxiaotu-panel")'),Boolean,'guide location did not reveal page');
  assert.equal(await js('document.querySelector("#view-workbench").firstElementChild===window.savedOntologySection'),true,'same-page guide reset ontology workbench');
  assert.equal(await js('Boolean(document.querySelector("#view-workbench .sx-record-highlight, #view-workbench.sx-record-highlight"))'),true);
  await js('document.querySelector("[data-sx-toggle]").click()');
  assert.equal(await js('document.querySelector("#starxiaotu-input").value'),'项目A未发送草稿');
  await go('graph');
  await hostJs(`window.answerFixture=window.fixtureOverrides["starxiaotu-answer"];void (window.fixtureOverrides["starxiaotu-answer"]=async()=>({ok:true,value:{answer:"在这个项目里，本体用客户类型和签约关系组织资料。",model:"test-model",projectContext:true,items:[]}}))`);
  await submit('本体是什么意思');
  assert.match(await last(),/参考当前项目[\s\S]*客户类型和签约关系/);
  const linkedAnswer=await hostJs('window.fixtureCalls.filter(call=>call.action==="starxiaotu-answer").at(-1).input');
  assert.deepEqual({question:linkedAnswer.question,guide:linkedAnswer.guide,warehouseId:linkedAnswer.warehouseId},{question:'本体是什么意思',guide:'ontology',warehouseId:'fixture'});
  assert.equal(Object.hasOwn(linkedAnswer,'useSources'),false);
  assert.equal(await js('document.querySelector(".sx-turn:last-of-type [data-sx-link]").textContent'),'前往本体');
  await hostJs('void(window.fixtureOverrides["starxiaotu-answer"]=window.answerFixture)');
  checks.push('definition answers default to the current project and retain a read-only product link');
  await submit('帮我看看合同');
  assert.match(await last(),/现有本体有合同类型[\s\S]*前往本体修改/);
  assert.equal(await js('document.querySelectorAll(".sx-turn:last-of-type [data-sx-choice]").length'),0);
  checks.push('ambiguous request gives a project answer and an optional configuration entry together');
  await submit('如何查看本体');
  assert.deepEqual(await js('[...document.querySelectorAll(".sx-turn:last-of-type [data-sx-link]")].map(b=>b.textContent)'),['前往本体']);
  await js('document.querySelector(".sx-turn:last-of-type [data-sx-link]").click()');
  await until(()=>js('!document.querySelector("#view-workbench").hidden && !document.querySelector(".starxiaotu-panel")'),Boolean,'guide did not navigate to ontology');
  await js('document.querySelector("[data-sx-toggle]").click()');
  assert.equal(await js('document.querySelector(".sx-turn:last-of-type [data-sx-link]").textContent'),'定位到本体规则');
  await input('项目A未发送草稿');
  checks.push('concise help has one live navigation link; same-page location preserves ontology and draft; navigation reveals target and retains conversation');

  await selectProject('second');
  await until(()=>js('document.querySelector(".starxiaotu-panel")===null'),Boolean,'successful record location did not collapse helper');
  await js('document.querySelector("[data-sx-toggle]").click()');
  assert.equal(await js('document.querySelector("#starxiaotu-input").value'),'');
  assert.doesNotMatch(await js('document.querySelector(".sx-messages").innerText'),/了解：概览|项目A未发送草稿/);
  await input('项目B草稿');await selectProject('fixture');
  await openHelper();
  assert.equal(await js('document.querySelector("#starxiaotu-input").value'),'项目A未发送草稿');
  assert.match(await js('document.querySelector(".sx-messages").innerText'),/了解：概览/);
  checks.push('independent project conversations and drafts restore on return');
  await hostJs('window.fixtureOverrides.search=async()=>new Promise(resolve=>{window.releaseSxSearch=()=>resolve({ok:true,value:{items:[{document_id:"doc",document_version_id:"cited-version",segment_id:"cited-segment",text:"仅属于项目A的迟到证据"}]}});});void 0;');
  await input('迟到检索专用词');
  await js('document.querySelector("form.sx-compose").requestSubmit()');
  await until(()=>hostJs('typeof window.releaseSxSearch'),value=>value==='function','held search not dispatched');
  await selectProject('second');
  await openHelper();
  const beforeB=await js('document.querySelector(".sx-messages").innerText');
  await hostJs('window.releaseSxSearch()');await delay(150);
  assert.equal(await js('document.querySelector(".sx-messages").innerText'),beforeB);
  assert.equal(await js('document.querySelector("#starxiaotu-input").value'),'项目B草稿');
  assert.equal(await js('document.querySelector("#view-graph").hidden'),false);
  await selectProject('fixture');
  await openHelper();
  await until(()=>js('!document.querySelector(".sx-send").disabled'),Boolean,'project A pending request did not settle');
  assert.match(await last(),/项目已切换|检索暂时不可用|没有生成资料回答/);
  checks.push('late project A search cannot alter project B conversation, draft or navigation');
  await hostJs('window.fixtureOverrides.search=async()=>({ok:true,value:{items:[]}});void 0;');
  await go('overview');await submit('定位同名客户');
  const duplicates=await js('document.querySelector(".sx-turn:last-of-type").querySelectorAll("[data-sx-result]").length');
  assert.ok(duplicates>=2);assert.equal(await js('document.querySelector("#view-overview").hidden'),false);
  await js('document.querySelector(".sx-turn:last-of-type [data-sx-result]").click()');
  await until(()=>js('Boolean(document.querySelector("#knowledge-list .sx-record-highlight"))'),Boolean,'selected duplicate did not reveal actual entity');
  assert.equal(await js('document.querySelector("#knowledge-list [aria-current=true]").dataset.entityPage'),'n097');
  await until(()=>js('document.querySelector(".starxiaotu-panel")===null'),Boolean,'successful record location did not collapse helper');
  assert.equal(await js('(()=>{const e=document.querySelector("#knowledge-list .sx-record-highlight"),r=e.getBoundingClientRect();return e.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2));})()'),true);
  checks.push('ambiguous names require explicit candidate selection; successful location collapses helper to expose record');
  await go('overview');await submit('n099');
  assert.equal(await js('document.querySelector("#view-overview").hidden'),false,'ordinary lookup auto-navigated');
  checks.push('ordinary question returns record links without automatic navigation');
  await go('knowledge');await js('document.querySelector("#knowledge-query").value="完全不匹配";document.querySelector("#knowledge-query").dispatchEvent(new Event("input",{bubbles:true}));');
  assert.equal(await js('document.querySelectorAll("#knowledge-list [data-entity-page]").length'),0);
  await submit('定位n099');
  await until(()=>js('Boolean(document.querySelector("#knowledge-list [data-entity-page=n099].sx-record-highlight"))'),Boolean,'far entity not highlighted');
  const entityGeometry=await js('(()=>{const e=document.querySelector("#knowledge-list [data-entity-page=n099]"),p=document.querySelector("#knowledge-list"),r=e.getBoundingClientRect(),b=p.getBoundingClientRect();return {count:document.querySelectorAll("#knowledge-list [data-entity-page]").length,scroll:p.scrollTop,top:r.top,bottom:r.bottom,containerTop:b.top,containerBottom:b.bottom,selected:e.getAttribute("aria-current"),query:document.querySelector("#knowledge-query").value};})()');
  assert.equal(entityGeometry.count,100);assert.equal(entityGeometry.selected,'true');assert.equal(entityGeometry.query,'');assert.ok(entityGeometry.scroll>0);assert.ok(entityGeometry.top>=entityGeometry.containerTop-2&&entityGeometry.bottom<=entityGeometry.containerBottom+2);geometry.push(entityGeometry);
  await until(()=>js('document.querySelector(".starxiaotu-panel")===null'),Boolean,'successful record location did not collapse helper');
  await until(()=>js('(()=>{const e=document.querySelector("#knowledge-list [data-entity-page=n099]"),r=e.getBoundingClientRect();return e.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2));})()'),Boolean,'entity should remain visible after the banner returns');
  await image('03-entity-revealed');checks.push('exact ID reveals remote entity after clearing mismatching filter, all 100 rows retained');
  await go('graph');
  await js('document.querySelector("#graph-query").value="记录001";document.querySelector("#graph-query").dispatchEvent(new Event("input",{bubbles:true}));');
  await submit('定位relation099');
  await until(()=>js('Boolean(document.querySelector("#relation-list [data-edge=relation099].sx-record-highlight"))'),Boolean,'far relation not highlighted');
  const relationGeometry=await js('(()=>{const e=document.querySelector("#relation-list [data-edge=relation099]"),p=document.querySelector("#relation-list"),r=e.getBoundingClientRect(),b=p.getBoundingClientRect();return {count:p.querySelectorAll("tbody tr").length,scroll:p.scrollTop,top:r.top,bottom:r.bottom,containerTop:b.top,containerBottom:b.bottom,query:document.querySelector("#graph-query").value,hidden:p.hidden};})()');
  assert.equal(relationGeometry.count,99);assert.equal(relationGeometry.query,'');assert.equal(relationGeometry.hidden,false);assert.ok(relationGeometry.scroll>0);assert.ok(relationGeometry.top>=relationGeometry.containerTop-2&&relationGeometry.bottom<=relationGeometry.containerBottom+2);geometry.push(relationGeometry);
  await until(()=>js('document.querySelector(".starxiaotu-panel")===null'),Boolean,'successful record location did not collapse helper');
  await until(()=>js('(()=>{const e=document.querySelector("#relation-list [data-edge=relation099]"),r=e.getBoundingClientRect();return e.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2));})()'),Boolean,'relation should remain visible after the banner returns');
  await image('04-relation-revealed');checks.push('exact ID reveals relation with actual scroll and highlight, all 99 rows retained');
  const writesBefore=await hostJs('window.fixtureCalls.length');
  for(const question of ['把n099改名为已完成','帮我修改原文为测试','修改模型设置']) {
    await submit(question);assert.match(await last(),/功能指引/);
    assert.ok(await js('Boolean(document.querySelector(".sx-turn:last-of-type [data-sx-link]"))'));
  }
  const mutationCalls=await hostJs('window.fixtureCalls.slice('+writesBefore+').filter(call=>["correct","save-models","reprocess-models","upload","delete-document","delete-warehouse","create-warehouse"].includes(call.action)||call.action==="workbench-request"&&call.input.method!=="GET").map(call=>({action:call.action,input:call.input}))');
  assert.deepEqual(mutationCalls,[]);checks.push('fact, source and model mutations retain existing page confirmation flows; zero mutation calls');
  const history=await js('(()=>{const m=document.querySelector(".sx-messages");m.scrollTop=0;return {scrollHeight:m.scrollHeight,clientHeight:m.clientHeight,mask:getComputedStyle(m).maskImage};})()');
  assert.ok(history.scrollHeight>history.clientHeight);assert.equal(history.mask,'none');geometry.push(history);
  await input('收起后仍保留草稿');
  await js('document.querySelector("[data-sx-close]").click()');
  assert.equal(await js('document.querySelectorAll(".starxiaotu-panel").length'),0);
  assert.notEqual(await hostJs('getComputedStyle(document.querySelector(".starlink-banner")).display'),'none');
  assert.equal(await js('document.activeElement===document.querySelector("[data-sx-toggle]")'),true);
  await js('document.querySelector("[data-sx-toggle]").click()');
  assert.equal(await js('document.querySelector("#starxiaotu-input").value'),'收起后仍保留草稿');
  checks.push('scrollable faded history and collapse/reopen preserve history and draft; focus restored');
  await image('05-writes-and-history');
  await go('overview');
  await hostJs(`window.fixtureOverrides.warehouse=async input=>({ok:true,value:{...window.fixtureWarehouses.find(w=>w.id===input.id),document_count:1,entity_count:100,relation_count:99}});
    window.fixtureOverrides.documents=async()=>({ok:true,value:{items:[{id:'doc',original_name:'合成决策资料.txt'}],total:1}});void 0;`);
  const overviewCallsBefore=await hostJs('window.fixtureCalls.length');
  await submit('当前星图里面有什么');
  assert.match(await last(),/项目概览.*资料 1 份.*实体 100 个.*合成决策资料/s);
  assert.deepEqual(await hostJs('window.fixtureCalls.slice('+overviewCallsBefore+').filter(c=>c.action==="search")'),[],'project overview wrongly depends on full-text index');
  assert.equal(await js('document.querySelector("#view-overview").hidden'),false);
  await hostJs('delete window.fixtureOverrides.warehouse;delete window.fixtureOverrides.documents;window.fixtureOverrides.search=async()=>({ok:false,code:"SEMANTICA_INDEX_REQUIRED",message:"需要建立索引"});void 0;');
  await submit('请搜索索引测试词');
  assert.match(await last(),/尚未建立检索索引.*SEMANTICA_INDEX_REQUIRED/s);
  assert.equal(await hostJs('window.fixtureCalls.filter(c=>c.action==="search").at(-1).input.query'),'索引测试词');
  await input('保留检索未发送内容');
  await hostJs('window.fixtureOverrides.search=async()=>({ok:true,value:{items:[{document_id:"doc",document_name:"合成决策资料.txt",document_version_id:"cited-version",segment_id:"cited-segment",text:"检索命中的原文证据"}]}});void 0;');
  await js('document.querySelector(".sx-turn:last-of-type [data-sx-retry]").click()');
  await until(last,text=>text.includes('检索命中的原文证据'),'retry did not display real search evidence');
  assert.equal(await js('document.querySelector("#starxiaotu-input").value'),'保留检索未发送内容');
  assert.ok(await js('Boolean(document.querySelector(".sx-turn:last-of-type [data-sx-result]"))'));
  await hostJs('window.fixtureOverrides.search=async()=>({ok:false,code:"SEMANTICA_INDEX_REQUIRED"});void 0;');
  await submit('同名客户');
  assert.match(await last(),/SEMANTICA_INDEX_REQUIRED.*同名客户/s);
  assert.match(await last(),/仅展示当前已加载记录/);
  await hostJs('window.fixtureOverrides.search=async()=>({ok:true,value:{items:[]}});void 0;');
  checks.push('content overview reads project data without an index; keyword search dispatches, exposes index errors, retries with evidence and marks local-only fallback');
  await hostJs(`window.fixtureOverrides.jobs=async()=>({ok:true,value:{total:2,items:[
    {id:'suggestion-audit',kind:'ontology_suggest',status:'failed',stage:'failed',updated_at:'2026-11-23T08:07:00Z'},
    {id:'parse-job',kind:'document_parse',status:'failed',stage:'failed',updated_at:'2026-11-23T08:06:00Z'}]}});void 0;`);
  await go('conversation');
  await js('document.querySelector("#page-tasks").click()');
  await js('document.querySelector("#view-tasks [data-action=refresh]").click()');
  await until(()=>js('document.querySelector(".task-row [data-view=conversation]")?.textContent'),text=>text==='前往资料库','suggestion audit should link to its recovery workflow');
  assert.equal(await js('Boolean(document.querySelector("[data-retry=suggestion-audit]"))'),false);
  assert.equal(await js('Boolean(document.querySelector("[data-retry=parse-job]"))'),true);
  checks.push('failed suggestion audit leads to the library while a failed parser can be retried directly');
  await hostJs('delete window.fixtureOverrides.jobs;void 0;');
  await openHelper();
  assert.match(await js('document.querySelector(".sx-current-context").textContent'),/处理任务/);
  await go('overview');
  const deferredLocations=await js(`(async()=>{
    const {createStarxiaotu}=await import('./starxiaotu.mjs');
    const observed=[];
    for(const returnToPage of [false,true]){
      const host=document.createElement('div'),rail=document.createElement('aside');
      document.body.append(host,rail);
      let page='graph',release;const navigations=[];
      const helper=createStarxiaotu({root:host,rail,scope:()=> 'review/project',project:()=> 'Review',view:()=>page,
        identifyIntent:async()=>({intent:'navigate',target:'record',arguments:{query:'review-record'}}),
        search:()=>new Promise(resolve=>{release=resolve;}),navigate:target=>{navigations.push(target);return true;}});
      try{
        helper.explain('graph');
        const input=host.querySelector('.sx-input');input.value='定位review-record';
        input.dispatchEvent(new Event('input',{bubbles:true}));host.querySelector('form').requestSubmit();
        await new Promise(resolve=>setTimeout(resolve,0));
        page='ontology';helper.sync();if(returnToPage){page='graph';helper.sync();}
        release({complete:true,results:[{id:'review-record',title:'Review record',target:{view:'knowledge',kind:'entity',recordId:'review-record'}}]});
        await new Promise(resolve=>setTimeout(resolve,0));
        observed.push({returnToPage,automatic:navigations.length,panelOpen:Boolean(host.querySelector('.starxiaotu-panel'))});
        host.querySelector('[data-sx-result]').click();await new Promise(resolve=>setTimeout(resolve,0));
        observed.at(-1).manual=navigations.length;
      }finally{helper.dispose();host.remove();rail.remove();}
    }
    return observed;
  })()`);
  for(const result of deferredLocations){assert.equal(result.automatic,0);assert.equal(result.panelOpen,true);assert.equal(result.manual,1);}
  checks.push('late location results stay as selectable records after page changes, including leaving and returning; manual navigation remains available');
  const intentGuards=await js(`(async()=>{
    const {createStarxiaotu}=await import('./starxiaotu.mjs');
    const results=[];
    for(const scenario of ['invalid','unavailable','dependency','page','project','back','guide','metric','clarify']){
      const host=document.createElement('div'),rail=document.createElement('aside');document.body.append(host,rail);
      let page='graph',scope='project-a',release,stats=0,searches=0,navigations=0,received;
      const helper=createStarxiaotu({root:host,rail,scope:()=>scope,project:()=>scope,view:()=>page,
        identifyIntent:body=>{received=body;return scenario==='unavailable'?Promise.reject(new Error('private upstream error')):scenario==='dependency'?Promise.reject({code:'MODELING_INTENT_DEPENDENCY_MISSING'}):new Promise(resolve=>{release=resolve;});},
        search:async()=>{searches++;return {results:[]};},navigate:async()=>{navigations++;return true;},
        overview:async metric=>{stats++;return {answer:'metric:'+metric,results:[]};}});
      try{
        helper.explain('graph');const input=host.querySelector('.sx-input');input.value='这里能看到我导入了几份材料吗';input.dispatchEvent(new Event('input',{bubbles:true}));host.querySelector('form').requestSubmit();
        if(scenario==='page'||scenario==='back'){page='ontology';helper.sync();if(scenario==='back'){page='graph';helper.sync();}}
        if(scenario==='project'){scope='project-b';helper.sync();}
        release?.(scenario==='invalid'?{intent:'ontology_change',target:'ontology',arguments:{confirmed:true}}:scenario==='guide'?{intent:'guide',target:'overview',arguments:{}}:scenario==='clarify'?{intent:'clarify',target:'none',arguments:{reason:'ambiguous',candidates:[{intent:'guide',target:'graph',arguments:{}},{intent:'search',target:'materials',arguments:{query:'星图'}}]}}:scenario==='metric'?{intent:'query',target:'project_stats',arguments:{metric:'document_count'}}:{intent:'navigate',target:'models',arguments:{}});
        await new Promise(resolve=>setTimeout(resolve,0));
        if(scenario==='project'){helper.explain('graph');}
        results.push({scenario,stats,searches,navigations,text:host.innerText,history:received.history,choices:host.querySelectorAll('[data-sx-choice]').length,retry:host.querySelectorAll('[data-sx-retry-intent]').length});
      }finally{helper.dispose();host.remove();rail.remove();}
    }
    return results;
  })()`);
  for(const value of intentGuards){
    assert.equal(value.searches,0,value.scenario);assert.equal(value.navigations,0,value.scenario);
    assert.equal(value.stats,value.scenario==='metric'?1:0,value.scenario);assert.deepEqual(value.history,[]);
    if(value.scenario==='invalid')assert.match(value.text,/识别结果无效/);
    if(value.scenario==='unavailable')assert.match(value.text,/识别服务异常/);
    if(value.scenario==='clarify')assert.match(value.text,/确认意图/);
    if(['invalid','unavailable','dependency'].includes(value.scenario)){assert.equal(value.choices,0);assert.equal(value.retry,1);}
    if(value.scenario==='dependency')assert.match(value.text,/服务未就绪.*缺少.*组件/s);
    if(['page','back'].includes(value.scenario))assert.match(value.text,/请求已暂停/);
    if(value.scenario==='guide')assert.match(value.text,/功能指引/);
    if(value.scenario==='metric')assert.match(value.text,/metric:document_count/);
    assert.doesNotMatch(value.text,/private upstream error/);
  }
  checks.push('finite LLM decisions dispatch typed stats and help; malformed output, model failure, ambiguity and stale contexts never search, navigate or mutate automatically');
  const reviewRegressions=await js(`(async()=>{
    const {createStarxiaotu}=await import('./starxiaotu.mjs');
    const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
    const results=[];
    for(const scenario of ['retry-intent','retry-search','retry-metric']){
      const host=document.createElement('div'),rail=document.createElement('aside');document.body.append(host,rail);
      let modelCalls=0;
      const requests=[];
      const helper=createStarxiaotu({root:host,rail,scope:()=>'project-a',project:()=>'project-a',view:()=>'graph',
        identifyIntent:async()=>{modelCalls++;if(scenario==='retry-intent'&&modelCalls===1)throw {code:'MODELING_INTENT_DEPENDENCY_MISSING'};return scenario==='retry-search'?{intent:'search',target:'materials',arguments:{query:'合同到期'}}:{intent:'query',target:'project_stats',arguments:{metric:'document_count'}};},
        search:async query=>{requests.push(query);if(requests.length===1)throw new Error('synthetic unavailable');return {results:[]};},
        overview:async metric=>{requests.push(metric);if(scenario==='retry-metric'&&requests.length===1)throw new Error('synthetic unavailable');return {answer:'metric:'+metric,results:[]};}});
      const type=text=>{const input=host.querySelector('.sx-input');input.value=text;input.dispatchEvent(new Event('input',{bubbles:true}));};
      try{
        helper.explain('graph');type('请处理这个需求');host.querySelector('form').requestSubmit();await tick();
        const before=host.innerText;type('保留未发送的问题');host.querySelector(scenario==='retry-intent'?'[data-sx-retry-intent]':'[data-sx-retry]').click();await tick();
        results.push({scenario,requests,modelCalls,before,draft:host.querySelector('.sx-input').value});
      }finally{helper.dispose();host.remove();rail.remove();}
    }
    return results;
  })()`);
  for(const value of reviewRegressions){
    if(value.scenario==='retry-intent'){
      assert.deepEqual(value.requests,['document_count']);assert.equal(value.modelCalls,2);assert.equal(value.draft,'保留未发送的问题');
    }else if(value.scenario.startsWith('retry-')){
      assert.deepEqual(value.requests,Array(2).fill(value.scenario==='retry-search'?'合同到期':'document_count'));
      assert.equal(value.modelCalls,1);assert.equal(value.draft,'保留未发送的问题');
      if(value.scenario==='retry-metric'){assert.match(value.before,/项目统计暂时无法读取/);assert.doesNotMatch(value.before,/资料检索/);}
    }
  }
  checks.push('retries retain the original query or metric and preserve the current draft');
  const contextualRouting=await js(`(async()=>{
    const {createStarxiaotu}=await import('./starxiaotu.mjs');
    const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
    const results=[];
    for(const scenario of ['choose-guide','choose-search','two-guides','missing-reference','material-change','material-rename','explicit-page','active-search','stale-source-choice']){
      const host=document.createElement('div'),rail=document.createElement('aside');document.body.append(host,rail);
      let material=scenario==='missing-reference'?null:{key:'doc-a',title:'星图产品说明.docx',text:'private source text'},release,calls=0;
      const bodies=[],searches=[],sources=[];
      const guide=target=>({intent:'guide',target,arguments:{}});
      const helper=createStarxiaotu({root:host,rail,scope:()=> 'context-project',project:()=> 'Context',view:()=> 'graph',materialContext:()=>material,
        identifyIntent:body=>{bodies.push(body);calls++;
          if(scenario.startsWith('material-'))return new Promise(resolve=>{release=resolve;});
          if(scenario==='missing-reference')return Promise.resolve({intent:'clarify',target:'none',arguments:{reason:'missing_context',candidates:[]}});
          if(scenario==='active-search')return Promise.resolve({intent:'search',target:'materials',arguments:{query:'星图产品功能',scope:'active_material'}});
          if(scenario==='explicit-page'||calls>1)return Promise.resolve(guide('graph'));
          return Promise.resolve({intent:'clarify',target:'none',arguments:{reason:'ambiguous',candidates:[guide('graph'),scenario==='two-guides'?guide('ontology'):{intent:'search',target:'materials',arguments:{query:'星图 产品功能',...(scenario==='stale-source-choice'?{scope:'active_material'}:{})}}]}});},
        search:async(query,source)=>{searches.push(query);sources.push(source);return {results:[]};}});
      const ask=async text=>{const input=host.querySelector('.sx-input');input.value=text;input.dispatchEvent(new Event('input',{bubbles:true}));host.querySelector('form').requestSubmit();await tick();};
      try{
        helper.explain('graph');await ask(scenario==='explicit-page'?'左侧星图有什么功能':scenario==='missing-reference'?'它有哪些功能':'帮我看看星图');
        if(scenario.startsWith('choose-')||scenario==='two-guides'){
          const labels=[...host.querySelectorAll('.sx-turn:last-of-type [data-sx-choice]')].map(b=>b.textContent);
          const index=scenario==='choose-guide'?0:1;
          host.querySelector('.sx-turn:last-of-type [data-sx-choice="'+index+'"]').click();await tick();
          const callsAfterChoice=calls,answer=host.querySelector('.sx-turn:last-of-type').innerText;
          await ask('那它还有什么功能');
          results.push({scenario,labels,callsAfterChoice,answer,searches,history:bodies[1].history});
        }else if(scenario==='stale-source-choice'){
          material={key:'doc-b',title:'另一份资料'};helper.sync();host.querySelector('.sx-turn:last-of-type [data-sx-choice="1"]').click();await tick();
          results.push({scenario,searches,text:host.innerText});
        }else if(scenario.startsWith('material-')){
          material=scenario==='material-change'?{key:'doc-b',title:'另一份资料'}:{...material,title:'更名后的资料'};helper.sync();
          release({intent:'search',target:'materials',arguments:{query:'星图产品功能'}});await tick();
          results.push({scenario,searches,text:host.innerText,context:bodies[0].context});
        }else results.push({scenario,text:host.innerText,searches,sources,choices:host.querySelectorAll('[data-sx-choice]').length,context:bodies[0].context});
      }finally{helper.dispose();host.remove();rail.remove();}
    }
    return results;
  })()`);
  for(const value of contextualRouting){
    if(value.scenario.startsWith('choose-')||value.scenario==='two-guides'){
      assert.equal(value.labels.length,2);assert.equal(value.callsAfterChoice,1,'candidate was reclassified');
      assert.deepEqual(value.history.map(item=>item.decision.intent),[value.scenario==='choose-search'?'search':'guide']);
      assert.equal(value.history[0].page,'graph');
      if(value.scenario==='choose-search'){assert.deepEqual(value.searches,['星图 产品功能']);assert.match(value.labels[1],/检索资料/);}
      else {assert.deepEqual(value.searches,[]);assert.match(value.answer,value.scenario==='two-guides'?/本体定义资料/:/星图用节点/);}
    }else if(value.scenario==='missing-reference'){assert.equal(value.choices,0);assert.match(value.text,/补充名称/);}
    else if(value.scenario==='active-search'){assert.deepEqual(value.sources,[{documentId:'doc-a'}]);}
    else if(value.scenario==='stale-source-choice'){assert.deepEqual(value.searches,[]);assert.match(value.text,/来源已变化/);}
    else if(value.scenario==='explicit-page'){assert.match(value.text,/功能指引/);assert.deepEqual(value.searches,[]);}
    else {assert.deepEqual(value.searches,[]);assert.match(value.text,/请求已暂停/);}
    if(value.context){assert.deepEqual(value.context,value.scenario==='missing-reference'?{focus:'page',material_title:''}:{focus:'material',material_title:'星图产品说明.docx'});assert.doesNotMatch(JSON.stringify(value.context),/private|doc-a/);}
  }
  checks.push('source context sends only a title; related candidates dispatch once and enter resolved history; same-kind choices stay distinct; missing references request a name; changing or renaming material pauses old decisions');
  await openHelper();
  const adaptive=[];
  for(const [width,height] of [[1920,1080],[1280,900],[850,700],[400,650]]){
    win.setSize(width,height);
    await until(()=>js('innerWidth'),n=>n<=width&&n>width-180,'frame has not resized for adaptive helper');
    await delay(150);
    const layout=await js('(()=>{const p=document.querySelector(".starxiaotu-panel").getBoundingClientRect(),input=document.querySelector(".sx-compose").getBoundingClientRect();return {width:innerWidth,height:innerHeight,panelWidth:p.width,panelHeight:p.height,left:p.left,right:p.right,top:p.top,bottom:p.bottom,inputBottom:input.bottom,messages:document.querySelector(".sx-messages").clientHeight};})()');
    assert.ok(layout.left>=0&&layout.right<=layout.width+1&&layout.top>=0&&layout.bottom<=layout.height+1);
    assert.ok(layout.inputBottom<=layout.bottom+1&&layout.messages>0,JSON.stringify(layout));geometry.push(layout);adaptive.push(layout);
    if(width===1920)await image('06a-adaptive-wide');
  }
  assert.ok(adaptive[0].panelWidth<=422 && adaptive[0].panelWidth===adaptive[1].panelWidth,JSON.stringify(adaptive));
  assert.ok(adaptive.every(layout=>layout.panelHeight<=522 && layout.panelWidth<=422),JSON.stringify(adaptive));
  assert.ok(adaptive[3].panelWidth<adaptive[0].panelWidth,JSON.stringify(adaptive));
  await image('06-context-guide-narrow');
  checks.push('the floating helper is capped on desktop and shrinks to fit the narrow viewport');
  win.setSize(1280,900);await delay(150);
  const ontologyFixture=await readFile(join(__dirname,'../fixtures/starxiaotu-ontology.mjs'),'utf8');
  await hostJs(ontologyFixture.replace('export function','function')+`\nwindow.sxOntologyFixture=starxiaotuOntologyFixture();
    window.fixtureOverrides['conversation-ontologies']=async input=>({ok:true,value:window.sxOntologyFixture.query(input.warehouseId)});
    void 0;`);
  await input('');await go('overview');
  const searchesBefore=await hostJs('window.fixtureCalls.filter(c=>c.action==="search").length');
  await submit('如何修改本体？');assert.match(await last(),/功能指引/);
  await submit('查看我有哪些本体');assert.match(await last(),/本体查询/);assert.match(await last(),/当前生效.*草稿.*历史版本/s);
  assert.equal(await js('document.querySelector("#view-overview").hidden'),false,'ontology query navigated without request');
  assert.equal(await hostJs('window.fixtureCalls.filter(c=>c.action==="search").length'),searchesBefore,'ontology query searched documents');
  assert.equal(await hostJs('window.sxOntologyFixture.db.writes.length'),0,'help/query created an edit session');
  for(const [question,answer] of [['如何设置模型',/模型设置.*配置/],['如何查看我有多少资料',/概览.*资料数量/],['如何查看本体？',/本体定义资料/],['如何搜索资料？',/搜索＋关键词/],['检索功能怎么用？',/原文.*资料库/],['如何导入资料？',/批量导入/],['如何创建星图？',/新建星图.*填写星图名称.*创建后直接进入资料库/],['如何修改原文？',/校对正文/],['不要修改本体，只解释一下',/本体定义/]]) {
    await submit(question);assert.match(await last(),answer);
    assert.equal(await js('document.querySelectorAll(".sx-turn:last-of-type [data-sx-link]").length'),1);
    assert.ok(await js('document.querySelector(".sx-turn:last-of-type .sx-answer > p").textContent.length')<100);
  }
  assert.equal(await hostJs('window.fixtureCalls.filter(c=>c.action==="search").length'),searchesBefore,'feature help unexpectedly searched materials');
  for(const [question,context] of [['如何设置模型','模型设置'],['如何查看我有多少资料','概览']]) {
    await submit(question);
    await js('document.querySelector(".sx-turn:last-of-type [data-sx-link]").click()');
    await until(()=>js('!document.querySelector(".starxiaotu-panel")'),Boolean,'feature link did not reveal '+context);
    await js('document.querySelector("[data-sx-toggle]").click()');
    assert.equal(await js('document.querySelector(".sx-current-context").textContent.split(" · ").at(-1)'),context);
  }
  await submit('搜索新增合同属性的设计文档');
  assert.equal(await hostJs('window.fixtureCalls.filter(c=>c.action==="search").at(-1).input.query'),'新增合同属性的设计文档');
  assert.equal(await hostJs('window.sxOntologyFixture.db.writes.length'),0,'search or negation created an ontology proposal');
  await submit('打开处理任务');
  await until(()=>js('document.querySelector("#crumb-current").textContent'),text=>text==='处理任务','task navigation failed');
  assert.match(await last(),/已打开对应页面/);
  await submit('带我去脱敏规则');
  await until(()=>js('document.querySelector("#crumb-current").textContent'),text=>text==='脱敏规则','sensitive navigation failed');
  assert.match(await last(),/已打开对应页面/);
  await submit('修改脱敏规则');
  assert.match(await last(),/脱敏规则用于/);
  assert.doesNotMatch(await last(),/模型设置/);
  assert.equal(await js('document.querySelector(".sx-turn:last-of-type [data-sx-link]").textContent'),'打开脱敏规则');
  await js('document.querySelector(".sx-turn:last-of-type [data-sx-link]").click()');
  await until(()=>js('!document.querySelector(".starxiaotu-panel")'),Boolean,'configuration link should reveal the settings');
  await go('overview');
  checks.push('project help and configuration entry navigate without saving; search subjects and negated edits never write');
  await submit('帮我看看合同');assert.match(await last(),/现有本体有合同类型[\s\S]*前往本体修改/);
  assert.equal(await hostJs('window.sxOntologyFixture.db.writes.length'),0,'ambiguous answers must not create an ontology proposal');
  await submit('带我去资料库');assert.match(await last(),/页面导航/);
  assert.equal(await js('document.querySelector("#view-conversation").hidden'),false);
  await submit('材料里有没有提到本体设计方法？');assert.match(await last(),/参考当前项目[\s\S]*当前项目的合成资料回答/);
  assert.ok(await hostJs('window.fixtureCalls.filter(c=>c.action==="search").length')>searchesBefore);
  checks.push('help, explicit navigation, ontology query, corpus retrieval and clarification follow distinct paths; queries do not mutate or navigate');
  await go('overview');
  await submit('给合同类型增加到期日期属性');
  assert.match(await last(),/本体修改指引[\s\S]*保存为草稿[\s\S]*前往本体修改/);
  assert.equal(await js('document.querySelectorAll("[data-sx-ontology], .sx-ontology-progress, [data-sx-start-ontology]").length'),0);
  const writesAfterAdvice=await hostJs('window.fixtureCalls.filter(c=>c.action==="workbench-request" && c.input.method!=="GET" && c.input.url.includes("ontolog")).length');
  assert.equal(writesAfterAdvice,0);
  await js('document.querySelector(".sx-turn:last-of-type [data-sx-link]").click()');
  const bench=await until(()=>win.webContents.mainFrame.framesInSubtree.find(f=>f.url.includes('/workbench/index.html')),Boolean,'ontology workbench did not open');
  const workbench=code=>bench.executeJavaScript(code);
  await until(()=>workbench('document.querySelector(".rules-workspace-tabs [aria-current=page]")?.textContent'),text=>text==='本体修改','shortcut did not open the edit module');
  assert.ok(await workbench('document.querySelector(".ontology-editor:not([hidden]) .ontology-list-heading button")'));
  assert.equal(await js('document.querySelector("#starxiaotu-panel")'),null);
  assert.equal(await hostJs('window.fixtureCalls.filter(c=>c.action==="workbench-request" && c.input.method!=="GET" && c.input.url.includes("ontolog")).length'),0);
  await openHelper();
  await input('保留在星小图的未发送内容');
  assert.match(await workbench('document.querySelector("[data-starxiaotu-term=ontology-version]").title'),/本体版本.*完整规则/);
  await hostJs('window.termAnswer=window.fixtureOverrides["starxiaotu-answer"];window.fixtureOverrides["starxiaotu-answer"]=input=>input.question==="什么是本体版本？"?new Promise(resolve=>{window.releaseTermAnswer=()=>resolve(window.termAnswer(input));}):window.termAnswer(input);void 0');
  await workbench('document.querySelector("[data-starxiaotu-term=ontology-version]").click()');
  await until(()=>hostJs('window.fixtureCalls.filter(c=>c.action==="starxiaotu-answer").at(-1)?.input.question'),question=>question==='什么是本体版本？','clicking the workbench glossary did not send a term');
  assert.match(await last(),/术语解释[\s\S]*完整规则[\s\S]*正在结合当前项目/);
  await hostJs('window.releaseTermAnswer();window.fixtureOverrides["starxiaotu-answer"]=window.termAnswer;void 0');
  await until(()=>js('!document.querySelector(".sx-send")?.disabled'),Boolean,'term answer did not settle');
  assert.match(await last(),/什么是本体版本？[\s\S]*参考当前项目[\s\S]*规则的快照/);
  await image('07-ontology-module-and-floating-helper');
  await workbench('document.querySelector(".ontology-editor h2").click()');
  assert.equal(await js('document.querySelector("#starxiaotu-panel")'),null);
  await openHelper();
  assert.equal(await js('document.querySelector("#starxiaotu-input").value'),'保留在星小图的未发送内容');
  await workbench('document.querySelector(".ontology-editor .ontology-list-heading button").click()');
  await until(()=>workbench('Boolean(document.querySelector(".ontology-type-page"))'),Boolean,'manual type editor did not open');
  await workbench('for (const [field,value] of [...document.querySelectorAll(".ontology-type-page .ontology-fields input")].slice(0,2).map((field,i)=>[field,["TEST_STAR_TYPE","验收手动实体"][i]])) { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(field,value); field.dispatchEvent(new Event("input",{bubbles:true})); }');
  await workbench('document.querySelector(".ontology-type-page footer .primary").click()');
  await until(()=>workbench('Boolean(document.querySelector(".ontology-editor:not([hidden]) [data-type-name=TEST_STAR_TYPE]"))'),Boolean,'the manual type was not added locally');
  const manualWrites=()=>hostJs('window.fixtureCalls.filter(c=>c.action==="workbench-request" && c.input.method==="POST" && c.input.url.includes("ontolog")).map(c=>c.input.url)');
  assert.deepEqual(await manualWrites(),[]);
  await workbench('document.querySelector(".ontology-draft-actions .primary").click()');
  await until(()=>workbench('document.querySelector(".ontology-draft-actions .primary")?.textContent'),text=>text==='核对并发布','the manual draft did not save');
  assert.deepEqual(await manualWrites(),['/api/ontologies']);
  await workbench('document.querySelector(".ontology-draft-actions .primary").click()');
  await until(()=>workbench('Boolean([...document.querySelectorAll("button")].find(button=>button.textContent==="确认发布整个版本" && !button.disabled))'),Boolean,'the publish review did not open');
  await workbench('window.confirm=()=>false;[...document.querySelectorAll("button")].find(button=>button.textContent==="确认发布整个版本").click()');
  assert.deepEqual(await manualWrites(),['/api/ontologies']);
  await workbench('window.confirm=()=>true;[...document.querySelectorAll("button")].find(button=>button.textContent==="确认发布整个版本").click()');
  await until(manualWrites,rows=>rows.length===2,'confirmed manual publish did not dispatch');
  assert.deepEqual(await manualWrites(),['/api/ontologies','/api/ontologies/sample-draft/publish']);
  await until(()=>workbench('document.querySelector(".rules-workspace-version .badge")?.textContent'),text=>text==='v2 · 生效','published version did not become effective');
  checks.push('manual ontology edits save separately and publish only after reviewing and confirming');
  await go('graph');
  await js('document.querySelector("#graph-types-label [data-starxiaotu-term]").click()');
  await until(()=>js('!document.querySelector(".sx-send")?.disabled'),Boolean,'main panel glossary did not finish');
  assert.match(await last(),/什么是(?:本体标签|实体类型)？/);
  checks.push('ontology edit becomes a read-only instruction and opens the separate module with zero writes; term stars inside and outside the workbench use current project; workbench clicks dismiss the float without losing its draft');
  await go('overview');
  await js('document.querySelector(".top-actions [data-action=help]").click()');
  assert.equal(await js('document.querySelector("#help-dialog").open'),true);
  assert.ok(await js('document.querySelectorAll(".term-row").length')>=25);
  assert.equal(await js('document.querySelector(".term-group[open] summary").textContent'),'星图与本体');
  const glossaryQuery=text=>js('(()=>{const field=document.querySelector("#starlink-glossary-search");field.value='+JSON.stringify(text)+';field.dispatchEvent(new Event("input",{bubbles:true}));})()');
  await glossaryQuery('不匹配的词汇');
  assert.equal(await js('document.querySelector("#starlink-glossary-empty").hidden'),false);
  await glossaryQuery('检索索引');
  assert.equal(await js('document.querySelector(".term-group[open] summary").textContent'),'检索与交付');
  assert.match(await js('document.querySelector(".term-row:not([hidden]) dd").textContent'),/正文片段.*查找目录/);
  await image('08-searchable-concept-glossary');
  await js('document.querySelector("#help-dialog [data-starxiaotu-term=search-index]").click()');
  await until(()=>js('!document.querySelector(".sx-send")?.disabled'),Boolean,'glossary did not hand off to Starxiaotu');
  assert.equal(await js('document.querySelector("#help-dialog").open'),false);
  assert.match(await last(),/什么是检索索引？[\s\S]*参考当前项目/);
  checks.push('concept help filters local definitions, displays them immediately, and hands off to the current project on click');
  assert.deepEqual(errors,[]);
  const result={passed:true,network:'HTTP(S) denied; synthetic authenticated bridge substitute',runtime,checks,geometry,errors,at:new Date().toISOString()};
  await writeFile(join(output,'result.json'),JSON.stringify(result,null,2));
  console.log('STARXIAOTU_BROWSER_PASS '+checks.length+' checks');clearTimeout(deadline);win.destroy();app.exit(0);
}).catch(async error=>{
  clearTimeout(deadline);await mkdir(output,{recursive:true});
  const diagnostic=win&&!win.isDestroyed()?await win.webContents.executeJavaScript('({calls:window.fixtureCalls?.slice(-20),frames:[...document.querySelectorAll("iframe")].map(f=>({url:f.src,text:f.contentDocument?.body.innerText.slice(-18000)}))})').catch(()=>null):null;
  if(win&&!win.isDestroyed())await image('failure').catch(()=>{});
  await writeFile(join(output,'failure.json'),JSON.stringify({message:error.message,stack:error.stack,errors,diagnostic},null,2));console.error(error);win?.destroy();app.exit(1);
});
