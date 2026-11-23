import test from 'node:test';
import assert from 'node:assert/strict';
import {ConversationFlow} from '../ui/conversation-state.mjs';
import {conversationRequest} from '../shared/conversation-contract.mjs';
import {referenceUserInstruction} from '../ui/material-evidence.mjs';
import {evidenceHelpHTML,evidencePickerHTML,evidenceReferenceHTML} from '../ui/material-evidence-view.mjs';
import {factDiffHTML} from '../ui/material-fact-cards.mjs';
import {changeHistory} from '../ui/conversation-changes-view.mjs';
import {instructionPanel} from '../ui/material-instructions-view.mjs';
import {changeConflictsHTML} from '../ui/material-change-conflicts.mjs';
const editor={session:'s'.repeat(30),generation:'1'},digest='a'.repeat(64);
function fixture(){
  const storage=new Map(),calls=[],db={revision:1,text:'第😀页：名称为研发文档。',sourceId:'segment',stale:false};let seq=0;
  const item={id:'fact',kind:'entity',payload:{name:'研发名称',type:'FEATURE',properties:{}},evidence:[{segment_id:'segment',start:0,end:2,excerpt:'第😀'}]};
  const flow=new ConversationFlow({warehouseId:'w',identity:{user:{id:1}},storage:{getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v)},uuid:()=>`op-${++seq}`,call:async(action,input)=>{
    const request=conversationRequest(action,input);assert.ok(request);calls.push({action,input:structuredClone(input)});
    if(action==='conversation-change-draft')return {id:'draft',revision:db.revision,status:'editing',stale_reason:db.stale?'source_changed':null,counts:{entity:1,relation:0}};
    if(action==='conversation-change-items')return {items:[item],revision:db.revision,total:1,offset:0};
    if(action==='conversation-change-sources')return {revision:db.revision,offset:input.offset,limit:input.limit,total:1,items:[{segment_id:'segment',ordinal:0,text:db.text,start:0,end:[...db.text].length,total_chars:[...db.text].length}]};
    if(action==='conversation-change-source'){
      if(db.fail)throw Object.assign(Error('read failed'),{code:'SEMANTICA_CONNECTION_FAILED',status:503});
      const start=input.start||0,text=[...db.text].slice(start,start+2000).join('');
      return {segment_id:db.sourceId,text,start,end:start+[...text].length,total_chars:[...db.text].length};
    }
    if(action==='conversation-change-context')return {context_digest:digest,recent_proposals:[]};
    if(action==='conversation-change-generate')return {id:'proposal',status:'prepared',instruction:input.instruction,result:{questions:[],changes:[{scope:'facts',item_id:'fact',before:item,after:{...item,payload:{...item.payload,type:'DOCUMENT'}}}]}};
    throw Error('Unexpected '+action);
  }});
  flow.saved.conversationId='c';Object.assign(flow.state,{loaded:true,selectedIntent:'i',detail:{id:'i',document_id:'doc',document_version_id:'v',source_status:'available',status:'awaiting_review'},overview:{id:'c',revision:1}});flow.snapshot=async()=>{};
  flow.changes.bind();flow.changes.owner={documentId:'doc',draftId:'draft',editor};flow.changes.state.summary={id:'draft',revision:1,status:'editing',stale_reason:null};flow.changes.state.items={revision:1,items:[item]};flow.changes.state.selected=['fact'];flow.changes.record.changeTarget='facts';
  return {flow,db,calls,storage,item};
}
test('source paging is a bounded private read using the existing Bridge correction route',()=>{
  const input={warehouseId:'w',documentId:'doc',draftId:'draft',operationId:'op',editor,revision:3,offset:10,limit:10};
  const request=conversationRequest('conversation-change-sources',input);
  assert.equal(request.path,'/warehouses/w/workbench/_correction_read');assert.equal(request.body.path,'/api/documents/doc/corrections/draft/sources');assert.deepEqual(request.body.query,{revision:'3',offset:'10',limit:'10'});assert.equal(request.body.operation_id,undefined);
  for(const bad of [{editor:undefined},{revision:0},{limit:51},{workspace_id:'foreign'}])assert.throws(()=>conversationRequest('conversation-change-sources',{...input,...bad}));
});
test('source selection reads the current draft, translates emoji offsets and does not save or publish',async()=>{
  const h=fixture(),f=h.flow;f.state.input='请核对名称';await f.evidence.open();await f.evidence.read(0);assert.equal(f.state.error,'');
  assert.match(evidencePickerHTML(f),/readonly/);assert.doesNotMatch(evidencePickerHTML(f),/segment|segment_id/);
  const start=h.db.text.indexOf('研发文档');f.evidence.quote(start,start+4);
  assert.equal(f.evidence.reference.quote,'研发文档');assert.equal(f.evidence.reference.start,[...h.db.text.slice(0,start)].length);assert.equal(f.evidence.reference.end-f.evidence.reference.start,4);
  assert.match(f.state.input,/请核对名称.*\n参考当前材料原文/);assert.match(evidenceReferenceHTML(f),/待服务端核对/);assert.equal(f.evidence.state,null);
  assert.equal(h.calls.some(c=>/generate|apply|publish|save$/.test(c.action)),false);
  const instruction=await f.evidence.instruction(f.state.input);assert.match(instruction,/'?segment_id/);assert.equal(referenceUserInstruction(instruction),f.state.input);
  assert.doesNotMatch([...h.storage.values()].join(''),/ssssssssssssssssssss|_native_editor/);
});
test('quotes are verified again and only sent as context for an unapplied proposal',async()=>{
  const h=fixture(),f=h.flow;await f.evidence.open();await f.evidence.read(0);f.evidence.quote(0,4);
  await f.changes.generate(f.state.input,{composerInput:f.state.input});assert.equal(f.state.error,'');
  const request=h.calls.find(c=>c.action==='conversation-change-generate');assert.ok(request);assert.match(request.input.instruction,/不能声称已保存证据/);assert.deepEqual(request.input.selectedItemIds,['fact']);assert.equal(f.evidence.reference,null);
  assert.doesNotMatch(changeHistory(f).match(/<p class="cv-change-instruction">(.*?)<\/p>/s)[1],/segment_id|用户选取的原文参考位置/);assert.equal(h.calls.some(c=>/apply|publish|save$/.test(c.action)),false);
});
test('stale revisions, different source IDs and failed reads cannot retain a quote as current evidence',async()=>{
  for(const mode of ['revision','source','failed']){
    const h=fixture(),f=h.flow;await f.evidence.open();await f.evidence.read(0);
    if(mode==='revision')h.db.revision++;if(mode==='source')h.db.sourceId='foreign';if(mode==='failed')h.db.fail=true;
    await f.evidence.read(0);assert.ok(f.state.error);assert.equal(f.evidence.state?.source||null,null);assert.equal(f.evidence.reference??null,null);
    assert.equal(h.calls.some(c=>/generate|apply|publish|save$/.test(c.action)),false);
  }
});
test('no selection, oversized quotes and partial surrogate selections do not create reference context',async()=>{
  const h=fixture(),f=h.flow;h.db.text='😀'+'字'.repeat(550);await f.evidence.open();await f.evidence.read(0);
  for(const [start,end] of [[0,0],[0,1],[1,2],[2,550]]){f.evidence.quote(start,end);assert.equal(f.evidence.reference??null,null);}
  assert.match(f.state.inputNotice,/500/);assert.equal(f.state.input,'');
  f.evidence.quote(0,2);assert.equal(f.evidence.reference.quote,'😀');assert.equal(f.evidence.reference.end,1);
});
test('a source/version change or a different selection invalidates reference context before generation',async()=>{
  const h=fixture(),f=h.flow;await f.evidence.open();await f.evidence.read(0);f.evidence.quote(0,4);
  f.state.detail.document_version_id='new';await assert.rejects(f.evidence.instruction('调整名称'),{code:'CORRECTION_REVISION_CONFLICT'});f.state.detail.document_version_id='v';
  h.db.text='已变化的内容';await assert.rejects(f.evidence.instruction('调整名称'),{code:'MODELING_SOURCE_CHANGED'});
  f.changes.clearSelection();assert.equal(f.evidence.reference,null);assert.equal(f.evidence.state,null);
});
test('classification presentation separates model rationale, existing citations and unprovided attributes',()=>{
  const h=fixture(),before=h.item,after={...before,payload:{...before.payload,type:'DOCUMENT'}};
  const schema={entity_types:[{name:'FEATURE',label:'功能'},{name:'DOCUMENT',label:'文档',properties:[{name:'doc_type',label:'文档类型'},{name:'title',label:'标题'}]}]};
  const change={scope:'facts',item_id:'fact',before,after,before_type_label:'功能模块',after_type_label:'文档',reason:'用户希望将该对象归为文档 <script>',reason_kind:'model_explanation',evidence_scope:'object_source_not_classification_proof',source_evidence:[{document_id:'doc',document_version_id:'v',segment_id:'segment',start:0,end:2,excerpt:'原文'}]};
  const html=factDiffHTML(change,{schema,documentId:'doc',documentVersionId:'v'});
  assert.match(html,/功能模块.*文档/s);assert.match(html,/名称保持不变/);assert.match(html,/原文引用保持不变/);assert.match(html,/未提供的属性保持空缺：文档类型、标题/);assert.match(html,/调整理由（助手建议）/);assert.match(html,/对象的原文引用/);assert.doesNotMatch(html,/<script>/);
  const foreign=factDiffHTML(change,{schema,documentId:'other',documentVersionId:'v'});assert.doesNotMatch(foreign,/<blockquote>原文/);
  const supplemented=factDiffHTML({...change,reason_kind:'user_supplement',source_evidence:[]},{schema});assert.match(supplemented,/用户补充说明（不是原文引用）/);assert.doesNotMatch(supplemented,/对象的原文引用/);
});
test('missing object citations are disclosed and empty source metadata never claims evidence was preserved',()=>{
  const h=fixture(),before={...h.item,evidence:[]},after={...before,payload:{...before.payload,type:'DOCUMENT'}};
  const html=factDiffHTML({scope:'facts',item_id:'fact',before,after,source_evidence:[]},{schema:{entity_types:[]}});
  assert.match(html,/当前没有原文引用/);assert.doesNotMatch(html,/原文引用保持不变/);
  assert.match(evidenceHelpHTML(h.flow,{questions:true}),/仅调整分类，重新建议/);
});
test('long source windows retain Unicode quote offsets and a scope change clears the reference',async()=>{
  const h=fixture(),f=h.flow;h.db.text='字'.repeat(2000)+'😀研发文档';await f.evidence.open();await f.evidence.read(0);
  assert.equal(f.evidence.state.source.end,2000);await f.evidence.window('next');assert.equal(f.state.error,'');assert.equal(f.evidence.state.source.start,2000);
  f.evidence.quote(2,6);assert.equal(f.evidence.reference.quote,'研发文档');assert.equal(f.evidence.reference.start,2001);assert.equal(f.evidence.reference.end,2005);
  assert.match(await f.evidence.instruction('请参考这段修正名称'),/"start":2001/);
  f.changes.setTarget('rules');assert.equal(f.evidence.reference,null);assert.equal(f.evidence.state,null);assert.equal(h.calls.some(c=>/generate|apply|publish|save$/.test(c.action)),false);
});
test('legacy partial diffs do not assert that unseen names, citations or attributes are unchanged',()=>{
  const html=factDiffHTML({scope:'facts',item_id:'fact',before:{type:'FEATURE'},after:{type:'DOCUMENT'}},{schema:{entity_types:[{name:'FEATURE',label:'功能'},{name:'DOCUMENT',label:'文档',properties:[{name:'title',label:'标题'}]}]}});
  assert.match(html,/分类调整/);assert.doesNotMatch(html,/名称保持不变|原文引用保持不变|当前没有原文引用|未提供的属性保持空缺/);
});
test('replacing the composer cannot send an invisible earlier source reference',async()=>{
  const h=fixture(),f=h.flow;await f.evidence.open();await f.evidence.read(0);f.evidence.quote(0,3);
  f.state.input='只调整分类，不引用之前那段原文';
  assert.equal(await f.evidence.instruction(f.state.input),f.state.input);assert.equal(f.evidence.reference,null);
});
test('cancel and replacement remove only the generated quote and preserve the user request',async()=>{
  const h=fixture(),f=h.flow;f.state.input='请修正名称';await f.evidence.open();await f.evidence.read(0);f.evidence.quote(0,3);
  const previous=f.evidence.reference.quote;await f.evidence.open();await f.evidence.read(0);
  const start=h.db.text.indexOf('研发文档');f.evidence.quote(start,start+4);
  assert.doesNotMatch(f.state.input,new RegExp(`参考当前材料原文：“${previous}”`));assert.match(f.state.input,/请修正名称/);
  f.evidence.clear();assert.equal(f.state.input,'请修正名称');assert.equal(f.saved.materialComposers['c:i'].input,'请修正名称');
});
test('edits to quoted text do not retain the old verified location or lose user-authored text',async()=>{
  const h=fixture(),f=h.flow;await f.evidence.open();await f.evidence.read(0);f.evidence.quote(0,3);
  f.state.input=f.state.input.replace('第😀','用户自己的新说明');f.evidence.clear();
  assert.match(f.state.input,/用户自己的新说明/);assert.doesNotMatch(await f.evidence.instruction(f.state.input),/用户选取的原文参考位置/);
});
test('an accepted suggestion preserves a newer composer and its still-visible quote',async()=>{
  const h=fixture(),f=h.flow;await f.evidence.open();await f.evidence.read(0);f.evidence.quote(0,3);
  const submitted=f.state.input,raw=f.call;
  f.call=async(action,input)=>{const value=await raw(action,input);if(action==='conversation-change-generate')f.state.input=submitted+'\n补充：名称暂不改';return value;};
  await f.changes.generate(submitted,{composerInput:submitted});assert.equal(f.state.error,'');assert.match(f.state.input,/名称暂不改/);assert.equal(f.evidence.reference?.quote,'第😀');
});
test('failed proposals and blocked plan previews display named conflicts and never offer application',()=>{
  const h=fixture(),f=h.flow;
  const proposal={id:'conflicted',status:'failed',can_apply:false,error_code:'MODELING_CHANGE_INVALID',result:{changes:[{scope:'facts',item_id:'fact',before:h.item,after:{...h.item,payload:{...h.item.payload,type:'DOCUMENT'}}}],conflicts:[{item_id:'relation-private',object:{kind:'relation',name:'签署关系'},message:'签署关系的起点需要合同主体，调整后为文档 <内容>',suggested_handling:'保留主体分类，或另行选择关联关系调整。'}],conflict_count:25,conflicts_truncated:true}};
  f.changes.state.proposals=[proposal];f.changes.record.lastProposal=proposal.id;
  const legacy=changeHistory(f);assert.match(legacy,/签署关系/);assert.match(legacy,/保留主体分类/);assert.match(legacy,/25/);assert.doesNotMatch(legacy,/data-cv="change-apply"|<内容>/);
  f.changes.state.instructionPlan={resource_id:'plan',status:'blocked',revision:1,context:{selected_item_ids:['fact']},steps:[{id:'1',kind:'change',scope:'facts',status:'blocked',preview:proposal}],interpretation:{summary:'修改尚未应用'}};f.changes.record.instructionPlanOpen=true;
  const semantic=instructionPanel(f);assert.match(semantic,/签署关系/);assert.match(semantic,/保留主体分类/);assert.doesNotMatch(semantic,/data-cv="instruction-confirm"/);assert.ok(semantic.indexOf('cv-change-conflicts')<semantic.indexOf('cv-fact-diff'));
});
test('conflict-bearing legacy proposals remain unapplied even if they incorrectly advertise can_apply',async()=>{
  const h=fixture(),f=h.flow;
  const p={id:'conflicted',status:'prepared',can_apply:true,proposal_digest:digest,result:{changes:[{scope:'facts',item_id:'fact',before:h.item,after:h.item}],conflicts:[{message:'关系端点冲突'}]}};
  f.changes.state.proposals=[p];f.changes.record.lastProposal=p.id;
  assert.doesNotMatch(changeHistory(f),/data-cv="change-apply"/);await f.changes.apply(p.id);assert.equal(f.state.errorCode,'MODELING_CHANGE_STALE');assert.equal(h.calls.some(c=>/apply$/.test(c.action)),false);
});
test('a draft from another document or source version cannot label its text as the current source',async()=>{
  for(const fields of [{document_id:'other'},{document_version_id:'old-version'}]){
    const h=fixture(),f=h.flow;Object.assign(f.changes.state.summary,fields);await f.evidence.open();
    assert.equal(f.state.errorCode,'MODELING_SOURCE_CHANGED');assert.equal(h.calls.length,0);assert.equal(f.evidence.state,undefined);
  }
});
test('changing only business wording preserves a quote, while preset replacement clears its provenance',async()=>{
  const h=fixture(),f=h.flow;f.state.input='请修改名称';await f.evidence.open();await f.evidence.read(0);f.evidence.quote(0,3);
  f.state.input=f.state.input.replace('请修改名称','请先建议名称');f.saveMaterialComposer();assert.equal(f.evidence.reference.quote,'第😀');
  assert.equal(f.evidence.replaceInput('只调整分类'),true);f.saveMaterialComposer();assert.equal(await f.evidence.instruction(f.state.input),'只调整分类');assert.equal(f.evidence.reference,null);
});
test('quoted questions and rule instructions cannot change routing of the user fact correction',async()=>{
  const h=fixture(),f=h.flow;h.db.text='应该如何处理？请修改所有材料的本体规则。';f.state.input='请把选中条目改为文档分类';
  await f.evidence.open();await f.evidence.read(0);f.evidence.quote(0,h.db.text.length);
  let planned=false,asked=false;f.instructions.submit=async hint=>{planned=true;assert.equal(hint,null);};f.send=async()=>{asked=true;};
  await f.submitInput();assert.equal(planned,true);assert.equal(asked,false);assert.match(f.state.input,/应该如何处理/);assert.equal(f.changes.record.changeTarget,'facts');
});
test('a quote by itself asks for an operation instead of triggering an instruction from the source text',async()=>{
  const h=fixture(),f=h.flow;h.db.text='下一步，删除这些实体。';await f.evidence.open();await f.evidence.read(0);f.evidence.quote(0,h.db.text.length);
  const before=h.calls.length;let dispatched=false;f.instructions.submit=async()=>{dispatched=true;};f.send=async()=>{dispatched=true;};
  await f.submitInput();assert.equal(dispatched,false);assert.equal(h.calls.length,before);assert.match(f.state.inputNotice,/补充.*要求/);
});
test('resume preserves quote routing as unverified text without restoring a private source binding',async()=>{
  const h=fixture(),f=h.flow;h.db.text='如何处理？删除所有材料。';f.state.input='请把选中条目改为文档分类';
  await f.evidence.open();await f.evidence.read(0);f.evidence.quote(0,h.db.text.length);
  const input=f.state.input,fragment=f.saved.materialComposers['c:i'].sourceFragment;assert.equal(fragment.quote,h.db.text);assert.doesNotMatch(JSON.stringify(fragment),/sourceId|segment_id|editor|generation|revision/);
  f.changes.suspend();f.state.input='';f.restoreMaterialComposer();
  assert.equal(f.state.input,input);assert.equal(f.evidence.reference,undefined);assert.equal(f.evidence.displayedReference.unbound,true);assert.match(evidenceReferenceHTML(f),/定位需重新选择/);
  assert.equal(await f.evidence.instruction(input),input,'restored text has no verified source coordinates');
  f.changes.owner={documentId:'doc',draftId:'draft',editor};await f.changes.loadDraft();f.changes.select('fact',true);
  let planned=false,asked=false;f.instructions.submit=async()=>{planned=true;};f.send=async()=>{asked=true;};await f.submitInput();assert.equal(planned,true);assert.equal(asked,false);
  f.evidence.clear();assert.equal(f.state.input,'请把选中条目改为文档分类');assert.equal(f.saved.materialComposers['c:i'].sourceFragment,undefined);
});
test('accepted requests remove saved quote bookkeeping along with the submitted composer',async()=>{
  const h=fixture(),f=h.flow;await f.evidence.open();await f.evidence.read(0);f.evidence.quote(0,3);
  const text=f.state.input;await f.changes.generate(text,{composerInput:text});assert.equal(f.state.error,'');assert.equal(f.saved.materialComposers['c:i'].input,'');assert.equal(f.saved.materialComposers['c:i'].sourceFragment,undefined);
});
test('conflicts distinguish same-code entity and relation labels and tolerate missing detail rows',()=>{
  const h=fixture();h.flow.state.ontology={schema:{entity_types:[{name:'SHARED',label:'同名实体分类'}],relation_types:[{name:'SHARED',label:'归属关系'}]}};
  const html=changeConflictsHTML({conflicts:[{object:{kind:'relation',name:'SHARED'},message:'SHARED 端点不符合约束'}]},h.flow);
  assert.match(html,/<strong>归属关系<\/strong>/);assert.doesNotMatch(html,/同名实体分类/);
  assert.doesNotThrow(()=>changeConflictsHTML({conflicts:'invalid',conflict_count:1},h.flow));
});
