import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createPersonalSpace} from '../shell/personal-space.mjs';

const hash = b => createHash('sha256').update(b).digest('hex');
const item = 'a'.repeat(32);
const pdf = Buffer.from('%PDF-1.7\nSynthetic preview\n%%EOF');
async function fixture(t, options = {}) {
  let state = {phase:'ready',account:{phase:'authenticated',accountId:'owner'},connection:{deviceId:'box'}};
  const listeners=new Set(), requests=[];
  const client={snapshot:()=>state,subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);},async applicationConnection(){
    const before=state;
    return {context(){if(before!==state)throw Error('NETWORK_CHANGED');},async request(r){
      requests.push(r); await options.before?.(r);
      let value;
      if(r.path.includes('/space-previews/')){
        if(r.path.includes('/content?'))return {status:200,headers:{'x-content-sha256':options.corrupt?'bad':hash(pdf)},body:pdf};
        value=r.method==='POST'||options.wait?{state:'processing'}:{state:'ready',size:pdf.length,digest:hash(pdf),sourceVersion:1};
      } else if(r.path.includes('/content?'))return {status:200,headers:{'x-content-sha256':hash(pdf)},body:pdf};
      else value={id:item,version:1,name:options.name||'示例.pptx',kind:'file',size:pdf.length,digest:hash(pdf)};
      return {status:200,headers:{},body:Buffer.from(JSON.stringify(value))};
    }};
  }};
  const service=await createPersonalSpace({client,store:{async load(){return[];},async save(){}},serviceURL:'https://account.test'});
  t.after(()=>service.close());
  return {service,requests,switch(){state={...state,account:{phase:'authenticated',accountId:'another'}};for(const fn of listeners)fn();}};
}

test('Office preview polls authenticated private routes and verifies converted PDF',async t=>{
  const f=await fixture(t);
  const result=await f.service.preview(item);
  assert.equal(result.converted,true);
  assert.equal(result.type,'application/pdf');
  assert.equal(Buffer.from(result.data,'base64').toString(),pdf.toString());
  assert.ok(f.requests.some(r=>r.method==='POST'&&r.path.includes('version=1')));
  assert.equal(f.requests.some(r=>r.method==='PUT'||r.method==='DELETE'),false);
});
test('corrupt preview bytes are rejected',async t=>{
  const f=await fixture(t,{corrupt:true});
  await assert.rejects(f.service.preview(item),{code:'SPACE_CHUNK_INVALID'});
});
test('closing preview stops polling and account switch discards late bytes',async t=>{
  const f=await fixture(t,{wait:true});
  const pending=f.service.preview(item);
  await new Promise(r=>setTimeout(r,50));f.service.cancelPreview();
  await assert.rejects(pending,{code:'SPACE_CONTEXT_CHANGED'});
  assert.equal(f.requests.filter(r=>r.path.includes('space-previews')).length,1);
  const g=await fixture(t,{before:async r=>{if(r.path.includes('/content?'))g.switch();}});
  await assert.rejects(g.service.preview(item),/CONTEXT_CHANGED|NETWORK_CHANGED/);
});
test('direct PDF uses verified original chunks without Office conversion',async t=>{
  const f=await fixture(t,{name:'原始.pdf'});
  const result=await f.service.preview(item);
  assert.equal(result.type,'application/pdf');
  assert.equal(f.requests.some(r=>r.path.includes('space-previews')),false);
});

test('unsupported archive formats go straight to the download fallback', async t => {
  const f = await fixture(t, { name: '记忆备份.sqlite.gz' });
  await assert.rejects(f.service.preview(item), { code: 'SPACE_PREVIEW_DOWNLOAD' });
  assert.equal(f.requests.some(r => r.path.includes('/content?') || r.path.includes('/space-previews/')), false);
});
