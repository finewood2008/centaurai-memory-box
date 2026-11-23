import test from 'node:test';
import assert from 'node:assert/strict';
import {RuleReview,reviewedSchema,ruleMessage,defaultRuleChoices,reuseOptions,dependencyWarnings} from '../ui/onboarding-rules.mjs';
import {onboardingRequest} from '../shared/onboarding-contract.mjs';
import {ruleReviewHTML} from '../ui/onboarding-rules-view.mjs';
import {savedReviewQuestions} from '../ui/onboarding-notes.mjs';
const base={entity_types:[{name:'PERSON',label:'人物',properties:[]}],relation_types:[]};
const suggestions=[{id:'drug',kind:'entity',name:'DRUG',label:'药品',definition:'药品资料'},
  {id:'link',kind:'relation',name:'USES',label:'使用',source_types:['PERSON'],target_types:['DRUG']},
  {id:'prop',kind:'property',name:'dosage',label:'剂量',owner_kind:'entity',owner_name:'DRUG'}];
const choices={drug:{action:'add',target:'MEDICINE',label:'药品'},link:{action:'add',target:'USES',label:'使用'},prop:{action:'add',target:'dosage',label:'剂量'}};

test('reuse selector exposes named existing targets and excludes its own proposed definition',()=>{
  assert.deepEqual(reuseOptions(base,suggestions,choices,suggestions[0]),[{name:'PERSON',label:'人物'}]);
  const renamed={...choices,prop:{action:'reuse',target:'dose'}};
  const items=[...suggestions.slice(0,2),{id:'existing-dose',kind:'property',owner_kind:'entity',owner_name:'DRUG',name:'dose',label:'用量'},suggestions[2]];
  renamed['existing-dose']={action:'add',target:'dose',label:'用量'};
  assert.deepEqual(reuseOptions(base,items,renamed,suggestions[2]),[{name:'dose',label:'用量'}]);
  assert.equal(reviewedSchema(base,items,renamed).schema.entity_types[1].properties.length,1);
  assert.deepEqual(reuseOptions(base,[suggestions[2],...items.slice(0,3)],renamed,suggestions[2]),[]);
});
test('exclusion warns about every affected relation and property without silently excluding them',()=>{
  const selected=structuredClone(choices);selected.drug.action='ignore';
  const warnings=dependencyWarnings(base,suggestions,selected);
  assert.deepEqual(Object.keys(warnings),['link','prop']);assert.match(warnings.link,/DRUG/);
  assert.equal(selected.link.action,'add');
  selected.drug={action:'reuse',target:'PERSON'};
  assert.deepEqual(dependencyWarnings(base,suggestions,selected),{});
});
test('rule validation identifies the offending candidate and renders an inline escaped error',async()=>{
  const f=fixture(),r=f.make();await r.load();r.choose('drug','action','ignore');await r.save();
  assert.equal(r.state.errorSuggestionId,'link');assert.match(r.state.error,/使用/);
  assert.equal(f.calls.filter(c=>c.input.body).length,0);
  const html=ruleReviewHTML(r);assert.match(html,/data-rule-dependency="prop"/);
  r.state.error='<img>';assert.ok(ruleReviewHTML(r).includes('&lt;img&gt;'));
});
test('review builds complete schema preserving existing types and remapping dependencies',()=>{
  const result=reviewedSchema(base,suggestions,choices);
  assert.equal(base.entity_types.length,1);
  assert.equal(result.schema.entity_types[1].name,'MEDICINE');
  assert.deepEqual(result.schema.relation_types[0].target_types,['MEDICINE']);
  assert.equal(result.decisions[2].owner_name,'MEDICINE');
  assert.equal(result.schema.entity_types[1].properties[0].required,false);
});

test('type names and dependent references normalize together while property names retain case',()=>{
  const items=structuredClone(suggestions);
  items[0].name='drug';items[1].source_types=['person'];items[1].target_types=['drug'];items[2].owner_name='drug';
  const result=reviewedSchema(base,items,{
    drug:{action:'add',target:' medicine ',label:'Medicine'},link:{action:'add',target:'uses',label:'Uses'},prop:{action:'add',target:'doseAmount',label:'Dose'},
  });
  assert.equal(result.schema.entity_types[1].name,'MEDICINE');
  assert.equal(result.decisions[0].target_name,'MEDICINE');
  assert.equal(result.schema.relation_types[0].name,'USES');
  assert.deepEqual(result.schema.relation_types[0].target_types,['MEDICINE']);
  assert.equal(result.decisions[2].owner_name,'MEDICINE');
  assert.equal(result.schema.entity_types[1].properties[0].name,'doseAmount');
  assert.equal(result.decisions[2].target_name,'doseAmount');
  const reused=reviewedSchema(base,[items[0]],{drug:{action:'reuse',target:'person',label:'Person'}});
  assert.equal(reused.decisions[0].target_name,'PERSON');
  assert.throws(()=>reviewedSchema(base,[items[0]],{drug:{action:'add',target:'_bad'}}),{code:'MODELING_RULE_DECISION_INVALID'});
  assert.throws(()=>reviewedSchema(base,[items[0]],{drug:{action:'add',target:'person'}}),{code:'MODELING_RULE_TARGET_CHANGED'});
});
test('every candidate needs explicit choice, ignored entity cannot satisfy adopted relation',()=>{
  assert.throws(()=>reviewedSchema(base,suggestions,{}),{code:'MODELING_RULE_DECISIONS_REQUIRED'});
  assert.throws(()=>reviewedSchema(base,suggestions,{...choices,drug:{action:'ignore'}}),{code:'MODELING_RULE_DECISION_INVALID'});
  assert.throws(()=>reviewedSchema(base,[{...suggestions[0],allow_new_type:false}],choices),{code:'MODELING_RULE_DECISION_INVALID'});
  assert.throws(()=>reviewedSchema(base,[suggestions[0]],{drug:{action:'reuse',target:'MISSING'}}),{code:'MODELING_RULE_TARGET_CHANGED'});
});
function fixture(){
  const values=new Map(),storage={getItem:k=>values.get(k)||null,setItem:(k,v)=>values.set(k,v)};
  const identity={boxId:'box',user:{id:1},dataScope:'personal'};
  const backend={draft:null,publication:null,lose:null},receipts=new Map(),calls=[];let counter=0;
  const call=async(action,input)=>{
    calls.push({action,input:structuredClone(input)});onboardingRequest(action,input);
    if(action==='onboarding-rules')return {proposal:{id:'proposal',status:'succeeded',valid:true,result:{suggestions}},base_ontology:{schema:base,name:'基础规则'},draft:structuredClone(backend.draft),publication:backend.publication};
    if(action==='onboarding-ontologies')return {items:[{id:'published',status:'published'}]};
    const b=input.body;let r=receipts.get(b.operation_id);
    if(!r){
      if(action==='onboarding-rule-prepare')r=backend.draft={...b,resource_id:'preview',status:'prepared',publish_operation_id:'publish-op',schema_digest:'a'.repeat(64),changes:[{kind:'entity_types',name:'MEDICINE'}]};
      else r=backend.publication={resource_id:'preview',status:'published',ontology_id:'published',version_number:2,changed:true};
      receipts.set(b.operation_id,r);
    }
    if(backend.lose===action){backend.lose=null;throw Object.assign(Error(),{code:'SEMANTICA_CONNECTION_FAILED',status:0});}
    return structuredClone(r);
  };
  const make=(overrides={})=>new RuleReview({call,storage,identity,warehouseId:'warehouse',proposalId:'proposal',uuid:()=>`op-${++counter}`,...overrides});
  return {backend,calls,make,storage};
}
test('editing a prepared rule in place invalidates confirmation and requires a fresh prepared draft',async()=>{
  const f=fixture(),r=f.make();await r.load();r.state.choices=structuredClone(choices);
  await r.save();r.confirm(true);
  const id=Object.keys(r.state.choices)[0];
  r.choose(id,'label','修改后的名称');
  assert.equal(r.state.editing,true);assert.equal(r.state.confirmed,false);
  await r.publish();assert.equal(f.backend.publication,null);
  assert.equal(r.state.errorCode,'MODELING_RULE_CONFIRMATION_REQUIRED');
  await r.save();assert.equal(r.state.editing,false);assert.equal(r.state.confirmed,false);
  assert.equal(r.state.draft.schema.entity_types.some(d=>d.label==='修改后的名称'),true);
  r.confirm(true);await r.publish();assert.equal(r.state.publication.status,'published');
  const old=structuredClone(r.state.choices);r.choose(id,'label','不可修改');assert.deepEqual(r.state.choices,old);
});

test('save never publishes; explicit second confirmation publishes and rereads effective rules',async()=>{
  const f=fixture(),r=f.make();await r.load();r.state.choices=structuredClone(choices);
  await Promise.all([r.save(),r.save()]);
  assert.equal(f.calls.filter(c=>c.action==='onboarding-rule-prepare').length,1);
  assert.equal(f.backend.publication,null);
  await r.publish();assert.equal(f.backend.publication,null);
  r.confirm(true);await Promise.all([r.publish(),r.publish()]);
  assert.equal(f.calls.filter(c=>c.action==='onboarding-rule-publish').length,1);
  assert.equal(f.calls.at(-1).action,'onboarding-ontologies');
});

test('batch defaults cover all suggestions; edits and exclusions survive draft reload',async()=>{
  const f=fixture();let r=f.make();await r.load();
  assert.ok(suggestions.every(s=>r.state.choices[s.id].action==='add'));
  assert.equal(f.calls.filter(c=>c.input.body).length,0);
  r.choose('drug','target','MEDICINE');r.choose('prop','action','ignore');
  await r.save();assert.equal(f.backend.publication,null);
  assert.deepEqual(f.backend.draft.schema.relation_types[0].target_types,['MEDICINE']);
  r=f.make();await r.load();r.edit();
  assert.equal(r.state.choices.drug.target,'MEDICINE');assert.equal(r.state.choices.prop.action,'ignore');
  await r.save();r.confirm(true);await r.publish();assert.equal(r.state.publication.status,'published');
});
test('batch defaults reuse existing names but require correction of unresolved reuse targets and dependencies',()=>{
  const items=[{id:'person',kind:'entity',name:'PERSON',label:'人物',allow_new_type:false},
    {id:'missing',kind:'entity',name:'MISSING',label:'缺失类型',allow_new_type:false}];
  const defaults=defaultRuleChoices(base,items);
  assert.equal(defaults.person.action,'reuse');assert.equal(defaults.missing.action,'');
  assert.throws(()=>reviewedSchema(base,items,defaults),{code:'MODELING_RULE_DECISIONS_REQUIRED'});
  const batch=defaultRuleChoices(base,suggestions);batch.drug.action='ignore';
  assert.throws(()=>reviewedSchema(base,suggestions,batch),{code:'MODELING_RULE_DECISION_INVALID'});
});
test('lost save response survives reload and replays exactly the original request',async()=>{
  const f=fixture();let r=f.make();await r.load();r.state.choices=structuredClone(choices);
  f.backend.lose='onboarding-rule-prepare';await r.save();const first=f.calls.at(-1);
  r=f.make();await r.load();assert.equal(r.state.pending.action,'onboarding-rule-prepare');
  await r.save();assert.deepEqual(f.calls.at(-1),first);assert.equal(r.state.pending,null);
});

test('failed local receipt commit retains the original rule write for retry',async()=>{
  const f=fixture(),r=f.make();await r.load();r.state.choices=structuredClone(choices);
  const save=f.storage.setItem;let failCommit=true;
  f.storage.setItem=(key,value)=>{
    if(failCommit && JSON.parse(value).pending===null){failCommit=false;throw Error('disk full');}
    save(key,value);
  };
  await r.save();assert.equal(r.state.pending.action,'onboarding-rule-prepare');
  const first=f.calls.at(-1);assert.match(r.state.error,/恢复记录/);
  await r.save();assert.deepEqual(f.calls.at(-1),first);assert.equal(r.state.pending,null);
});

test('retry committed after restoring an older draft refreshes choices before editing again',async()=>{
  const f=fixture(),original=f.make(),baseCall=original.call;
  let failBeforeSave=false;
  const make=()=>f.make({call:async(action,input)=>{
    if(action==='onboarding-rule-prepare'&&failBeforeSave){failBeforeSave=false;throw Error('network uncertain');}
    return baseCall(action,input);
  }});
  let r=make();await r.load();await r.save();
  r.edit();r.choose('drug','target','MEDICINE');r.choose('prop','action','ignore');
  failBeforeSave=true;await r.save();const pending=structuredClone(r.state.pending);
  r=make();await r.load();assert.equal(r.state.choices.drug.target,'DRUG');
  await r.save();assert.deepEqual(f.calls.at(-1).input,pending.input);
  r.edit();assert.equal(r.state.choices.drug.target,'MEDICINE');assert.equal(r.state.choices.prop.action,'ignore');
  await r.save();
  assert.equal(f.backend.draft.schema.entity_types[1].name,'MEDICINE');
  assert.equal(f.backend.draft.schema.entity_types[1].properties.length,0);
});

test('invalid rule receipt cannot leave a loaded published screen',async()=>{
  const f=fixture();
  const r=f.make({call:async()=>({publication:{status:'prepared',ontology_id:'wrong'}})});
  await r.load();assert.equal(r.state.loaded,false);assert.equal(r.state.publication,null);assert.ok(r.state.error);
});

test('zero candidates can be explicitly confirmed without inventing definitions',async()=>{
  const result=reviewedSchema(base,[],{});
  assert.deepEqual(result.schema,base);assert.deepEqual(result.decisions,[]);
});

test('clarification refusal requests answers instead of misreporting a version conflict',async()=>{
  const f=fixture();
  let calls=0;
  const r=f.make({call:async()=>{calls++;throw Object.assign(Error(),{code:'MODELING_RULE_CLARIFICATION_REQUIRED',status:409});}});
  await r.load();assert.equal(r.state.loaded,false);assert.equal(r.state.errorCode,'MODELING_RULE_CLARIFICATION_REQUIRED');
  assert.match(r.state.error,/尚未提供可采用的本体/);assert.doesNotMatch(r.state.error,/已变化|更新后端/);
  await r.save();await r.publish();assert.equal(calls,1);
  assert.match(ruleMessage({code:'MODELING_RULE_SOURCE_STALE'}),/已变化/);
});

test('partial candidates support batch review without a clarification page; receipts stay scoped',async()=>{
  const f=fixture(),original=f.make(),baseCall=original.call;
  const make=()=>f.make({call:async(action,input)=>{
    const value=await baseCall(action,input);
    if(action==='onboarding-rules'&&!value.publication)
      Object.assign(value.proposal.result,{outcome:'needs_clarification',questions:['哪种用途？']});
    return value;
  }});
  let r=make();await r.load();assert.equal(r.state.loaded,true);
  assert.doesNotMatch(ruleReviewHTML(r),/尚待补充的问题/);
  r.state.choices={...structuredClone(choices),prop:{action:'ignore'}};
  await r.save();assert.equal(f.backend.publication,null);
  assert.equal(f.backend.draft.schema.entity_types[1].properties.length,0);
  r=make();await r.load();assert.deepEqual(r.state.questions,['哪种用途？']);
  assert.doesNotMatch(ruleReviewHTML(r),/了解仍有待补充问题/);
  await r.publish();assert.equal(f.backend.publication,null);
  r.confirm(true);await r.publish();assert.equal(r.state.publication.status,'published');
  r=make();await r.load();assert.deepEqual(r.state.questions,['哪种用途？']);
  assert.equal(f.calls.filter(c=>c.action==='onboarding-rule-publish').length,1);
  for(const other of [f.make({warehouseId:'other'}),f.make({proposalId:'other'}),f.make({identity:{boxId:'box',user:{id:2}}})]){
    other.restore();assert.deepEqual(other.state.questions,[]);
  }
  assert.deepEqual(savedReviewQuestions(f.storage,{boxId:'box',user:{id:1},dataScope:'personal'},'warehouse','proposal'),['哪种用途？']);
});

test('questions alone or contradictory outcome cannot enter a new rule review',async()=>{
  for(const result of [{outcome:'needs_clarification',questions:['哪种用途？'],suggestions:[]},
    {outcome:'ready',questions:['哪种用途？'],suggestions}]){
    const f=fixture(),r=f.make({call:async()=>({proposal:{id:'proposal',status:'succeeded',valid:true,result},base_ontology:{schema:base}})});
    await r.load();assert.equal(r.state.loaded,false);assert.equal(r.state.publication,null);
  }
});

test('can_review is respected for new review while an existing human draft stays recoverable',async()=>{
  const f=fixture(),original=f.make(),baseCall=original.call;
  const make=()=>f.make({call:async(action,input)=>{
    const value=await baseCall(action,input);
    if(action==='onboarding-rules')Object.assign(value.proposal,{can_review:false,unresolved_questions:['服务端问题']});
    return value;
  }});
  let r=make();await r.load();assert.equal(r.state.loaded,false);
  await original.load();original.state.choices=structuredClone(choices);await original.save();
  f.backend.draft.unresolved_questions=['冻结草稿问题'];
  r=make();await r.load();assert.equal(r.state.loaded,true);assert.equal(r.state.editing,false);
  assert.deepEqual(r.state.questions,['冻结草稿问题']);
});

test('legacy question receipts remain stored without restoring the clarification UI',async()=>{
  const f=fixture(),original=f.make(),baseCall=original.call;
  const r=f.make({call:async(action,input)=>{
    const value=await baseCall(action,input);
    if(action==='onboarding-rule-prepare')value.unresolved_questions=['草稿问题'];
    if(action==='onboarding-rule-publish')value.unresolved_questions=['发布回执问题'];
    return value;
  }});
  await r.load();r.state.choices=structuredClone(choices);await r.save();
  assert.deepEqual(r.state.questions,['草稿问题']);assert.doesNotMatch(ruleReviewHTML(r),/草稿问题/);
  r.confirm(true);await r.publish();assert.deepEqual(r.state.questions,['发布回执问题']);
  assert.doesNotMatch(ruleReviewHTML(r),/发布回执问题/);
});

test('legacy empty human draft can still be restored and explicitly published',async()=>{
  const f=fixture(),original=f.make();await original.load();original.state.choices=structuredClone(choices);await original.save();
  const baseCall=original.call;
  const r=f.make({call:async(action,input)=>{
    const value=await baseCall(action,input);
    if(action==='onboarding-rules')value.proposal.result={suggestions:[]};
    return value;
  }});
  await r.load();assert.equal(r.state.loaded,true);assert.equal(r.state.editing,false);
  r.confirm(true);await r.publish();assert.equal(r.state.publication.status,'published');
});

test('pending rule publication stays scoped to its warehouse when another review is opened',async()=>{
  const f=fixture();let r=f.make();await r.load();r.state.choices=structuredClone(choices);await r.save();r.confirm(true);
  f.backend.lose='onboarding-rule-publish';await r.publish();
  const pending=structuredClone(r.state.pending);
  const other=f.make({warehouseId:'other-warehouse'});other.restore();assert.equal(other.state.pending,null);
  other.persist();r=f.make();r.restore();assert.deepEqual(r.state.pending,pending);
  await r.load();assert.equal(r.state.publication.ontology_id,'published');
});
test('lost publication response is recovered without publishing or generating again',async()=>{
  const f=fixture();let r=f.make();await r.load();r.state.choices=structuredClone(choices);await r.save();r.confirm(true);
  f.backend.lose='onboarding-rule-publish';await r.publish();
  r=f.make();await r.load();assert.equal(r.state.publication.ontology_id,'published');assert.equal(r.state.pending,null);
  assert.equal(f.calls.filter(c=>c.action==='onboarding-rule-publish').length,1);
});
test('another account never restores pending rule writes and late reads are discarded',async()=>{
  const f=fixture(),r=f.make();await r.load();r.state.choices=structuredClone(choices);f.backend.lose='onboarding-rule-prepare';await r.save();
  const other=f.make({identity:{boxId:'box',user:{id:2},dataScope:'personal'}});other.restore();assert.equal(other.state.pending,null);
  let resolve;const late=f.make({call:()=>new Promise(r=>resolve=r)});const loading=late.load();late.reset();resolve({publication:{status:'published'}});await loading;
  assert.deepEqual(late.state,{});
});
test('rule actions reject path injection, scope overrides, extra operation aliases and missing publication confirmation',()=>{
  assert.equal(onboardingRequest('onboarding-rules',{warehouseId:'w',suggestionId:'p'}).path,'/warehouses/w/modeling/answer-suggestions/p/rules');
  assert.throws(()=>onboardingRequest('onboarding-rules',{warehouseId:'w',suggestionId:'../p'}));
  assert.throws(()=>onboardingRequest('onboarding-rule-publish',{warehouseId:'w',previewId:'p',body:{operation_id:'op',schema_digest:'a'.repeat(64),confirmed:false}}));
  assert.throws(()=>onboardingRequest('onboarding-rule-publish',{warehouseId:'w',previewId:'p',body:{operation_id:'op',_native_operation_id:'op',schema_digest:'a'.repeat(64),confirmed:true}}));
  assert.match(ruleMessage({code:'SEMANTICA_OPERATION_NOT_ALLOWED'}),/Host 通道尚未接入/);
});
