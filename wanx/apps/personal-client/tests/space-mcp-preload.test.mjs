import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';

test('trusted renderer can explicitly reset its MCP endpoint through the fixed preload action',async()=>{
 const exposed={},calls=[];
 vm.runInNewContext(await readFile(new URL('../local-ui/remote-preload.cjs',import.meta.url),'utf8'),{
  process:{platform:'darwin'},require:name=>{assert.equal(name,'electron');return {
   contextBridge:{exposeInMainWorld:(name,value)=>{exposed[name]=value;}},
   ipcRenderer:{on(){},removeListener(){},invoke:async(...args)=>{calls.push(args);return {url:'http://127.0.0.1:45124/mcp/space'};}},
  };},
 });
 const result=await exposed.wanxClient.action('space.links-mcp-reset-endpoint');
 assert.equal(result.ok,true);
 assert.ok(calls.some(([name])=>name==='wanx-client:space-links-mcp-reset-endpoint'));
 const before=calls.filter(([name])=>name!=='wanx-client:get-state').length;
 assert.equal((await exposed.wanxClient.action('space.links-mcp-arbitrary-route')).code,'UNKNOWN_CLIENT_ACTION');
 assert.equal(calls.filter(([name])=>name!=='wanx-client:get-state').length,before);
});
