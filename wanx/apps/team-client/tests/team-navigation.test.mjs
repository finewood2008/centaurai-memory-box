import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {rendererEvents} from './support/renderer-events.mjs';
const index=new URL('../build/app/local-ui/renderer/index.html',import.meta.url),html=await readFile(index,'utf8');
const scripts=[...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map(m=>m[1]).filter(s=>s!=='./device-setup.bundle.js');
const source=(await Promise.all(scripts.map(s=>readFile(new URL(s,index),'utf8')))).join('\n');
const admin={permissions:['applications.manage'],displayName:'测试管理员'};
const connected={account:{phase:'authenticated',accountId:'alice',clientId:'one'},route:'applications',phase:'ready',canLaunchApplications:true,activeDeviceId:'box',connection:{deviceId:'box'},devices:[{deviceId:'box',displayName:'测试盒子',canOpen:true}],network:{enabled:true,phase:'ready'},applications:[]};
const flush=async()=>{for(let i=0;i<8;i++)await new Promise(r=>setImmediate(r))};
async function fixture(initial=connected){
 let state=initial,listener,navigate,identity=admin;
 const calls=[],events=rendererEvents(),app={innerHTML:'',querySelector:()=>null,addEventListener:(...v)=>events.add(...v)};
 const window={addEventListener(){},sessionStorage:{getItem:()=>null,setItem(){},removeItem(){}},wanxClient:{getLocalState:async()=>state,onLocalState:fn=>listener=fn,onNavigate:fn=>navigate=fn,action:async(name,input)=>{
  calls.push([name,input]);let value;
  if(name==='team.identity')value=await (typeof identity==='function'?identity():identity);
  else if(['team.catalog','team.members','team.projects','team.invites'].includes(name))value=[];
  else if(name==='market.list')value={items:[]};
  else if(name==='studio.overview')value={protocolVersion:2,modelAvailable:true,projects:[{id:'p1',name:'会议助手',goal:'整理行动项',stage:'discovery',label:'需求草稿',action:'继续讨论',updatedAt:1},{id:'p2',name:'学员助手',goal:'管理学员',stage:'discovery',label:'需求草稿',action:'继续讨论',updatedAt:2}]};
  else if(name==='studio.engines.list')value={defaultId:'codex',items:[{id:'codex',name:'Codex',enabled:true,adapted:true}]};
  else if(name==='studio.intake.open')value={context:{},catalog:{items:[]}};
  else if(name==='data.warehouses')value={items:[{id:'w1',name:'会议知识',state:'active',entity_count:0}]};
  else if(name==='data.interface')value={mcp:{endpoint:'http://box/mcp/starlink'}};
  else if(name.startsWith('data.'))value={items:[],nodes:[],edges:[]};
  return{ok:true,value};
 }}};
 vm.runInNewContext(source,{window,document:{body:{dataset:{},append(){}},createElement:()=>({dataset:{},setAttribute(){}}),addEventListener(){},querySelector:s=>s==='#app'?app:null},Date,URL,TextEncoder,crypto:globalThis.crypto,queueMicrotask,setTimeout:()=>0,clearTimeout(){},setInterval:()=>0,clearInterval(){},FormData:class{}});
 await flush();
 return{app,calls,identity:v=>{identity=v},update:v=>{state=v;listener(v)},navigate:v=>navigate(v),click:async(action,data={})=>{await events.get('click')({target:{closest:()=>({dataset:{action,...data}})}});await flush()},input:async(field,value)=>{await events.get('input')({target:{dataset:{intakeField:field},value,closest:()=>null}});await flush()}};
}
function stableNav(markup){const nav=markup.match(/<nav class="main-nav"[\s\S]*?<\/nav>/)?.[0]||'';assert.deepEqual([...nav.matchAll(/data-action="show-([^"]+)"/g)].map(m=>m[1]),['ai-dialogue','applications','construction','data','space','boxes']);assert.match(nav,/>开物<span class="feature-beta">Beta/);assert.doesNotMatch(nav,/>星图<span/)}
test('all six tabs remain before connecting, during failures, and for ordinary users',async()=>{
 const h=await fixture({...connected,phase:'disconnected',canLaunchApplications:false,connection:null,activeDeviceId:null});
 stableNav(h.app.innerHTML);await h.click('show-construction');assert.match(h.app.innerHTML,/连接盒子后开始使用/);
 for(const phase of ['connecting','recovering','unavailable']){h.update({...connected,phase,canLaunchApplications:false});await flush();stableNav(h.app.innerHTML);assert.match(h.app.innerHTML,/开物连接状态/)}
 assert.equal(h.calls.filter(([n])=>n.startsWith('studio.')||n.startsWith('data.')).length,0);
 h.identity({permissions:[]});h.update(connected);await flush();await h.click('show-data');stableNav(h.app.innerHTML);assert.match(h.app.innerHTML,/此功能仅管理员可用/);
 await h.click('studio-workspace');await h.click(undefined,{dataAction:'create'});assert.equal(h.calls.filter(([n])=>n.startsWith('studio.')||n.startsWith('data.')).length,0);
 for(const destination of ['studio-projects','workspace','environment','models','acp','connectors','skills'])h.navigate(destination);
 await flush();assert.equal(h.calls.filter(([n])=>n.startsWith('studio.')||n.startsWith('builder.')||n.startsWith('data.')).length,0);
});
test('project selection and intake text survive a disconnect; reads wait for renewed identity',async()=>{
 const h=await fixture();await h.click('show-construction');await h.click('studio-select',{projectId:'p1'});
 h.update({...connected,phase:'recovering',canLaunchApplications:false});await flush();stableNav(h.app.innerHTML);assert.match(h.app.innerHTML,/开物连接状态/);assert.doesNotMatch(h.app.innerHTML,/整理行动项/);
 let resolve;h.identity(()=>new Promise(r=>resolve=r));h.update(connected);await flush();assert.match(h.app.innerHTML,/正在核验管理员权限/);
 const count=h.calls.filter(([n])=>n.startsWith('studio.')).length;await h.click('studio-workspace');assert.equal(h.calls.filter(([n])=>n.startsWith('studio.')).length,count);
 resolve(admin);await flush();assert.match(h.app.innerHTML,/class="kaiwu-list-item active"[^>]*data-project-id="p1"/);
 h.identity(admin);await h.click('studio-workspace');await h.input('original','断线之前填写的会议助手需求');
 h.update({...connected,canLaunchApplications:false,phase:'disconnected',activeDeviceId:null,connection:null});await flush();assert.doesNotMatch(h.app.innerHTML,/断线之前填写/);
 h.update(connected);await flush();assert.match(h.app.innerHTML,/断线之前填写的会议助手需求/);
 assert.equal(h.calls.filter(([n])=>n==='studio.launch.start'||n==='studio.launch.configure'||n==='studio.launch.suggest').length,0);
});
test('Starlink keeps the warehouse and subpage after reconnect and clears business data on demotion',async()=>{
 const h=await fixture();await h.click('show-data');await h.click(undefined,{dataAction:'select',id:'w1'});await h.click(undefined,{dataAction:'tab',tab:'search'});
 assert.match(h.app.innerHTML,/data-data-form="search"/);
 h.update({...connected,canLaunchApplications:false,phase:'recovering'});await flush();stableNav(h.app.innerHTML);assert.match(h.app.innerHTML,/星图连接状态/);assert.doesNotMatch(h.app.innerHTML,/会议知识/);
 h.update({...connected,dataContextId:'renewed'});await flush();assert.match(h.app.innerHTML,/会议知识/);assert.match(h.app.innerHTML,/data-data-form="search"/);
 h.identity({permissions:[]});await h.click('team-feature-retry');await flush();stableNav(h.app.innerHTML);assert.match(h.app.innerHTML,/此功能仅管理员可用/);assert.doesNotMatch(h.app.innerHTML,/会议知识/);
 const count=h.calls.filter(([n])=>n.startsWith('data.')).length;await h.click(undefined,{dataAction:'refresh'});assert.equal(h.calls.filter(([n])=>n.startsWith('data.')).length,count);
});
