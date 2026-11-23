import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {SemanticaService} from '../shell/service.mjs';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const json = body => new Response(JSON.stringify(body),{headers:{'content-type':'application/json'}});
function fixture(data = Buffer.alloc(4 * 1024 * 1024 + 93, 0x61)) {
  const entry={id:'a'.repeat(32),name:'合成资料.txt',kind:'file',size:data.length,digest:sha(data),modified:12,trashed:null};
  let invalidate;
  const f={entry,data,offset:0,chunks:[],begins:[],commits:0,reads:0,failChunk:false,failCommit:false};
  const host={context:async()=>({boxId:'test-box',user:{id:7},connection:'ready'}),onSessionInvalidated:fn=>(invalidate=fn,()=>{}),close(){},
    drive:{overview:async()=>({protocolVersion:1}),list:async()=>({parent:'',breadcrumbs:[],items:[entry]}),stat:async()=>({...entry}),read:async function*(){f.reads++;for(let i=0;i<data.length;i+=4*1024*1024)yield data.subarray(i,i+4*1024*1024);}},
    request:async(endpoint,{body,method}={})=>{
      if(endpoint.endsWith('/imports')){f.begins.push(body);return json({upload_handle:'b'.repeat(32),offset:f.offset});}
      if(method==='PATCH'){
        assert.equal(body.offset,f.offset);
        const chunk=Buffer.from(body.content_base64,'base64');assert(chunk.length<=1024*1024);
        f.chunks.push(chunk);f.offset+=chunk.length;
        if(f.failChunk){f.failChunk=false;throw new Error('lost chunk response');}
        return json({offset:f.offset});
      }
      if(endpoint.endsWith('/commit')){f.commits++;if(f.failCommit)throw new Error('lost commit');return json({document:{id:'test-document'}});}
      if(endpoint.includes('/operations/'))return json({status:'committed',document:{id:'test-document'}});
      throw new Error('Unexpected request '+endpoint);
    }};
  f.host=host;f.revoke=()=>invalidate();f.service=new SemanticaService({host});
  f.service.context={boxId:'test-box',user:{id:7}};
  f.select=()=>f.service.call('select-space-files',{warehouseId:'warehouse-a',entries:[{id:entry.id,digest:entry.digest}]});
  f.upload=handle=>f.service.call('upload',{warehouseId:'warehouse-a',handle});
  return f;
}
test('selecting the same Space revision for review cannot recycle or release a pending batch handle', async () => {
  const f = fixture(Buffer.from('测试同一份资料的两种导入入口'));
  try {
    const [batch] = await f.select();
    const input = {warehouseId:'warehouse-a',entries:[{id:f.entry.id,digest:f.entry.digest}],selectionMode:'conversation'};
    const [review] = await f.service.call('select-space-files',input);
    assert.notEqual(review.handle,batch.handle);
    const [staged] = await f.service.call('select-space-files',input);
    assert.equal(staged.handle,review.handle);
    await f.service.call('release-files',{warehouseId:'warehouse-a',handles:[review.handle]});
    assert.equal((await f.select())[0].handle,batch.handle);
    assert.equal((await f.upload(batch.handle)).document.id,'test-document');
    assert.equal(f.commits,1);
  } finally { f.service.close(); }
});
test('WANX Space streams bounded chunks and retries from the acknowledged offset with stable provenance',async()=>{
  const f=fixture();
  try{
    const [selected]=await f.select();assert.equal(selected.path,undefined);
    f.failChunk=true;await assert.rejects(f.upload(selected.handle));assert.equal(f.offset,1024*1024);
    f.failCommit=true;assert.equal((await f.upload(selected.handle)).document.id,'test-document');
    assert.deepEqual(f.begins[0],f.begins[1]);assert.match(f.begins[0].external_document_id,/^wanx-space:[a-f0-9]{64}:[a-f0-9]{32}:[a-f0-9]{64}:[a-f0-9-]{36}$/);
    assert.equal(f.begins[0].source_review_required,true);
    assert.equal(f.begins[0].sha256,f.entry.digest);assert.deepEqual(Buffer.concat(f.chunks),f.data);
    assert.equal(f.commits,1);await f.upload(selected.handle);assert.equal(f.commits,1);
  }finally{f.service.close();}
});
test('selection deduplicates entries and cannot cross warehouses; releasing allows reselection',async()=>{
  const f=fixture();try{
    const [a]=await f.select(),[b]=await f.select();assert.equal(a.handle,b.handle);assert.equal(f.service.files.size,1);
    await assert.rejects(f.service.call('upload',{warehouseId:'warehouse-b',handle:a.handle}),{code:'SEMANTICA_FILE_SELECTION_EXPIRED'});
    await f.service.call('release-files',{warehouseId:'warehouse-b',handles:[a.handle]});assert(f.service.files.has(a.handle));
    await f.service.call('release-files',{warehouseId:'warehouse-a',handles:[a.handle]});assert.equal(f.service.files.size,0);
    const [c]=await f.select();assert.notEqual(c.handle,a.handle);
  }finally{f.service.close();}
});
test('file listing explains unsupported, empty, and oversized files and never exposes physical paths',async()=>{
 const f=fixture();try{
  f.service.capabilities={accepted_suffixes:['.txt'],document_max_bytes:100};
  f.host.drive.list=async()=>({parent:'',breadcrumbs:[],items:[
   {...f.entry,name:'program.exe',path:'/private/file'}, {...f.entry,name:'empty.txt',size:0},
   {...f.entry,name:'large.txt'}, {...f.entry,name:'folder',kind:'folder'}, {...f.entry,trashed:123},
  ]});
  const result=await f.service.call('space-list');assert.equal(result.items.length,4);
  assert.deepEqual(result.items.map(e=>e.problem),['SEMANTICA_FORMAT_NOT_SUPPORTED','SPACE_EMPTY_FILE','SEMANTICA_FILE_TOO_LARGE',null]);
  assert(!JSON.stringify(result).includes('/private/file'));
 }finally{f.service.close();}
});
test('changed/deleted/trashed sources are rejected before starting an import',async()=>{
 const f=fixture();try{
  await assert.rejects(f.service.call('select-space-files',{warehouseId:'warehouse-a',entries:[{id:f.entry.id,digest:'0'.repeat(64)}]}),{code:'SPACE_REMOTE_FILE_CHANGED'});
  const [file]=await f.select();f.entry.trashed=123;
  await assert.rejects(f.upload(file.handle),{code:'SPACE_REMOTE_FILE_CHANGED'});assert.equal(f.begins.length,0);
  f.entry.trashed=null;f.entry.modified++;
  await assert.rejects(f.upload(file.handle),{code:'SPACE_REMOTE_FILE_CHANGED'});
  f.host.drive.stat=async()=>{throw Object.assign(new Error(),{code:'SPACE_NOT_FOUND'});};
  await assert.rejects(f.upload(file.handle),{code:'SPACE_NOT_FOUND'});
 }finally{f.service.close();}
});
test('changed contents after selection and corrupt reads cannot reach commit, including a full-offset retry',async()=>{
 const f=fixture();try{
  const [file]=await f.select();
  f.host.drive.read=async function*(){yield Buffer.alloc(f.data.length,0x62);};
  await assert.rejects(f.upload(file.handle),{code:'SPACE_REMOTE_FILE_CHANGED'});assert.equal(f.commits,0);
  assert.equal(f.offset,f.data.length);
  await assert.rejects(f.upload(file.handle),{code:'SPACE_REMOTE_FILE_CHANGED'});assert.equal(f.commits,0);
 }finally{f.service.close();}
});
test('account/device invalidation cancels the read and cannot commit or retain old handles',async()=>{
 const f=fixture();try{
  const [file]=await f.select();let signal;
  f.host.drive.read=async function*(_,options){signal=options.signal;yield f.data.subarray(0,1024*1024);f.revoke();yield f.data.subarray(1024*1024);};
  await assert.rejects(f.upload(file.handle),{code:'HOST_SESSION_EXPIRED'});
  assert.equal(signal.aborted,true);assert.equal(f.commits,0);assert.equal(f.service.files.size,0);
 }finally{f.service.close();}
});
test('late directory and selection responses are rejected after session invalidation',async()=>{
 for(const action of ['list','stat']){
  const f=fixture();try{
   let resolve;f.host.drive[action]=()=>new Promise(r=>resolve=r);
   const pending=action==='list'?f.service.call('space-list'):f.select();
   while(!resolve) await new Promise(r=>setImmediate(r));
   f.revoke();resolve(action==='list'?{parent:'',breadcrumbs:[],items:[f.entry]}:f.entry);
   await assert.rejects(pending,{code:'HOST_SESSION_EXPIRED'});assert.equal(f.service.files.size,0);
  }finally{f.service.close();}
 }
});
test('old Host without Space support fails only Space operations',async()=>{
 const f=fixture();try{delete f.host.drive;await assert.rejects(f.service.call('space-list'),{code:'SPACE_UPGRADE_REQUIRED'});assert.equal(f.service.invalid,false);}finally{f.service.close();}
});

test('resuming from a non-aligned offset reconstructs exactly the source bytes',async()=>{
 const f=fixture();try{
  f.offset=257*1024+7;f.chunks=[f.data.subarray(0,f.offset)];
  const [file]=await f.select();await f.upload(file.handle);
  assert.equal(f.offset,f.data.length);assert.deepEqual(Buffer.concat(f.chunks),f.data);assert.equal(f.commits,1);
 }finally{f.service.close();}
});
test('rename during transfer is detected after the final chunk and blocks commit',async()=>{
 const f=fixture();try{
  const [file]=await f.select();
  f.host.drive.read=async function*(){yield f.data;f.entry.name='changed.txt';};
  await assert.rejects(f.upload(file.handle),{code:'SPACE_REMOTE_FILE_CHANGED'});assert.equal(f.commits,0);
 }finally{f.service.close();}
});
test('a missing Space capability is retryable without disabling the knowledge session',async()=>{
 const f=fixture();try{
  f.host.drive.overview=async()=>{throw Object.assign(new Error(),{code:'SPACE_UPGRADE_REQUIRED'});};
  await assert.rejects(f.service.call('space-list'),{code:'SPACE_UPGRADE_REQUIRED'});assert.equal(f.service.invalid,false);
  f.host.drive.overview=async()=>({protocolVersion:1});assert.equal((await f.service.call('space-list')).items.length,1);
 }finally{f.service.close();}
});
