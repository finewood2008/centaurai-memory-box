import test from 'node:test';
import assert from 'node:assert/strict';
import {createDriveRouting} from '../shell/space-drive-routing.mjs';
const sid='a'.repeat(32),root='b'.repeat(32),aid='c'.repeat(32),fid='d'.repeat(32),up='e'.repeat(32);
test('company disk routes listing, learned file, binary and resumed upload to private authority',async()=>{
  const calls=[];
  const r=createDriveRouting({scope:()=> 'A:box',catalog:async()=>[{id:sid,root,connection_id:aid}],send:async(a,action,p)=>{
    calls.push({a,action,p});
    if(action==='list')return {items:[{id:fid}],space_id:sid};
    if(action==='read')return {data:Buffer.from('image').toString('base64'),info:{digest:'digest',version:1},chunkDigest:'chunk'};
    return {id:up};
  }});
  await r.route(`/files?space_id=${sid}&parent=${root}`);
  assert.equal(calls[0].a,aid);
  assert.equal(calls[0].action,'list');
  assert.equal((await r.route(`/files/${fid}`)).handled,true);
  const raw=await r.route(`/files/${fid}/content?offset=0&length=200`,{raw:true});
  assert.equal(raw.value.bytes.toString(),'image');
  await r.route('/uploads',{method:'POST',body:{id:up,parent:root,space_id:sid,name:'test.png',size:3}});
  await r.route(`/uploads/${up}?offset=0`,{method:'PUT',body:Buffer.from('abc'),headers:{'x-content-sha256':'sha'}});
  assert.deepEqual(calls.at(-1).p,{id:up,offset:0,trash:false,data:'YWJj',digest:'sha'});
  const resumed=createDriveRouting({scope:()=> 'A:box',catalog:async()=>[{id:sid,root,connection_id:aid}],send:async(...args)=>{calls.push(args);return {};}});
  await resumed.route(`/uploads/${up}`,{spaceId:sid});
  assert.equal(calls.at(-1)[0],aid);
  assert.equal((await resumed.route('/files?space_id=personal&parent=')).handled,false);
});
test('account switch discards targets and rejects late results; unknown disk fails closed',async()=>{
  let scope='A',release;
  const r=createDriveRouting({scope:()=>scope,catalog:async()=>scope==='A'?[{id:sid,root,connection_id:aid}]:[],send:()=>new Promise(resolve=>release=resolve)});
  const p=r.route(`/files?space_id=${sid}&parent=${root}`);
  await new Promise(resolve=>setImmediate(resolve));scope='B';release({items:[{id:fid}]});
  await assert.rejects(p,/SPACE_CONTEXT_CHANGED/);
  await assert.rejects(r.route(`/files?space_id=${sid}`),/MCP_DRIVE_NOT_READY/);
  assert.equal((await r.route(`/files/${fid}`)).handled,false);
});
test('a disk text edit keeps the file ID distinct from its upload ID', async () => {
  const calls = [];
  const routing = createDriveRouting({
    scope: () => 'A:box',
    catalog: async () => [{ id: sid, root, connection_id: aid }],
    send: async (connection, action, params) => {
      calls.push({ connection, action, params });
      return { id: action === 'edit-create' ? up : fid };
    },
  });
  const digest = 'f'.repeat(64);
  await routing.route(`/files/${fid}/edit-uploads`, {
    spaceId: sid, method: 'POST', body: { id: up, expected: 2, size: 3, digest },
  });
  assert.deepEqual(calls[0], {
    connection: aid,
    action: 'edit-create',
    params: { id: fid, upload_id: up, expected: 2, size: 3, digest, trash: false },
  });
  await routing.route(`/uploads/${up}/complete`, { spaceId: sid, method: 'POST', body: { digest } });
  assert.equal(calls[1].connection, aid);
  assert.equal(calls[1].action, 'upload-complete');
  assert.equal(calls[1].params.id, up);
});
