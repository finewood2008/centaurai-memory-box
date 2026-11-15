import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { needsBundledStarlink } from '../integration/bundled-starlink-version.mjs';

const bundle=fileURLToPath(new URL('../../team-client/applications/starlink/',import.meta.url));
const wid='11111111-1111-1111-1111-111111111111';
for(const edition of ['personal-client','team-client']) {
 test(`${edition}: builtin upgrade and Host restart retain versions and profile bytes`,async t=>{
  const {createApplicationManager}=await import(`../../${edition}/applications/manager.mjs`);
  const root=await mkdtemp(path.join(os.tmpdir(),'starlink-host-integration-'));
  const applicationRoot=path.join(root,'applications');
  let manager;
  t.after(async()=>{await manager?.close();await rm(root,{recursive:true,force:true});});
  const start=()=>createApplicationManager({applicationRoot,applicationId:'test-host',
   context:()=>({boxId:'synthetic-box',connection:'ready'}),
   spawn(_file,_args,options){
    const child=Object.assign(new EventEmitter(),{pid:1});
    child.kill=()=>{child.emit('exit',0);return true;};child.send=()=>{};
    queueMicrotask(()=>child.emit('message',{type:'wanx:application-ready',launchId:options.env.WANX_HOST_LAUNCH_ID}));
    return child;
   }});
  manager=await start();
  const manifest=JSON.parse(await readFile(path.join(bundle,'application.manifest.json'),'utf8'));
  const old=await manager.install({sourceDir:bundle,manifest:{...manifest,version:'0.3.6-rc.20261105.onboarding.2'}});
  const profile=path.join(root,'application-data',manifest.applicationId);
  await mkdir(profile,{recursive:true});
  const files={'original.fixture':'retained original','version-1.fixture':'historical text','version-2.fixture':'current text'};
  for(const [name,bytes] of Object.entries(files))await writeFile(path.join(profile,name),bytes);
  await manager.launch(manifest.applicationId);
  assert.equal(await needsBundledStarlink(old,bundle,manager),false,'running app is protected');
  await manager.close();manager=await start();
  assert.equal(await needsBundledStarlink(old,bundle,manager),true);
  const current=await manager.install({sourceDir:bundle,manifest});
  assert.equal((await manager.launch(manifest.applicationId)).state,'running');
  await manager.close();manager=await start();
  assert.equal((await manager.listInstalled()).find(x=>x.applicationId===manifest.applicationId).version,manifest.version);
  assert.equal((await manager.launch(manifest.applicationId)).state,'running');
  assert.notEqual(old.installPath,current.installPath);
  assert.equal(await readFile(path.join(old.installPath,'shell/main.mjs'),'utf8'),await readFile(path.join(bundle,'shell/main.mjs'),'utf8'));
  for(const [name,bytes] of Object.entries(files))assert.equal(await readFile(path.join(profile,name),'utf8'),bytes);
 });

 test(`${edition}: notification replay survives tunnel idle expiry and active graph request`,async t=>{
  const {createTunnelAgent}=await import(`../../${edition}/network/tunnel.mjs`);
  const {collectStarlinkNotifications}=await import(`../../${edition}/shell/starlink-notifications.mjs`);
  let broken=false,state={},seen=[];const sockets=new Set();
  const upstream=http.createServer(async(req,res)=>{
   const url=new URL(req.url,'http://fixture');
   assert.equal(req.headers.authorization,undefined,'proxy credential stays out of upstream');
   let body;
   if(url.pathname.endsWith('/warehouses'))body={items:[{id:wid,state:'active'}]};
   else if(url.pathname.endsWith('/processing'))body={effective:{mode:'automatic',signature:'same-config',...(broken?{blocked_reason:'MODEL_DEFAULT_UNAVAILABLE'}:{}),extraction:{available:!broken}}};
   else if(url.pathname.endsWith('/graph')){await delay(4300);body={nodes:[{id:'synthetic-node'}]};}
   else body={feed_id:'test-feed',items:Number(url.searchParams.get('after'))===0?[{sequence:1,job_id:'test-job',kind:'knowledge_extract',failed_at:'2026-10-31T00:00:00Z'}]:[],next_cursor:1,has_more:false};
   res.setHeader('content-type','application/json');res.end(JSON.stringify(body));
  });
  const track=socket=>{sockets.add(socket);socket.on('error',()=>{});socket.once('close',()=>sockets.delete(socket));return socket;};
  upstream.on('connection',track);upstream.keepAliveTimeout=5000;
  upstream.listen(0,'127.0.0.1');await once(upstream,'listening');
  const proxy=http.createServer();proxy.on('connection',track);
  proxy.on('connect',(req,downstream,head)=>{
   assert.equal(req.headers.authorization,'Bearer synthetic-proxy');
   const target=track(net.connect(upstream.address().port,'127.0.0.1',()=>{
    downstream.write('HTTP/1.1 200 Connection Established\r\n\r\n');if(head.length)target.write(head);target.pipe(downstream);downstream.pipe(target);
   }));
   downstream.once('close',()=>target.destroy());target.once('close',()=>downstream.destroy());
  });
  proxy.listen(0,'127.0.0.1');await once(proxy,'listening');
  const base='http://starlink.test:8088',agent=createTunnelAgent({url:base,proxy:{port:proxy.address().port,token:'synthetic-proxy'}});
  t.after(async()=>{agent.destroy();for(const s of sockets)s.destroy();await Promise.all([new Promise(r=>proxy.close(r)),new Promise(r=>upstream.close(r))]);});
  const request=({path,headers})=>new Promise((resolve,reject)=>{
   const req=http.get(base+path,{agent,headers},res=>{const chunks=[];res.on('data',x=>chunks.push(x));res.on('end',()=>resolve({status:res.statusCode,body:Buffer.concat(chunks)}));res.on('error',reject);});req.on('error',reject);
  });
  const poll=()=>collectStarlinkNotifications({request,dataScope:edition==='personal-client'?'personal':'team',deviceId:'synthetic-box',deviceName:'Test',state:structuredClone(state),save:async next=>{state=structuredClone(next);},isCurrent:()=>true,collect:item=>seen.push(item)});
  await poll();assert.deepEqual(seen.map(x=>x.title),['星图知识抽取失败']);
  const graph=await request({path:'/api/semantica/graph'});assert.equal(JSON.parse(graph.body).nodes.length,1);
  await delay(4300);await poll();assert.equal(seen.length,1,'no false outage or duplicate after idle/replay');
  broken=true;await poll();await poll();assert.deepEqual(seen.map(x=>x.title),['星图知识抽取失败','星图默认模型不可用']);
  broken=false;await poll();broken=true;await poll();assert.equal(seen.length,3,'new failure after recovery is delivered');
 });
}
