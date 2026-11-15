import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const source=await readFile(new URL('../local-ui/renderer/space-agent-hub.js',import.meta.url),'utf8');
const tick=()=>new Promise(r=>setImmediate(r));
function setup(){
 const dialogs=[],calls=[],opened=[];let responder;
 const document={activeElement:null,body:{append(){}},addEventListener(){},createElement(){const listeners={},pane={scrollTop:0};const d={open:false,html:'',listeners,setAttribute(){},addEventListener(k,f){listeners[k]=f;},showModal(){this.open=true;},close(){this.open=false;listeners.close?.();},querySelector(selector){if(selector==='.mcp-agent-list')return {scrollTop:0,set innerHTML(v){const marker='<div class="mcp-agent-list" aria-label="Agent 接入列表">';const start=d.html.indexOf(marker)+marker.length,end=d.html.indexOf('</aside>',start);d.html=d.html.slice(0,start)+v+'</div>'+d.html.slice(end);}};return selector==='.space-mcp-body'?pane:{focus(){},setSelectionRange(){}};},set innerHTML(v){this.html=v;this.fullRenders=(this.fullRenders||0)+1;}};dialogs.push(d);return d;}};
 const data={url:'http://box/mcp/space',destination:'company',admin:true,connections:[entry('a','工作助手','Alice'),entry('b','同名助手','Bob',{canManageGrants:false,localKey:false,drive:{manageable:false}}),entry('c','已暂停助手','Carol',{status:'paused'}),entry('d','撤销助手','Dan',{status:'revoked'})]};
 const window={wanxWorkspaces:{openDrive:async(...v)=>opened.push(v)}};
 vm.runInNewContext(source,{window,document,setInterval:()=>1,clearInterval(){},console});
 const hub=window.createSpaceAgentHub({request:async(a,b)=>{calls.push([a,b]);if(responder){const value=await responder(a,b);if(value!==undefined)return value;}return a==='mcp-state'?data:{copied:true};}});
 const state=id=>({account:{accountId:id},activeDeviceId:'box',canLaunchApplications:true});hub.hostState(state('A'));
 const click=async(action,values={},n=0)=>{dialogs[n].listeners.click({preventDefault(){},target:{closest:()=>({dataset:{mcpAction:action,...values},disabled:false})}});await tick();};
 const input=(name,value,n=0)=>{if(name==='mcp-search')dialogs[n].html=dialogs[n].html.replace(/(name="mcp-search"[^>]*value=")[^"]*/,(_,prefix)=>prefix+value);dialogs[n].listeners.input({target:{name,value}});};
 return {hub,data,calls,dialogs,opened,state,click,input,respond:f=>responder=f,html:()=>dialogs[0].html,createHTML:()=>dialogs[1].html};
}
function entry(id,name,member,extra={}){return {id:id.repeat(32),name,prefix:'prefix'+id,status:'active',localKey:true,last_used:0,canManageGrants:true,grants:[],...extra,drive:{id:'disk-'+id,root:'root-'+id,name,member,domain:'company',manageable:true,directories:{memory:'memory-'+id},...extra.drive}};}
test('list/detail replaces navigation and dropdown, groups stopped entries and distinguishes first call',async()=>{
 const h=setup();await h.hub.open();assert.match(h.html(),/Agent 接入列表/);assert.match(h.html(),/已停用 · 1/);assert.match(h.html(),/已暂停助手/);assert.match(h.html(),/等待首次调用/);assert.match(h.html(),/Key 有效/);assert.match(h.html(),/Alice/);assert.doesNotMatch(h.html(),/mcp-connection|生成导入提示词|data-mcp-action="tab"|已连接/);
 assert.match(h.html(),/<footer class="mcp-server">[^]*http:\/\/box\/mcp\/space/);h.input('mcp-search','Bob');assert.doesNotMatch(h.html().split('</aside>')[0],/工作助手/);assert.match(h.html(),/同名助手/);h.input('mcp-search','不存在');assert.match(h.html(),/没有匹配的接入/);
});
test('one click copies directory-bound prompt, switching binds config, grants and file navigation to selected entry',async()=>{
 const h=setup();await h.hub.open();await h.click('copy-prompt');assert.deepEqual(JSON.parse(JSON.stringify(h.calls.at(-1))),['mcp-copy',{id:'a'.repeat(32),kind:'prompt'}]);assert.ok(!h.calls.some(([a])=>a==='mcp-prompt'));
 await h.click('select',{id:'b'.repeat(32)});assert.match(h.html(),/授权由此接入的所属成员管理/);assert.doesNotMatch(h.html(),/暂无额外授权/);assert.match(h.html(),/data-mcp-action="copy-key" disabled/);assert.match(h.html(),/Key 未保存在本机/);assert.doesNotMatch(h.html(),/data-mcp-action="pick"/);await h.click('open-memory');assert.deepEqual(h.opened,[['disk-b','memory-b']]);assert.equal(h.hub.isOpen,false);
});
test('creation uses 420px mini-dialog, failure retains name and retries original operation name',async()=>{
 const h=setup();await h.hub.open();await h.click('create');assert.ok(h.dialogs[1].open);assert.match(h.createHTML(),/name="mcp-create-name" maxlength="80" required/);assert.doesNotMatch(h.createHTML(),/<select|保存目录|Agent 品牌/);h.input('mcp-create-name','新助手',1);let attempts=0;h.respond((action)=>{if(action!=='mcp-issue')return;if(!attempts++)throw Error('NETWORK');const c=entry('e','新助手','Alice');h.data.connections.unshift(c);return c;});
 await h.click('issue',{},1);assert.match(h.createHTML(),/value="新助手"/);assert.match(h.createHTML(),/重试创建/);assert.ok(h.dialogs[1].open);await h.click('issue',{},1);const names=h.calls.filter(([a])=>a==='mcp-issue').map(([,b])=>b.name);assert.deepEqual(names,['新助手','新助手']);assert.equal(h.dialogs[1].open,false);assert.match(h.html(),/data-highlight="true"/);assert.match(h.html(),/新助手/);
});
test('rename and rotate use the same identity; refresh and search preserve selection',async()=>{
 const h=setup();await h.hub.open({id:'c'.repeat(32)});h.respond((a,b)=>{if(a==='mcp-manage'&&b.action==='rename')h.data.connections[2].name=b.name;});await h.click('more');await h.click('confirm-rename');h.input('mcp-rename','新名字');await h.click('rename');assert.match(h.html(),/新名字/);await h.click('confirm-rotate');assert.match(h.html(),/旧 Key 立即失效，原专属盘和文件保留/);await h.click('rotate');assert.equal(h.calls.find(([a])=>a==='mcp-rotate')[1].id,'c'.repeat(32));await h.click('refresh');await h.click('copy-url');assert.equal(h.calls.at(-1)[1].id,'c'.repeat(32));
});
test('account switch closes mini-dialog and ignores in-flight old creation result',async()=>{
 const h=setup();await h.hub.open();await h.click('create');h.input('mcp-create-name','旧账号',1);let resolve;h.respond(a=>a==='mcp-issue'?new Promise(r=>resolve=r):undefined);await h.click('issue',{},1);h.hub.hostState(h.state('B'));assert.equal(h.hub.isOpen,false);assert.equal(h.dialogs[1].open,false);resolve(entry('e','旧账号','Alice'));await tick();h.data.connections=[];await h.hub.open();assert.doesNotMatch(h.html(),/旧账号/);assert.match(h.html(),/创建第一个 Agent 接入/);
});
test('missing grants capability never claims an empty list; actual call is displayed only when recorded',async()=>{
 const h=setup();delete h.data.connections[0].canManageGrants;h.data.connections[0].last_used=1700000000;await h.hub.open();assert.match(h.html(),/盒子暂未提供授权权限信息/);assert.doesNotMatch(h.html(),/暂无额外授权/);assert.match(h.html(),/最近调用/);assert.doesNotMatch(h.html(),/等待首次调用/);
});
test('loading failure retains list and current selection, disabled mutations are also blocked by grants guard',async()=>{
 const h=setup();await h.hub.open({id:'b'.repeat(32)});h.respond(a=>{if(a==='mcp-state')throw Error('NETWORK');});await h.hub.refresh();assert.match(h.html(),/role="alert"/);assert.match(h.html(),/同名助手/);await h.click('grant');assert.ok(!h.calls.some(([a])=>a==='mcp-grant'));
});
test('narrow navigation uses list/detail state without discarding selected connection',async()=>{
 const h=setup();await h.hub.open();assert.doesNotMatch(h.html(),/space-mcp-layout show-detail/);await h.click('select',{id:'c'.repeat(32)});assert.match(h.html(),/space-mcp-layout show-detail/);await h.click('back');assert.doesNotMatch(h.html(),/space-mcp-layout show-detail/);assert.match(h.html(),/data-id="cccccccccccccccccccccccccccccccc" aria-pressed="true"/);
});

test('manual stopped-group expansion survives status refresh',async()=>{
 const h=setup();await h.hub.open();h.dialogs[0].listeners.toggle({target:{matches:s=>s==='.mcp-disabled',isConnected:true,open:true}});await h.hub.refresh();assert.match(h.html(),/<details class="mcp-disabled" open>/);h.dialogs[0].listeners.toggle({target:{matches:()=>true,isConnected:true,open:false}});await h.hub.refresh();assert.doesNotMatch(h.html(),/<details class="mcp-disabled" open>/);
});

test('Chinese search composition is not interrupted by rerendering the input',async()=>{
 const h=setup();await h.hub.open();const before=h.dialogs[0].fullRenders;h.dialogs[0].listeners.compositionstart({target:{name:'mcp-search'}});h.input('mcp-search','工作');assert.equal(h.dialogs[0].fullRenders,before);h.dialogs[0].listeners.compositionend({target:{name:'mcp-search',value:'工作助手'}});assert.equal(h.dialogs[0].fullRenders,before);assert.doesNotMatch(h.html().split('</aside>')[0],/同名助手/);
});

test('acknowledged creation remains selected and copyable when the following refresh fails',async()=>{
 const h=setup();await h.hub.open();await h.click('create');h.input('mcp-create-name','已创建接入',1);let issued=false;h.respond(a=>{if(a==='mcp-issue'){issued=true;return entry('e','已创建接入','Alice');}if(a==='mcp-state'&&issued)throw Error('NETWORK');});await h.click('issue',{},1);assert.equal(h.dialogs[1].open,false);assert.match(h.html(),/<h3>已创建接入<\/h3>/);assert.match(h.html(),/role="alert"/);assert.doesNotMatch(h.html(),/data-mcp-action="copy-config" disabled/);await h.click('copy-prompt');assert.equal(h.calls.at(-1)[1].id,'e'.repeat(32));
});

test('revocation wins over an older in-flight overview even without a local key',async()=>{
 const h=setup();h.data.connections[0].localKey=false;await h.hub.open();
 let resolveOld,read=0;h.respond((action)=>{
  if(action==='mcp-state'&&!read++)return new Promise(r=>resolveOld=r);
  if(action==='mcp-revoke')h.data.connections[0]={...h.data.connections[0],status:'revoked',grants:[],localKey:false};
 });
 const stale=structuredClone(h.data),pending=h.hub.refresh();await tick();
 await h.click('confirm-revoke');assert.match(h.html(),/撤销接入？/);await h.click('revoke');
 resolveOld(stale);await pending;
 assert.match(h.html(),/接入配置 <span[^>]*>已撤销/);
 assert.doesNotMatch(h.html(),/data-mcp-action="confirm-revoke"/);
 assert.equal(h.calls.filter(([a])=>a==='mcp-revoke').length,1);
});
test('acknowledged revocation stays revoked when overview refresh fails',async()=>{
 const h=setup();await h.hub.open();h.respond(action=>{if(action==='mcp-state')throw Error('NETWORK');if(action==='mcp-revoke')return {disconnected:true};});
 await h.click('confirm-revoke');await h.click('revoke');
 assert.match(h.html(),/接入配置 <span[^>]*>已撤销/);assert.match(h.html(),/role="alert"/);
 assert.doesNotMatch(h.html(),/data-mcp-action="copy-prompt" >|data-mcp-action="copy-config"  /);
});
test('grant revocation targets selected grant and survives a failed refresh without disabling own drive',async()=>{
 const h=setup();h.data.connections[0].grants=[{id:'f'.repeat(32),name:'资料目录',domain:'personal',permission:'write'}];await h.hub.open();
 h.respond(action=>{if(action==='mcp-state')throw Error('NETWORK');if(action==='mcp-revoke-grant')return {revoked:true};});
 await h.click('revoke-grant',{grant:'f'.repeat(32)});
 assert.deepEqual(JSON.parse(JSON.stringify(h.calls.find(([a])=>a==='mcp-revoke-grant'))),['mcp-revoke-grant',{id:'a'.repeat(32),grant:'f'.repeat(32)}]);
 assert.doesNotMatch(h.html(),/资料目录/);assert.match(h.html(),/接入配置 <span[^>]*>Key 有效/);
});
test('rejected revocation keeps the active connection and shows no success message',async()=>{
 const h=setup();await h.hub.open();h.respond(action=>{if(action==='mcp-revoke')throw Error('MCP_DRIVE_READ_ONLY');});await h.click('confirm-revoke');await h.click('revoke');
 assert.match(h.html(),/role="alert"/);assert.match(h.html(),/接入配置 <span[^>]*>Key 有效/);assert.doesNotMatch(h.html(),/接入已撤销，/);
});


test('NetBird relay explicitly tells the user to keep MemoBox connected',async()=>{
 const h=setup();h.data.localRelay=true;h.data.url='http://127.0.0.1:45123/mcp/space';await h.hub.open();
 assert.match(h.html(),/本机 MCP 入口 · 保持记忆盒子连接/);assert.match(h.html(),/经盒子连接连接盒子/);
});


test('occupied relay keeps management usable and requires explicit address reset confirmation',async()=>{
 const h=setup();h.data.localRelay=true;h.data.url=null;h.data.endpointError='MCP_PORT_IN_USE';await h.hub.open();
 assert.match(h.html(),/本机 MCP 端口被其他程序占用/);assert.match(h.html(),/工作助手/);
 assert.match(h.html(),/data-mcp-action="copy-config" disabled/);assert.doesNotMatch(h.html(),/data-mcp-action="copy-key" disabled/);
 assert.ok(!h.calls.some(([a])=>a==='mcp-reset-endpoint'));
 await h.click('confirm-reset-endpoint');assert.match(h.html(),/已有 Agent 的连接会中断/);assert.match(h.html(),/重新复制配置/);
 assert.ok(!h.calls.some(([a])=>a==='mcp-reset-endpoint'));
 h.respond(action=>{if(action==='mcp-reset-endpoint'){h.data.url='http://127.0.0.1:45124/mcp/space';h.data.endpointError=null;return {url:h.data.url};}});
 await h.click('reset-endpoint');assert.equal(h.calls.filter(([a])=>a==='mcp-reset-endpoint').length,1);
 assert.match(h.html(),/45124/);assert.match(h.html(),/本机地址已更新/);assert.doesNotMatch(h.html(),/data-mcp-action="copy-config" disabled/);
});

test('address recovery is available even when no Agent entries exist',async()=>{
 const h=setup();h.data.localRelay=true;h.data.endpointError='MCP_PORT_IN_USE';h.data.url=null;h.data.connections=[];await h.hub.open();
 await h.click('confirm-reset-endpoint');assert.match(h.html(),/重新生成本机地址？/);assert.match(h.html(),/data-mcp-action="reset-endpoint"/);
 await h.click('cancel-confirm');assert.doesNotMatch(h.html(),/重新生成本机地址？/);
});
