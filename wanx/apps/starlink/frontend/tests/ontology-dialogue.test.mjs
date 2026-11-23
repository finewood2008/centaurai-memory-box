import test from 'node:test';
import assert from 'node:assert/strict';
import {OntologyDialogue,nextInstruction,applyInstruction,dialogueError} from '../src/ontologyDialogue.ts';
const schema={entity_types:[{name:'PERSON',label:'人物',properties:[]}],relation_types:[]};
function fixture(){
  const calls=[],rounds=new Map(),receipts=new Map();let next=0,proposalNo=0,lost='',failRead=false,publications=0,currentBase='base',publishedSchema=structuredClone(schema);
  const read=async(url,options)=>{
    const body=options?.body&&JSON.parse(options.body);calls.push({url,body});
    if(!body){
      if(failRead){failRead=false;throw Error('read lost');}
      if(url.startsWith('/api/conversations?'))return {items:[{id:'material',scenario:'material'},...Array.from(rounds.keys()).reverse().map(id=>({id,scenario:'change'}))],has_more:false,next_offset:rounds.size+1};
      const c=rounds.get(url.split('/')[3]);return structuredClone({...c,current_ontology_id:currentBase});
    }
    if(receipts.has(body.operation_id))return structuredClone(receipts.get(body.operation_id));
    const id=url.split('/')[3],c=rounds.get(id);let result;
    if(url==='/api/conversations'){
      assert.equal(body.scenario,'change');const id='round'+(++next);rounds.set(id,{conversation_id:id,initialized:false,status:'uninitialized',current_ontology_id:currentBase});result={resource_id:id};
    }else if(url.endsWith('/initialize')){
      assert.equal(body.base_ontology_id,currentBase);
      Object.assign(c,{initialized:true,status:'editing',base_ontology_id:currentBase,draft:{revision:0,name:'草稿',schema:structuredClone(publishedSchema),questions:[]},draft_digest:'a'.repeat(64),history:{items:[]}});result={resource_id:'init'};
    }else if(url.endsWith('/proposals')){
      assert.equal(body.expected_revision,c.draft.revision);assert.equal(body.draft_digest,c.draft_digest);
      if(body.proposal_id){assert.equal(body.proposal_id,c.proposal.resource_id);assert.equal(body.proposal_digest,c.proposal.proposal_digest);}
      const proposed=structuredClone(c.draft.schema);proposed.entity_types[0].label=body.instruction;
      c.proposal={resource_id:'proposal'+(++proposalNo),proposal_digest:proposalNo.toString(16).padStart(64,'0'),expected_revision:c.draft.revision,draft_digest:c.draft_digest,status:body.instruction==='需要澄清'?'clarification_required':'proposed',summary:'建议修改标签',schema:proposed,questions:body.instruction==='需要澄清'?['请说明目标']:[],dependencies:[]};
      c.history.items.unshift({resource_id:'turn'+proposalNo,status:'succeeded',instruction:body.instruction,answer:'建议待确认'});result={resource_id:c.proposal.resource_id,status:c.proposal.status};
    }else if(url.endsWith('/apply')){
      assert.equal(body.confirmed,true);assert.equal(body.expected_revision,c.draft.revision);assert.equal(body.draft_digest,c.draft_digest);assert.equal(body.proposal_digest,c.proposal.proposal_digest);
      c.draft.revision++;c.draft_digest=c.draft.revision.toString(16).padStart(64,'0');c.draft.schema=structuredClone(c.proposal.schema);c.proposal.status='applied';result={resource_id:'application'+c.draft.revision,status:'applied'};
    }else if(url.endsWith('/preview')){
      result={resource_id:'preview',draft_digest:c.draft_digest,draft_revision:c.draft.revision,preview_digest:'c'.repeat(64),impact:{valid:true,items:[],total:0,offset:0,has_more:false}};
    }else if(url.endsWith('/execute')){
      assert.equal(body.confirmed,true);assert.equal(body.mode,'publish_only');publications++;c.status='published';c.execution_id='execution';currentBase='published'+publications;publishedSchema=structuredClone(c.draft.schema);result={resource_id:'execution',status:'completed'};
    }else throw Error('unexpected '+url);
    receipts.set(body.operation_id,structuredClone(result));
    if(lost&&url.endsWith(lost)){lost='';throw Error('response lost');}
    return structuredClone(result);
  };
  const flow=new OntologyDialogue(read,'base',()=>{});
  return {flow,read,calls,rounds,lose:s=>lost=s,loseRead:()=>failRead=true,publications:()=>publications};
}
async function applied(h){await h.flow.send('当事人');await h.flow.apply();}

test('open is read-only and first instruction automatically initializes a proposal, never writes draft',async()=>{
  const h=fixture();await h.flow.open();assert.equal(h.flow.opened,true);assert.equal(h.rounds.size,0);
  await h.flow.send('新增人员类型');assert.equal(h.flow.current.draft.revision,0);assert.deepEqual(h.flow.current.draft.schema,schema);
  assert.equal(h.flow.proposal.schema.entity_types[0].label,'新增人员类型');assert.ok(h.calls.every(c=>!c.url.endsWith('/turns')));
});
test('refining a suggestion binds the prior proposal and does not apply either version',async()=>{
  const h=fixture();await h.flow.send('人员');const first=h.flow.proposal.resource_id;
  await h.flow.send('再调整一下定义');const request=h.calls.findLast(c=>c.body?.instruction==='再调整一下定义');
  assert.equal(request.body.proposal_id,first);assert.equal(h.flow.current.draft.revision,0);assert.notEqual(h.flow.proposal.resource_id,first);
});
test('next and publish cannot confirm a proposal; explicit apply updates draft but never publishes',async()=>{
  const h=fixture();await h.flow.send('人员');await h.flow.send('下一步');assert.match(h.flow.error,/不会代替确认/);
  await h.flow.prepare();await h.flow.publish(true);assert.equal(h.publications(),0);assert.equal(h.flow.current.draft.revision,0);
  await h.flow.send('按这个建议修改');assert.equal(h.flow.current.draft.revision,1);assert.equal(h.publications(),0);
  assert.equal(h.flow.acceptedInput.instruction,'按这个建议修改');
  await h.flow.send('下一步');assert.ok(h.flow.preview);await h.flow.publish(false);assert.equal(h.publications(),0);
  await h.flow.publish(true);assert.equal(h.publications(),1);
});
test('clarification requires an answer and a separate confirmation',async()=>{
  const h=fixture();await h.flow.send('需要澄清');await h.flow.apply();assert.match(h.flow.error,/补充说明/);
  await h.flow.send('使用当事人标签');assert.equal(h.flow.current.draft.revision,0);await h.flow.apply();assert.equal(h.flow.current.draft.revision,1);
});
test('compound confirmation with additional changes is a new suggestion, never implicit apply',async()=>{
  const h=fixture();await h.flow.send('人员');await h.flow.send('采用建议，但是不要属性');
  assert.equal(h.flow.current.draft.revision,0);assert.equal(h.calls.filter(c=>c.url.endsWith('/proposals')&&c.body).length,2);
  assert.equal(applyInstruction('确认应用到草稿。'),true);assert.equal(applyInstruction('确认发布'),false);assert.equal(nextInstruction('下一步，并新增关系'),false);
});
test('undo is proposed and must be confirmed, not executed on detection',async()=>{
  const h=fixture();await applied(h);await h.flow.send('撤销刚才的修改');
  assert.equal(h.flow.current.draft.revision,1);assert.equal(h.flow.current.draft.schema.entity_types[0].label,'当事人');assert.equal(h.flow.proposal.status,'proposed');
});
test('publication followed by another instruction transparently starts from latest effective schema',async()=>{
  const h=fixture();await applied(h);await h.flow.prepare();await h.flow.publish(true);const old=h.flow.conversationId;
  await h.flow.send('新增关系');assert.notEqual(h.flow.conversationId,old);assert.equal(h.flow.current.base_ontology_id,'published1');
  assert.equal(h.flow.current.draft.schema.entity_types[0].label,'当事人');assert.equal(h.flow.current.draft.revision,0);assert.equal(h.flow.current.history.items.length,1);
});
test('reopening restores unfinished proposal; history reading never changes active editing context',async()=>{
  const h=fixture();await h.flow.send('人员');const id=h.flow.conversationId;
  const beforeOpen=h.calls.length;
  const reopened=new OntologyDialogue(h.read,'base',()=>{});await reopened.open();assert.equal(reopened.conversationId,id);assert.equal(reopened.proposal.status,'proposed');
  assert.equal(h.calls.slice(beforeOpen).filter(c=>c.url.endsWith('/ontology-edit')).length,1,'opening validates and reuses the fetched state without a duplicate request');
  await reopened.readHistory(id);assert.equal(reopened.conversationId,id);assert.equal(reopened.current.draft.revision,0);
});

for(const recovery of ['refresh','open'])test(`failed opening recovers via ${recovery} without leaving the composer blocked`,async()=>{
  const h=fixture();await h.flow.send('人员');let malformed=true;
  const read=async(url,options)=>{
    const result=await h.read(url,options);
    if(malformed&&url.endsWith('/ontology-edit')){malformed=false;result.proposal.schema.entity_types[0].properties=null;}
    return result;
  };
  const reopened=new OntologyDialogue(read,'base',()=>{},schema);await reopened.open();
  assert.equal(reopened.opened,false);assert.equal(reopened.needsRefresh,true);
  if(recovery==='open'){
    await h.flow.apply();await h.flow.prepare();await h.flow.publish(true);
  }
  await reopened[recovery]();
  assert.equal(reopened.error,'');assert.equal(reopened.opened,true);assert.equal(reopened.needsRefresh,false);
  if(recovery==='open'){assert.equal(reopened.conversationId,'');assert.equal(reopened.current,undefined);}
  await reopened.send('增加定义');assert.equal(reopened.error,'');assert.equal(reopened.proposal.status,'proposed');
  if(recovery==='open')assert.equal(reopened.current.base_ontology_id,'published1');
});

test('completed conversations stay history and do not enter the active prompt when reopened',async()=>{
  const h=fixture();await applied(h);await h.flow.prepare();await h.flow.publish(true);
  const reopened=new OntologyDialogue(h.read,'published1',()=>{});await reopened.open();assert.equal(reopened.current,undefined);assert.equal(reopened.rounds.length,1);
  await reopened.send('新的需求');assert.equal(reopened.current.history.items.length,1);
});
test('unknown proposal result replays the exact request even after refreshing',async()=>{
  const h=fixture();await h.flow.start();h.lose('/proposals');await h.flow.send('人员');const original=structuredClone(h.flow.pending);
  await h.flow.refresh();await h.flow.send('另一个要求');assert.deepEqual(h.flow.pending,original);await h.flow.retry();
  const sent=h.calls.filter(c=>c.body&&c.url.endsWith('/proposals'));assert.deepEqual(sent[0],sent[1]);assert.equal(h.flow.current.draft.revision,0);
});
test('lost apply response consumes matching confirmation on recovery without applying twice',async()=>{
  const h=fixture();await h.flow.send('人员');h.lose('/apply');await h.flow.send('确认应用到草稿');assert.ok(h.flow.pending);
  await h.flow.refresh();await h.flow.retry();assert.equal(h.flow.current.draft.revision,1);assert.equal(h.flow.pending,undefined);assert.equal(h.flow.acceptedInput.instruction,'确认应用到草稿');
});
test('lost creation and initialization recover without duplicate conversations',async()=>{
  const h=fixture();h.lose('/api/conversations');await h.flow.send('人员');await h.flow.retry();assert.equal(h.rounds.size,1);
  h.lose('/initialize');await h.flow.send('人员');await h.flow.retry();await h.flow.send('人员');assert.equal(h.rounds.size,1);assert.ok(h.flow.proposal);
});
test('lost publication cannot double publish',async()=>{
  const h=fixture();await applied(h);await h.flow.prepare();h.lose('/execute');await h.flow.publish(true);
  await h.flow.refresh();await h.flow.retry();assert.equal(h.publications(),1);assert.equal(h.flow.pending,undefined);
});
test('failed read invalidates preview and blocks stale writes until recovery',async()=>{
  const h=fixture();await applied(h);await h.flow.prepare();h.loseRead();await h.flow.refresh();assert.equal(h.flow.needsRefresh,true);assert.equal(h.flow.preview,undefined);
  const count=h.calls.length;await h.flow.send('调整');await h.flow.prepare();await h.flow.publish(true);assert.equal(h.calls.length,count);
  await h.flow.refresh();await h.flow.send('新的标签');assert.equal(h.flow.proposal.status,'proposed');
});
test('accepted suggestion clears submitted input receipt even if subsequent read fails',async()=>{
  const h=fixture();await h.flow.start();h.loseRead();await h.flow.send('人员');assert.ok(h.flow.error);assert.equal(h.flow.pending,undefined);assert.equal(h.flow.acceptedInput.instruction,'人员');
});
test('business failed receipt is surfaced and does not consume input or modify draft',async()=>{
  const h=fixture();await h.flow.start();h.flow.read=async(url,opts)=>opts&&url.endsWith('/proposals')?{resource_id:'failed',status:'failed',message:'模型失败'}:h.read(url,opts);
  await h.flow.send('人员');assert.match(h.flow.error,/模型失败/);assert.equal(h.flow.acceptedInput,undefined);assert.equal(h.flow.current.draft.revision,0);
});
test('missing proposal endpoint never falls back to the auto-writing turns endpoint',async()=>{
  const h=fixture();await h.flow.start();h.flow.read=async(url,opts)=>{if(url.endsWith('/proposals'))throw Object.assign(Error('unsupported'),{status:404});return h.read(url,opts);};
  await h.flow.send('人员');assert.match(h.flow.error,/路径与已部署版本/);assert.equal(h.flow.pending,undefined);assert.equal(h.flow.current.draft.revision,0);assert.ok(h.calls.every(c=>!c.url.endsWith('/turns')));
});
test('409 requires fresh state and rejects an old proposal approval',async()=>{
  const h=fixture();await h.flow.send('人员');h.flow.read=async(url,opts)=>{if(opts)throw Object.assign(Error('conflict'),{status:409,code:'MODELING_PROPOSAL_STALE'});return h.read(url,opts);};
  await h.flow.apply();assert.equal(h.flow.needsRefresh,true);h.flow.read=h.read;
  h.rounds.get(h.flow.conversationId).draft.revision++;await h.flow.refresh();await h.flow.apply();assert.match(h.flow.error,/重新生成建议/);
});
test('active task, new proposal, changed revision and preview denial invalidate approval',async()=>{
  for(const change of [{active_turn_id:'other'},{can_preview:false},{draft_digest:'d'.repeat(64)},{proposal:{status:'proposed'}}]){
    const h=fixture();await applied(h);await h.flow.prepare();Object.assign(h.rounds.get(h.flow.conversationId),change);await h.flow.refresh();assert.equal(h.flow.preview,undefined);await h.flow.publish(true);assert.equal(h.publications(),0);
  }
});
test('empty draft and stale baseline cannot be published or silently overwritten',async()=>{
  const h=fixture();await h.flow.start();await h.flow.prepare();assert.match(h.flow.error,/尚无已确认/);
  h.rounds.get(h.flow.conversationId).status='stale';await h.flow.refresh();const count=h.calls.length;await h.flow.send('调整');assert.equal(h.calls.length,count);
});
test('polling exposes failure and clears obsolete generating status',async()=>{
  const h=fixture();await h.flow.start();const c=h.rounds.get(h.flow.conversationId);c.active_turn_id='task';await h.flow.refresh();assert.match(h.flow.note,/正在生成/);
  c.active_turn_id=null;c.history.items=[{status:'failed',message:'生成失败'}];await h.flow.refresh();assert.match(h.flow.note,/失败/);
  c.status='published';await h.flow.refresh();assert.equal(h.flow.note,'');
});
test('business errors remain actionable and are not misreported as missing endpoints',()=>{
  assert.match(dialogueError({status:404,code:'MODELING_RESOURCE_NOT_FOUND'}),/账号/);
  assert.doesNotMatch(dialogueError({status:404,code:'MODELING_RESOURCE_NOT_FOUND'}),/Bridge/);
  assert.match(dialogueError({code:'MODELING_SCENARIO_MISMATCH'}),/重新打开/);
});

test('after all changes are undone, next cannot publish an unchanged schema',async()=>{
  const h=fixture();await applied(h);const c=h.rounds.get(h.flow.conversationId);
  c.draft.schema=structuredClone(schema);c.draft.revision++;await h.flow.refresh();await h.flow.send('下一步');
  assert.match(h.flow.error,/没有差异/);assert.equal(h.flow.preview,undefined);
});

test('malformed or missing suggestion state blocks applying and publishing',async()=>{
  const h=fixture();await h.flow.send('人员');h.rounds.get(h.flow.conversationId).proposal={status:'proposed'};
  await h.flow.refresh();assert.equal(h.flow.needsRefresh,true);await h.flow.apply();assert.equal(h.flow.current.draft.revision,0);
});

test('successful apply receipt with delayed state cannot be applied again after repeated refreshes',async()=>{
  const h=fixture();await h.flow.send('人员');const before=structuredClone(h.flow.current);let lag=true;
  h.flow.read=(url,opts)=>opts?h.read(url,opts):lag?Promise.resolve(structuredClone(before)):h.read(url,opts);
  await h.flow.apply();assert.equal(h.flow.pending,undefined);assert.equal(h.flow.settling.kind,'apply');assert.equal(h.flow.needsRefresh,true);
  await h.flow.refresh();await h.flow.refresh();const n=h.calls.length;
  await h.flow.apply();await h.flow.send('确认应用');await h.flow.start();assert.equal(h.calls.length,n);
  lag=false;await h.flow.refresh();assert.equal(h.flow.settling,undefined);assert.equal(h.flow.needsRefresh,false);assert.equal(h.flow.current.draft.revision,1);
  assert.equal(h.calls.filter(c=>c.body&&c.url.endsWith('/apply')).length,1);
});

test('a missing new suggestion cannot be bypassed by refreshing into an older suggestion',async()=>{
  const h=fixture();await h.flow.send('人员');const before=structuredClone(h.flow.current);let lag=true;
  h.flow.read=(url,opts)=>opts?h.read(url,opts):lag?Promise.resolve(structuredClone(before)):h.read(url,opts);
  await h.flow.send('增加定义');assert.equal(h.flow.settling.kind,'proposal');
  await h.flow.refresh();const n=h.calls.length;await h.flow.apply();await h.flow.prepare();assert.equal(h.calls.length,n);
  lag=false;await h.flow.refresh();assert.equal(h.flow.settling,undefined);assert.notEqual(h.flow.proposal.resource_id,before.proposal.resource_id);
});

test('asynchronous suggestion failure settles the receipt and allows a new instruction',async()=>{
  const h=fixture();await h.flow.start();const original=h.flow.read;
  h.flow.read=async(url,opts)=>{
    if(opts&&url.endsWith('/proposals')){h.rounds.get(h.flow.conversationId).active_turn_id='job';return {resource_id:'pending-proposal',status:'generating'};}
    return original(url,opts);
  };
  await h.flow.send('增加定义');assert.ok(h.flow.settling);const c=h.rounds.get(h.flow.conversationId);
  c.active_turn_id=null;c.history.items.unshift({resource_id:'pending-proposal',status:'failed',message:'生成失败'});
  h.flow.read=original;await h.flow.refresh();assert.equal(h.flow.settling,undefined);assert.equal(h.flow.needsRefresh,false);assert.match(h.flow.note,/生成失败/);
  await h.flow.send('重新建议');assert.equal(h.flow.proposal.status,'proposed');
});

test('malformed nested suggestion schema never replaces the renderable state',async()=>{
  const h=fixture();await h.flow.send('人员');const good=structuredClone(h.flow.current);
  h.rounds.get(h.flow.conversationId).proposal.schema.entity_types[0].properties=null;
  await h.flow.refresh();assert.equal(h.flow.needsRefresh,true);assert.deepEqual(h.flow.current,good);
  const reopened=new OntologyDialogue(h.read,'base',()=>{},schema);await reopened.open();
  assert.equal(reopened.opened,false);assert.equal(reopened.current,undefined);assert.equal(reopened.needsRefresh,true);
  assert.match(reopened.error,/回执不完整/);
});

test('authoritative apply history resolves delayed acknowledgement even when a newer suggestion exists',async()=>{
  const h=fixture();await h.flow.send('人员');const before=structuredClone(h.flow.current);
  h.flow.read=(url,opts)=>opts?h.read(url,opts):Promise.resolve(structuredClone(before));await h.flow.apply();
  const c=h.rounds.get(h.flow.conversationId);c.proposal={...c.proposal,resource_id:'newer',status:'proposed',expected_revision:c.draft.revision,draft_digest:c.draft_digest};
  c.history.items.unshift({resource_id:'application1',status:'applied'});h.flow.read=h.read;await h.flow.refresh();
  assert.equal(h.flow.settling,undefined);assert.equal(h.flow.needsRefresh,false);assert.equal(h.flow.proposal.resource_id,'newer');
});

test('v1.1 server change detection controls publish eligibility after restore and undo',async()=>{
  const h=fixture();await applied(h);const c=h.rounds.get(h.flow.conversationId);
  h.flow.baselineSchema=structuredClone(c.draft.schema);c.has_changes=true;
  await h.flow.refresh();assert.equal(h.flow.hasChanges(),true);await h.flow.prepare();assert.ok(h.flow.preview);
  c.has_changes=false;c.can_preview=false;await h.flow.refresh();await h.flow.prepare();
  assert.equal(h.flow.hasChanges(),false);assert.equal(h.flow.preview,undefined);assert.match(h.flow.error,/没有差异/);
});

test('replayed proposal may already be applied in another client and never applies twice',async()=>{
  const h=fixture();h.lose('/proposals');await h.flow.send('人员');const original=structuredClone(h.flow.pending);
  const other=new OntologyDialogue(h.read,'base',()=>{});await other.open();await other.apply();
  h.flow.read=async(url,opts)=>opts&&url.endsWith('/proposals')?
    {...structuredClone(h.rounds.get(h.flow.conversationId).proposal),reused:true}:h.read(url,opts);
  await h.flow.retry();assert.equal(h.flow.error,'');assert.equal(h.flow.pending,undefined);assert.equal(h.flow.settling,undefined);
  assert.equal(h.flow.current.draft.revision,1);assert.equal(h.flow.acceptedInput.instruction,original.body.instruction);
  assert.equal(h.calls.filter(c=>c.body&&c.url.endsWith('/apply')).length,1);
});

test('completed proposal history resolves recovery when the latest proposal is null',async()=>{
  const h=fixture();await h.flow.start();
  h.flow.read=async(url,opts)=>opts&&url.endsWith('/proposals')?{resource_id:'pending-proposal',status:'generating'}:h.read(url,opts);
  await h.flow.send('人员');assert.ok(h.flow.settling);
  const c=h.rounds.get(h.flow.conversationId);c.proposal=null;
  c.history.items=[{resource_id:'new-failed',status:'failed',message:'后续生成失败'}, {resource_id:'pending-proposal',status:'applied'}];
  await h.flow.refresh();assert.equal(h.flow.settling,undefined);assert.equal(h.flow.needsRefresh,false);
  assert.match(h.flow.note,/后续生成失败/);
});

test('generation uses 285 seconds and confirmation operations use 45 seconds',async()=>{
  const h=fixture(),timeouts=[];
  h.flow.read=(url,opts,timeout)=>{if(opts)timeouts.push({url,timeout});return h.read(url,opts);};
  await applied(h);await h.flow.prepare();await h.flow.publish(true);
  for(const call of timeouts)assert.equal(call.timeout,call.url.endsWith('/proposals')?285000:45000);
  assert.equal(h.publications(),1);
});

test('v1.1 publication gate errors explain how to continue',()=>{
  assert.match(dialogueError({code:'MODELING_ONTOLOGY_EDIT_PROPOSAL_PENDING'}),/确认应用到草稿/);
  assert.match(dialogueError({code:'MODELING_ONTOLOGY_EDIT_CLARIFICATION_REQUIRED'}),/待确认问题/);
  assert.match(dialogueError({code:'MODELING_ONTOLOGY_EDIT_NO_CHANGES'}),/没有实际变化/);
});

test('restoring an initialized but unchanged conversation never claims unpublished modifications',async()=>{
  const h=fixture();await h.flow.start();
  const restored=new OntologyDialogue(h.read,'base',()=>{},schema);await restored.open();
  assert.equal(restored.hasChanges(),false);assert.doesNotMatch(restored.note,/已恢复未发布修改/);
});

test('restoration distinguishes a pending suggestion from confirmed draft modifications',async()=>{
  const h=fixture();await h.flow.send('人员');
  const suggestion=new OntologyDialogue(h.read,'base',()=>{},schema);await suggestion.open();
  assert.match(suggestion.note,/已恢复待确认建议/);assert.equal(suggestion.current.draft.revision,0);
  await h.flow.apply();const draft=new OntologyDialogue(h.read,'base',()=>{},schema);await draft.open();
  assert.match(draft.note,/已恢复未发布修改/);
});

test('conversation publication instructions open review without generating another suggestion or publishing',async()=>{
  const h=fixture();await applied(h);
  const proposals=h.calls.filter(c=>c.body&&c.url.endsWith('/proposals')).length;
  await h.flow.send('我已核对，确认发布');assert.ok(h.flow.preview);assert.equal(h.publications(),0);
  await h.flow.send('确认发布');assert.match(h.flow.note,/勾选确认/);assert.equal(h.publications(),0);
  assert.equal(h.calls.filter(c=>c.body&&c.url.endsWith('/proposals')).length,proposals);
});

test('publication intent cannot bypass an unconfirmed proposal',async()=>{
  const h=fixture();await h.flow.send('人员');await h.flow.send('确认发布');
  assert.equal(h.flow.current.draft.revision,0);assert.equal(h.flow.preview,undefined);assert.equal(h.publications(),0);
  assert.match(h.flow.error,/先核对建议/);
});

test('publication receipt waits for its authoritative execution id and cannot double publish',async()=>{
  const h=fixture();await applied(h);await h.flow.prepare();const before=structuredClone(h.flow.current);let lag=true;
  h.flow.read=(url,opts)=>opts?h.read(url,opts):lag?Promise.resolve(structuredClone(before)):h.read(url,opts);
  await h.flow.publish(true);assert.equal(h.flow.settling.kind,'execute');assert.equal(h.flow.needsRefresh,true);
  await h.flow.refresh();const count=h.calls.length;await h.flow.send('调整');await h.flow.prepare();await h.flow.start();
  assert.equal(h.calls.length,count);assert.equal(h.publications(),1);
  lag=false;await h.flow.refresh();assert.equal(h.flow.settling,undefined);assert.equal(h.flow.current.status,'published');
});

test('malformed publication completion preserves the original operation for recovery',async()=>{
  const h=fixture();await applied(h);await h.flow.prepare();const read=h.flow.read;
  h.flow.read=async(url,opts)=>{const result=await read(url,opts);return opts&&url.endsWith('/execute')?{resource_id:result.resource_id}:result;};
  await h.flow.publish(true);assert.ok(h.flow.pending);assert.equal(h.publications(),1);
  h.flow.read=read;await h.flow.retry();assert.equal(h.publications(),1);assert.equal(h.flow.pending,undefined);
  assert.equal(h.flow.current.status,'published');
});

test('interrupted new conversation recovers against latest published baseline without stale page reload',async()=>{
  const h=fixture();await applied(h);await h.flow.prepare();await h.flow.publish(true);
  h.lose('/api/conversations');await h.flow.send('新要求');assert.ok(h.flow.pending);
  await h.flow.retry();assert.equal(h.flow.current.status,'uninitialized');await h.flow.send('新要求');
  assert.equal(h.flow.error,'');assert.equal(h.flow.current.base_ontology_id,'published1');
  assert.equal(h.flow.current.draft.schema.entity_types[0].label,'当事人');assert.ok(h.flow.proposal);
});
