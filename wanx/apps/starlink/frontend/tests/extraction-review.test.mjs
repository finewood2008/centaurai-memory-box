import assert from 'node:assert/strict';
import test from 'node:test';
import {readCurrentExtraction,readExtractionDetails,extractionCandidatePresentation,validReviewReference,sameReviewReference,rememberReviewDraft,rememberedReviewDraft} from '../src/extractionReview.ts';
import {correctionRequest,correctionUrl} from '../src/corrections.ts';
const ref={document_id:'material',document_version_id:'version',run_id:'current-run',knowledge_generation:null,processing_generation:3};
const current={review_reference:ref,status:'awaiting_review',entity_count:2,relation_count:3,requires_adoption:true,requires_publication_confirmation:true};

test('optional current extraction counts accept only nonnegative safe integers',async()=>{
  const previous=globalThis.fetch;let response=current;
  try{
    globalThis.fetch=async()=>Response.json(response);
    assert.deepEqual(await readCurrentExtraction('w','material',new AbortController().signal),current);
    for(const field of ['adoptable_entity_count','adoptable_relation_count','excluded_candidate_count']){
      for(const count of [0,2]){
        response={...current,[field]:count};
        assert.equal((await readCurrentExtraction('w','material',new AbortController().signal))[field],count);
      }
      for(const count of [-1,0.5,'1',null,true,Number.MAX_SAFE_INTEGER+1]){
        response={...current,[field]:count};
        await assert.rejects(readCurrentExtraction('w','material',new AbortController().signal),{code:'SEMANTICA_INVALID_RESPONSE'});
      }
    }
  }finally{globalThis.fetch=previous;}
});

test('material review counts are validated and separate from published counts',async()=>{
  const previous=globalThis.fetch;
  let counts={adoptable_entity_count:1,adoptable_relation_count:0,excluded_candidate_count:4};
  try{
    globalThis.fetch=async()=>Response.json({document_id:'material',document_version_id:'version',publication:null,
      extraction_review:{run_id:ref.run_id,issues:[],...counts}});
    const read=()=>readExtractionDetails('w',current,new AbortController().signal);
    const details=await read();
    assert.deepEqual(details.candidateCounts,counts);
    assert.equal(extractionCandidatePresentation(current,details).adoptable,1);
    for(const field of Object.keys(counts)){
      counts={[field]:-1};const invalid=await read();
      assert.equal(invalid.unavailable,true);assert.equal(invalid.candidateCounts,undefined);
    }
  }finally{globalThis.fetch=previous;}
});

test('partial exclusion shows all, adoptable and excluded counts without granting publication',()=>{
  const result=extractionCandidatePresentation({...current,adoptable_entity_count:1,adoptable_relation_count:2,excluded_candidate_count:2});
  assert.equal(result.counts,'本轮生成 5 个候选，其中 3 个可采纳、2 个未通过核验。');
  assert.equal(result.emptyMessage,null);assert.match(result.nextStep,/选择抽取候选/);
  assert.equal(Object.hasOwn(result,'ready_for_confirmation'),false);
});

test('zero extraction and fully excluded extraction have distinct empty states',()=>{
  const none=extractionCandidatePresentation({...current,entity_count:0,relation_count:0});
  assert.equal(none.emptyMessage,'本轮未抽取到候选，请检查材料正文和处理记录。');
  const excluded=extractionCandidatePresentation({...current,adoptable_entity_count:0,adoptable_relation_count:0,excluded_candidate_count:5});
  assert.equal(excluded.emptyMessage,'本轮候选均未通过证据或约束核验，暂无可采纳内容。请查看处理记录。');
  for(const result of [none,excluded])assert.doesNotMatch(result.nextStep,/选择|批量.*说明/);
});

test('legacy fallback uses only the unfiltered list total for emptiness and preserves unknown counts',()=>{
  const unknown=extractionCandidatePresentation(current);
  assert.equal(unknown.adoptable,null);assert.equal(unknown.emptyMessage,null);
  assert.match(unknown.counts,/可采纳数量暂不可用/);assert.match(unknown.nextStep,/数量暂不可用/);
  assert.match(extractionCandidatePresentation(current,null,0).emptyMessage,/均未通过/);
  const present=extractionCandidatePresentation(current,null,3);
  assert.equal(present.adoptable,null);assert.equal(present.emptyMessage,null);assert.match(present.nextStep,/选择抽取候选/);
  const explicit={...current,adoptable_entity_count:1,adoptable_relation_count:1};
  assert.equal(extractionCandidatePresentation(explicit,null,0).adoptable,2);
});
test('review reasons and the still-effective published baseline are read without any processing writes',async()=>{
  const previous=globalThis.fetch,calls=[];
  try{
    globalThis.fetch=async(url,init)=>{
      calls.push({url,init});
      assert.match(url,/\/conversations\/materials\//);
      return Response.json({document_id:'material',document_version_id:'version',extraction_review:{run_id:'current-run',reason_code:'EXTRACTION_COMPLETENESS_REVIEW',message:'覆盖完整性未确认',issues:[{batch_index:1,stage:'relations',reason:'NO_NEW_RESULTS',audit_rounds:2,message:'关系覆盖仍未确认'}],next_action:'review_candidates'},publication:{id:'published',document_version_id:'version',status:'published',entity_count:44,relation_count:25}});
    };
    const details=await readExtractionDetails('w',{review_reference:ref},new AbortController().signal);
    assert.deepEqual(details.publication,{id:'published',entity_count:44,relation_count:25});assert.equal(details.blockers[0].message,'覆盖完整性未确认');assert.equal(details.issues[0].reason,'NO_NEW_RESULTS');
    assert.ok(calls.every(c=>c.init.method===undefined&&c.init.body===undefined));assert.equal(calls.length,1);
    globalThis.fetch=async()=>Response.json({run:{id:'wrong'}});
    await assert.rejects(readExtractionDetails('w',{review_reference:ref},new AbortController().signal),{code:'CORRECTION_REVIEW_CHANGED'});
  }finally{globalThis.fetch=previous;}
});
test('review details do not infer missing reasons from raw model errors or switch to another candidate run',async()=>{
  const previous=globalThis.fetch;
  try{
    let workflow={document_id:'material',document_version_id:'version',publication:null};
    globalThis.fetch=async()=>Response.json(workflow);
    assert.deepEqual(await readExtractionDetails('w',{review_reference:ref},new AbortController().signal),{blockers:[],issues:[],publication:null,unavailable:true});
    workflow.publication={id:'baseline',status:'published',document_version_id:'version'};
    assert.deepEqual((await readExtractionDetails('w',{review_reference:ref},new AbortController().signal)).publication,{id:'baseline'});
    for(const extraction_review of [null,{run_id:'newer-run'}]){
      workflow={...workflow,extraction_review};
      await assert.rejects(readExtractionDetails('w',{review_reference:ref},new AbortController().signal),{code:'CORRECTION_REVIEW_CHANGED'});
    }
  }finally{globalThis.fetch=previous;}
});
test('current extraction locator is a lease-free read and rejects incomplete/foreign references',async()=>{
  const original=globalThis.fetch,calls=[];let response={review_reference:ref,status:'awaiting_review',entity_count:2,relation_count:1,requires_adoption:true,requires_publication_confirmation:true};
  try{
    globalThis.fetch=async(url,init)=>{calls.push({url,init});return new Response(JSON.stringify(response));};
    const value=await readCurrentExtraction('w','material',new AbortController().signal);
    assert.deepEqual(value.review_reference,ref);assert.equal(calls.length,1);assert.equal(calls[0].init.method,undefined);assert.equal(calls[0].init.headers,undefined);
    for(const bad of [{...ref,document_id:'other'},{...ref,processing_generation:true},{...ref,run_id:''},{...ref,extra:'field'},{document_id:'material'}])assert.equal(validReviewReference(bad,'material'),false);
    for(const field of Object.keys(ref))assert.equal(sameReviewReference(ref,{...ref,[field]:'changed'}),false);
    response={...response,requires_publication_confirmation:false};
    await assert.rejects(readCurrentExtraction('w','material',new AbortController().signal),{code:'SEMANTICA_INVALID_RESPONSE'});
  }finally{globalThis.fetch=original;}
});
test('explicit claim generation reaches reference-bound draft open without altering its reference',async()=>{
  const original=globalThis.fetch,calls=[],signal=new AbortController().signal;
  try{
    globalThis.fetch=async(url,init)=>{
      calls.push({url,init});
      return new Response(JSON.stringify(url.includes('/sessions?')?{editor_session:'current-review-session'}:{draft_id:'draft',revision:7,status:'editing',lease_generation:4,review_reference:ref}));
    };
    await correctionRequest(correctionUrl('review-w','review-d','/draft/claim'),signal,{operation_id:'claim',expected_revision:7});
    const body={operation_id:'open',review_reference:ref};
    await correctionRequest(correctionUrl('review-w','review-d','/current-extraction/draft'),signal,body);
    assert.equal(calls.at(-1).init.headers['X-Correction-Generation'],'4');
    assert.deepEqual(JSON.parse(calls.at(-1).init.body),body);
  }finally{globalThis.fetch=original;}
});
test('refresh hints contain only a scoped draft identifier, tolerate unavailable storage and reject forged paths',()=>{
  const previous=globalThis.sessionStorage,values=new Map();
  try{
    globalThis.sessionStorage={setItem:(k,v)=>values.set(k,v),getItem:k=>values.get(k)};
    rememberReviewDraft('w','d','saved-draft');assert.equal(rememberedReviewDraft('w','d'),'saved-draft');assert.equal(rememberedReviewDraft('other','d'),null);
    assert.deepEqual([...values.values()],['saved-draft']);rememberReviewDraft('w','d','../foreign');assert.equal(rememberedReviewDraft('w','d'),null);
    globalThis.sessionStorage={getItem:()=>{throw Error('blocked');},setItem:()=>{throw Error('blocked');}};
    assert.equal(rememberedReviewDraft('w','d'),null);rememberReviewDraft('w','d','safe');
  }finally{if(previous===undefined)delete globalThis.sessionStorage;else globalThis.sessionStorage=previous;}
});
