import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import ts from 'typescript';
import {loadCorrectionSegments} from '../src/sourceCorrection.ts';
import {SemanticaService} from '../../shell/service.mjs';

const warehouseId='10000000-0000-4000-8000-000000000001';
const version={id:'v1'};
test('342-source correction uses pagination accepted by the real desktop adapter',async()=>{
  const segments=Array.from({length:342},(_,i)=>({id:'s'+i,text:'source '+i}));
  const detail={document:{id:'doc',segment_count:342},version,segments:segments.slice(0,200)};
  const seen=[];
  const service=new SemanticaService({host:{onSessionInvalidated:()=>()=>{},request:async(path)=>{
    const url=new URL(path,'http://fixture');seen.push(url);
    const offset=Number(url.searchParams.get('segment_offset'));
    return new Response(JSON.stringify({...detail,segments:segments.slice(offset,offset+200)}));
  }}});
  const actual=await loadCorrectionSegments(detail,0,()=>true,url=>service.call('workbench-request',{warehouseId,url}));
  assert.equal(actual.length,342);assert.equal(seen.length,1);
  assert.equal(seen[0].searchParams.get('segment_limit'),'200');
  assert.equal(seen[0].searchParams.get('block_limit'),'1');
});

test('truncated Unicode text is reassembled by codepoint ranges without changing the preview',async()=>{
  const full='甲😀'.repeat(135000), points=Array.from(full);
  const segment={id:'s',text:'甲',text_truncated:true,full_text_chars:points.length,canonical_start:2,canonical_end:points.length+2};
  const detail={document:{id:'doc',segment_count:1},version,segments:[segment]};
  const requests=[];
  const result=await loadCorrectionSegments(detail,0,()=>true,async raw=>{
    const url=new URL(raw,'http://fixture'),start=Number(url.searchParams.get('start')),end=Number(url.searchParams.get('end'));
    requests.push({start,end});assert.ok(end-start<=65536);assert.equal(url.searchParams.get('version_id'),'v1');
    return{document_id:'doc',version_id:'v1',start,end,text:points.slice(start-2,end-2).join('')};
  });
  assert.equal(result[0].text,full);assert.equal(result[0].text_truncated,false);
  assert.equal(segment.text,'甲');assert.equal(requests.length,5);
});

test('incomplete text, missing range metadata and stale pages never enter correction',async()=>{
  const detail={document:{id:'doc',segment_count:1},version,segments:[{id:'s',text:'preview',text_truncated:true,full_text_chars:100}]};
  await assert.rejects(loadCorrectionSegments(detail,0,()=>true),/完整正文范围/);
  detail.segments[0]={...detail.segments[0],canonical_start:0,canonical_end:100};
  await assert.rejects(loadCorrectionSegments(detail,0,()=>true,async()=>({document_id:'doc',version_id:'v1',start:0,end:100,text:'short'})),/读取失败/);
  await assert.rejects(loadCorrectionSegments({...detail,segments:[],document:{id:'doc',segment_count:2}},0,()=>true,async()=>({...detail,version:{id:'changed'}})),/完整读取/);
  await assert.rejects(loadCorrectionSegments({...detail,segments:[{id:'s',text:'ok'}]},0,()=>false),/正文已变化/);
});

test('lost save response freezes the original edit; retry confirms it and refresh failure stays separate',async()=>{
  const source=await readFile(new URL('../src/main.tsx',import.meta.url),'utf8');
  const code=ts.transpileModule(source.slice(source.indexOf('  async function saveCorrection()'),source.indexOf('  const pageNames =')),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
  const calls=[];
  const h={detail:{document:{id:'doc',segment_count:1},version,segments:[{id:'s',text:'original'}]},saving:false,
    drafts:{s:'corrected'},correctionWrite:{current:null},crypto:{randomUUID},refresh:async()=>{throw Error('refresh failed')},
    requestJson:async(url,options)=>{calls.push({url,body:options.body});if(calls.length===1)throw Object.assign(Error('lost'),{status:0});return{document:{id:'doc'},version:{id:'v2'},segments:[{id:'s2',text:'corrected'}]}}};
  for(const key of ['Saving','Error','CorrectionPending','Detail','SelectedSegmentId','Editing','Drafts','Message'])h['set'+key]=value=>{h[key[0].toLowerCase()+key.slice(1)]=value};
  vm.createContext(h);vm.runInContext(code,h);
  await h.saveCorrection();assert.equal(h.correctionPending,true);
  h.drafts.s='must not replace uncertain submission';
  await h.saveCorrection();assert.equal(calls[0].body,calls[1].body);
  assert.equal(h.correctionPending,false);assert.equal(h.detail.version.id,'v2');
  assert.match(h.error,/已保存.*刷新失败/);
});
