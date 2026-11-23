import test from 'node:test';
import assert from 'node:assert/strict';
import {starxiaotuNeedle,starxiaotuRecords,starxiaotuOverview,starxiaotuSearchFailure,revealStarxiaotuRecord} from '../ui/starxiaotu-records.mjs';
import {normalizeStarxiaotuResults,canAutoLocateStarxiaotu,createStarxiaotuStore,starxiaotuIcon} from '../ui/starxiaotu.mjs';

const snapshot = {
  graph:{nodes:[
    {id:'person-1',name:'小林',type:'PERSON'},
    {id:'person-2',name:'小林',type:'PERSON'},
    {id:'site-1',name:'官网改版',type:'PROJECT'},
  ],edges:[{id:'owns-1',s:'person-1',t:'site-1',label:'负责',evidence:[{document_id:'minutes-1'}]}]},
  documents:[{id:'minutes-1',original_name:'会议纪要.txt'}],
};
const record = (id='person-1') => ({id:'entity:'+id,title:'小林',excerpt:'真实记录',target:{view:'knowledge',kind:'entity',recordId:id}});

test('lookup strips a quoted record name with trailing punctuation',()=>{
  assert.equal(starxiaotuNeedle('请定位「官网改版」。'),'官网改版');
  assert.equal(starxiaotuNeedle('帮我打开记录：site-1'),'site-1');
  assert.equal(starxiaotuRecords(snapshot,'请定位「官网改版」。').results[0].target.recordId,'site-1');
});

test('resolved intent keywords retain action words that are part of a material subject',()=>{
  const graph={nodes:[{id:'algorithm',name:'搜索算法',type:'TOPIC'},{id:'other',name:'算法',type:'TOPIC'}],edges:[]};
  const result=starxiaotuRecords({graph,resolvedQuery:true},'搜索算法');
  assert.deepEqual(result.results.map(item=>item.target.recordId),['algorithm']);
});

test('same-name records keep separate IDs and cannot prove uniqueness from bounded graph data',()=>{
  const result=starxiaotuRecords(snapshot,'定位小林');
  assert.deepEqual(result.results.filter(item=>item.target.kind==='entity').map(item=>item.target.recordId),['person-1','person-2']);
  assert.equal(result.complete,false);
});

test('an exact known resource ID identifies its record without a name ambiguity',()=>{
  const result=starxiaotuRecords(snapshot,'定位 person-2');
  assert.equal(result.complete,true);
  assert.equal(result.results.length,1);
  assert.equal(result.results[0].target.recordId,'person-2');
  assert.equal(canAutoLocateStarxiaotu(normalizeStarxiaotuResults(result).results,true),true);
});

test('ID collisions across entity and relation kinds require selection',()=>{
  const graph={nodes:[{id:'shared',name:'实体',type:'PERSON'}],edges:[{id:'shared',s:'shared',t:'shared',label:'自指',evidence:[]}]};
  const result=starxiaotuRecords({graph},'定位 shared');
  assert.equal(result.complete,false);
  assert.equal(result.results.length,2);
});

test('relation matches preserve the actual relation ID and readable endpoints',()=>{
  const result=starxiaotuRecords(snapshot,'负责');
  assert.equal(result.results.length,1);
  assert.equal(result.results[0].title,'小林 → 负责 → 官网改版');
  assert.deepEqual(result.results[0].target,{view:'graph',kind:'relation',recordId:'owns-1'});
  assert.equal(result.complete,false);
});

test('search items retain text and pinned document-version-segment references',()=>{
  const result=starxiaotuRecords(snapshot,'未加载的关键词',{items:[{
    document_id:'minutes-1',document_version_id:'version-2',text:'小林负责官网改版。',
    locator:JSON.stringify({canonical_start:24,source_segments:[{segment_id:'segment-2'}]}),
  }]});
  assert.equal(result.results[0].title,'会议纪要.txt');
  assert.equal(result.results[0].excerpt,'小林负责官网改版。');
  assert.deepEqual(result.results[0].target,{view:'conversation',kind:'document',documentId:'minutes-1',versionId:'version-2',segmentId:'segment-2',start:24});
  assert.equal(result.complete,false);
});

test('legacy results shape supports evidence without inventing absent version data',()=>{
  const result=starxiaotuRecords(snapshot,'关键词',{results:[{document_id:'minutes-1',excerpt:'原文摘录'}]});
  assert.equal(result.results.length,1);
  assert.deepEqual(result.results[0].target,{view:'conversation',kind:'document',documentId:'minutes-1'});
});

test('unusable document identifiers are ignored and malformed optional references are omitted',()=>{
  const result=starxiaotuRecords(snapshot,'关键词',{items:[
    {document_id:'../../private',text:'不可导航'},
    {document_id:'minutes-1',document_version_id:'unsafe/version',segment_id:'bad#segment',locator:'invalid json',text:'可打开文档'},
    {document_id:'minutes-2'},
  ]});
  assert.equal(result.results.length,1);
  assert.deepEqual(result.results[0].target,{view:'conversation',kind:'document',documentId:'minutes-1'});
});

test('duplicate evidence does not create duplicate candidate buttons and remote work is capped',()=>{
  const hit={document_id:'minutes-1',version_id:'v1',segment_id:'s1',text:'原文'};
  assert.equal(starxiaotuRecords(snapshot,'关键词',{items:[hit,{...hit}]}).results.length,1);
  const hits=Array.from({length:30},(_,index)=>({document_id:'doc-'+index,text:'原文'+index}));
  assert.equal(starxiaotuRecords(snapshot,'关键词',{items:hits}).results.length,10);
});

test('empty lookup never treats all loaded records as a match',()=>{
  assert.deepEqual(starxiaotuRecords(snapshot,'').results,[]);
  assert.equal(starxiaotuRecords(snapshot,'未匹配').complete,false);
});

test('overview uses real counts, separates bounded references and keeps source IDs',()=>{
  const result=starxiaotuOverview({...snapshot,warehouse:{name:'当前项目',document_count:15,entity_count:400,relation_count:39}});
  assert.match(result.answer,/资料 15 份.*实体 400 个.*关系 39 条/s);
  assert.match(result.answer,/项目统计与资料列表/);
  assert.equal(result.results[0].title,'会议纪要.txt');
  assert.deepEqual(result.results[0].target,{view:'conversation',kind:'document',documentId:'minutes-1'});
  assert.equal(result.complete,false);
  assert.match(starxiaotuOverview({warehouse:{name:'空项目'}}).answer,/数量暂未确认/);
});

test('index and embedding failures show actionable public reasons and preserve degraded-result notices',()=>{
  for(const [code,match,view] of [
    ['SEMANTICA_INDEX_REQUIRED',/建立检索索引/,'conversation'],['SEMANTICA_INDEX_STALE',/尚未同步/,'conversation'],
    ['SEMANTICA_EMBEDDING_NOT_CONFIGURED',/检索向量模型/,'models'],['WAREHOUSE_CHANGED',/项目已切换/,'conversation'],
  ]){const failure=starxiaotuSearchFailure({code});assert.match(failure.answer,match);assert.equal(failure.code,code);assert.equal(failure.links[0].target.view,view);}
  const failure=starxiaotuSearchFailure({message:'private traceback or credential',code:'untrusted<script>'});
  assert.equal(failure.code,'');assert.doesNotMatch(failure.answer,/private|credential|script/);
  const normalized=normalizeStarxiaotuResults({results:[record()],message:'索引未就绪，仅展示已加载记录',errorCode:'SEMANTICA_INDEX_REQUIRED'});
  assert.match(normalized.notice,/仅展示已加载/);assert.equal(normalized.errorCode,'SEMANTICA_INDEX_REQUIRED');
});

test('automatic location requires one record and complete search results',()=>{
  assert.equal(canAutoLocateStarxiaotu([record()],false),false);
  assert.equal(canAutoLocateStarxiaotu([record(),record('person-2')],true),false);
  assert.equal(canAutoLocateStarxiaotu([],true),false);
  assert.equal(canAutoLocateStarxiaotu([{target:{view:'conversation',documentId:'minutes-1'}}],true),false);
  assert.equal(canAutoLocateStarxiaotu([record()],true),true);
});

test('result normalization deduplicates references and refuses unsupported page targets',()=>{
  const result=normalizeStarxiaotuResults({results:[record(),record(),{...record(),id:'unsafe',target:{view:'external',recordId:'person-1'}}],complete:false});
  assert.equal(result.results.length,1);
  assert.equal(result.complete,false);
});

test('normalization keeps source offset for the existing pinned-source reader',()=>{
  const result=normalizeStarxiaotuResults({results:[{id:'source',title:'原文',target:{view:'conversation',kind:'document',documentId:'minutes-1',versionId:'v1',segmentId:'s1',start:24}}],complete:false});
  assert.equal(result.results[0].target.start,24);
});

test('project sessions retain their own conversation and draft during an asynchronous project switch',async()=>{
  const store=createStarxiaotuStore(),a=store.session('account/box/project-a');
  a.draft='未发送草稿';a.turns.push({ask:'项目A的问题'});const sequence=++a.sequence;
  let release;
  const pending=new Promise(resolve=>{release=resolve;}).then(()=>{
    if(store.isCurrent('account/box/project-a',a,sequence))a.turns.push({answer:'项目A的迟到结果'});
  });
  const b=store.session('account/box/project-b');b.draft='项目B草稿';release();await pending;
  assert.equal(b.turns.length,0);assert.equal(b.draft,'项目B草稿');
  assert.equal(store.session('account/box/project-a'),a);
  assert.equal(a.draft,'未发送草稿');assert.equal(a.turns.at(-1).answer,'项目A的迟到结果');
});

test('authentication invalidation rejects a retired session even when its key is reused',()=>{
  const store=createStarxiaotuStore(),retired=store.session('account/box/project-a');
  const sequence=++retired.sequence;store.clear();const fresh=store.session('account/box/project-a');
  assert.notEqual(fresh,retired);assert.equal(store.isCurrent('account/box/project-a',retired,sequence),false);
  assert.equal(fresh.draft,'');assert.deepEqual(fresh.turns,[]);
});

test('superseding a request rejects its previous sequence',()=>{
  const store=createStarxiaotuStore(),session=store.session('project');
  const sequence=++session.sequence;session.sequence++;
  assert.equal(store.isCurrent('project',session,sequence),false);
});

test('a missing record cannot report that it has been revealed',async()=>{
  assert.equal(await revealStarxiaotuRecord(null),false);
  assert.equal(await revealStarxiaotuRecord({isConnected:false}),false);
});

test('the shared AI marker contains a three-spark shape without adding title text',()=>{
  assert.match(starxiaotuIcon,/aria-hidden="true"/);
  assert.match(starxiaotuIcon,/class="sx-sparkles"/);
  assert.equal((starxiaotuIcon.match(/<svg/g)||[]).length,1);
  assert.doesNotMatch(starxiaotuIcon,/<text|<title/);
});
