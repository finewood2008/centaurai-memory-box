import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {WebSocketServer} from 'ws';
import {createDashboardGateway} from '../octop/gateway.mjs';

const launchToken='L'.repeat(43);
async function fixture(t){
  const received=[];
  const upstream=http.createServer((request,response)=>{received.push({path:request.url,method:request.method,headers:request.headers});response.setHeader('content-type','application/json');response.end('{}')});
  const sockets=new Set();upstream.on('connection',socket=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket))});
  upstream.listen(0,'127.0.0.1');await once(upstream,'listening');
  const gateway=await createDashboardGateway({targetURL:'http://127.0.0.1:'+upstream.address().port,session:{getToken:()=> 'synthetic-native-bearer',onExpired:()=>()=>{},close(){}}});
  t.after(async()=>{await gateway.close();for(const socket of sockets)socket.destroy();await new Promise(resolve=>upstream.close(resolve))});
  return{gateway,received,upstream};
}

test('real HTTP gateway preserves a valid main-owned launch header on exact public expert routes',async t=>{
  const f=await fixture(t);
  for(const [path,method] of [['/api/wanx-expert-app/v1/context','GET'],['/api/wanx-expert-app/v1/invoke','POST']]){
    await f.gateway.request({path,method,headers:{'X-Wanx-Expert-Launch':launchToken}});
    assert.equal(f.received.at(-1).headers['x-wanx-expert-launch'],launchToken);
    assert.equal(f.received.at(-1).headers.authorization,'Bearer synthetic-native-bearer');
  }
});


test('gateway launch header cannot escape exact HTTP methods, routes or token syntax',async t=>{
  const f=await fixture(t);
  for(const [path,method,value] of [
    ['/api/app-studio/projects','GET',launchToken],['/api/wanx-expert-app/v1/context?x=1','GET',launchToken],
    ['/api/wanx-expert-app/v1/%63ontext','GET',launchToken],['/api/wanx-expert-app/v1/context/','GET',launchToken],
    ['/api/wanx-expert-app/v1/context','POST',launchToken],['/api/wanx-expert-app/v1/invoke','GET',launchToken],
    ['/api/wanx-expert-app/v1/context','GET','L'.repeat(42)],['/api/wanx-expert-app/v1/context','GET','L'.repeat(44)],
    ['/api/wanx-expert-app/v1/context','GET','L'.repeat(42)+'.'],
  ]){
    await f.gateway.request({path,method,headers:{'x-wanx-expert-launch':value}});
    assert.equal(f.received.at(-1).headers['x-wanx-expert-launch'],undefined);
  }
});

test('gateway WebSocket requests never carry the HTTP expert launch credential',async t=>{
  const f=await fixture(t),server=new WebSocketServer({server:f.upstream});t.after(()=>server.close());
  const connected=once(server,'connection');
  const socket=await f.gateway.openWebSocket({path:'/api/wanx-expert-app/v1/context',headers:{'x-wanx-expert-launch':launchToken}});
  const [,request]=await connected;assert.equal(request.headers['x-wanx-expert-launch'],undefined);
  socket.terminate();await once(socket,'close');
});
