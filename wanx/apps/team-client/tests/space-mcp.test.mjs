import test from 'node:test';import assert from 'node:assert/strict';import {createSpaceMcp} from '../shell/space-mcp.mjs';
const id='a'.repeat(32),gid='b'.repeat(32);
function fixture(){let bound='account-A:box-A',calls=[],copies=[],saved,lose=true;const state={};const connection={id,name:'工作助手',prefix:'prefix',status:'active',grants:[]};const bridge=createSpaceMcp({state,team:true,persist:async()=>saved=structuredClone(state),scope:()=>bound,assertScope:b=>{if(b!==bound)throw Error('SPACE_CONTEXT_CHANGED');},client:{snapshot:()=>({connection:{url:'http://100.98.0.5:8088/'}})},copyText:async s=>copies.push(s),remote:async(b,path,opt)=>{calls.push({b,path,opt});if(path==='/connections'&&lose){lose=false;throw Error('ACK_LOST');}return {value:path==='/connections'?connection:path.includes('/prompt')?{prompt:'仅导出可访问记忆'}:path.startsWith('?')?{connections:[connection],archives:[]}:{} };}});return {bridge,state,calls,copies,get saved(){return saved;},change:()=>bound='account-B:box-B'};}
test('server address, encrypted main-process key custody and same-request retry',async()=>{const f=fixture();await assert.rejects(f.bridge.manage('mcp-issue',{name:'工作助手'}),/ACK_LOST/);const secret=f.saved.spaceMcp[0].credential,op=f.saved.spaceMcp[0].operation_id;await f.bridge.manage('mcp-issue',{name:'工作助手'});const attempts=f.calls.filter(c=>c.path==='/connections');assert.equal(attempts[1].opt.body.credential,secret);assert.equal(attempts[1].opt.body.operation_id,op);const overview=await f.bridge.manage('mcp-state');assert.equal(overview.url,'http://100.98.0.5:8088/mcp/space');assert.ok(!JSON.stringify(overview).includes(secret));await f.bridge.manage('mcp-copy',{id,kind:'config'});const config=JSON.parse(f.copies[0]);assert.equal(config.mcpServers['wanx-space'].headers.Authorization,'Bearer '+secret);assert.equal(config.mcpServers['wanx-space'].url,overview.url);assert.ok(f.calls.every(c=>c.opt.prefix==='/api/_client/space-mcp'));});
test('generic grants, prompt copies, invalid paths, no cross-account key reuse',async()=>{const f=fixture();await assert.rejects(f.bridge.manage('mcp-issue',{name:'工作助手'}));await f.bridge.manage('mcp-issue',{name:'工作助手'});await f.bridge.manage('mcp-grant',{id,root:gid,domain:'personal'});assert.equal(f.calls.at(-1).opt.body.purpose,'reference');await f.bridge.manage('mcp-copy',{id,grant:gid,kind:'prompt'});assert.equal(f.copies[0],'仅导出可访问记忆');await assert.rejects(f.bridge.manage('mcp-archive',{id:'../outside'}));f.change();await assert.rejects(f.bridge.manage('mcp-copy',{id,kind:'key'}),/MCP_KEY_NOT_ON_THIS_CLIENT/);});


test('NetBird configuration copies a reachable loopback endpoint with the original scoped key',async()=>{
 const state={spaceMcp:[{scope:'owner',id,credential:'k'.repeat(43)}]},copies=[];
 const bridge=createSpaceMcp({state,persist:async()=>{},scope:()=> 'interaction',storageScope:()=> 'owner',assertScope:()=>{},client:{snapshot:()=>({connection:{mode:'netbird',url:'http://100.98.0.5:8088/'}})},resolveEndpoint:async()=> 'http://127.0.0.1:45123/mcp/space',copyText:async text=>copies.push(text),remote:async()=>({value:{connections:[{id,status:'active'}]}})});
 const overview=await bridge.manage('mcp-state');assert.equal(overview.localRelay,true);assert.equal(overview.url,'http://127.0.0.1:45123/mcp/space');
 await bridge.manage('mcp-copy',{id,kind:'config'});const config=JSON.parse(copies[0]).mcpServers['wanx-space'];
 assert.equal(config.url,overview.url);assert.equal(config.headers.Authorization,'Bearer '+'k'.repeat(43));
});


test('relay failure preserves management state and recovery is explicit',async()=>{
 const state={spaceMcp:[{scope:'owner',id,credential:'k'.repeat(43)}]},copies=[];let occupied=true,resets=0;
 const bridge=createSpaceMcp({state,persist:async()=>{},scope:()=> 'interaction',storageScope:()=> 'owner',assertScope:()=>{},client:{snapshot:()=>({connection:{mode:'netbird'}})},resolveEndpoint:async()=>{if(occupied)throw Object.assign(Error('MCP_PORT_IN_USE'),{code:'MCP_PORT_IN_USE'});return 'http://127.0.0.1:45124/mcp/space';},resetEndpoint:async()=>{resets++;occupied=false;return 'http://127.0.0.1:45124/mcp/space';},copyText:async text=>copies.push(text),remote:async()=>({value:{connections:[{id,status:'active'}]}})});
 const overview=await bridge.manage('mcp-state');
 assert.equal(overview.endpointError,'MCP_PORT_IN_USE');assert.equal(overview.url,null);assert.equal(overview.connections[0].localKey,true);assert.equal(resets,0);
 await bridge.manage('mcp-copy',{id,kind:'key'});assert.equal(copies[0],'k'.repeat(43));
 await assert.rejects(bridge.manage('mcp-copy',{id,kind:'config'}),/MCP_PORT_IN_USE/);
 assert.equal((await bridge.manage('mcp-reset-endpoint')).url,'http://127.0.0.1:45124/mcp/space');assert.equal(resets,1);
 assert.equal((await bridge.manage('mcp-state')).endpointError,null);
});

test('management never masks a scope change as an endpoint error',async()=>{
 let current='A';const bridge=createSpaceMcp({state:{},persist:async()=>{},scope:()=>current,assertScope:bound=>{if(bound!==current)throw Error('SPACE_CONTEXT_CHANGED');},client:{snapshot:()=>({connection:{mode:'netbird'}})},resolveEndpoint:async()=>{current='B';throw Error('MCP_TRANSPORT_UNAVAILABLE');},remote:async()=>({value:{connections:[]}})});
 await assert.rejects(bridge.manage('mcp-state'),/SPACE_CONTEXT_CHANGED/);
});
