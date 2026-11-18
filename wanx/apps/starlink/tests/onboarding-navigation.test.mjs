import test from 'node:test';
import assert from 'node:assert/strict';
import {enterOnboardingWarehouse} from '../ui/onboarding-navigation.mjs';
import {conversationHTML,readConversationOnboarding} from '../ui/conversation.js';
import {materialListHTML} from '../ui/material-workspace.mjs';
import {ruleReviewKey} from '../ui/onboarding-notes.mjs';
import {completedOnboardingWarehouse} from '../ui/onboarding-state.mjs';

test('startup enters a completed warehouse only after authoritative recovery',()=>{
  const warehouse={id:'created',state:'active'},other={id:'last-used',state:'active'};
  const state={loaded:true,step:'result',warehouse,warehouses:[warehouse,other],proposal:{id:'p'},
    context:{rule_review:{proposal_id:'p',publication:{status:'published'}}}};
  assert.equal(completedOnboardingWarehouse(state),warehouse);
  assert.equal(completedOnboardingWarehouse(state,other.id),other);
  assert.equal(completedOnboardingWarehouse(state,'deleted'),warehouse);
  for(const patch of [{loaded:false},{busy:true},{error:'offline'},{needsReview:true},{pending:{}},{creation:{}},
    {answerEdit:{}},{step:'details'},{step:'confirm'},{warehouse:null},{warehouses:[other]},
    {proposal:{id:'new-batch'}},{context:null},{context:{rule_review:{proposal_id:'p',publication:{status:'running'}}}}]) {
    assert.equal(completedOnboardingWarehouse({...state,...patch}),null);
  }
  state.context.rule_review.publication.status='reused_existing';
  assert.equal(completedOnboardingWarehouse(state),warehouse);
});

test('current unresolved questions survive failed/stale generation and override historical publication notes',async()=>{
  for(const status of ['failed','stale']){
    const proposal={id:'p',status,valid:false,can_review:false,unresolved_questions:['receipt question']};
    const context={proposal,unresolved_questions:['当前问题'],rule_review:{proposal_id:'p',publication:{status:'published',unresolved_questions:['历史问题']}}};
    const options={warehouseId:'w',isCurrent:()=>true,call:async action=>action==='onboarding-context'?context:proposal};
    let result=await readConversationOnboarding(options);
    assert.deepEqual(result.questions,['当前问题']);
    assert.doesNotMatch(conversationHTML({id:'w',state:'active'},null,result),/当前问题/);
    context.unresolved_questions=[];
    assert.deepEqual((await readConversationOnboarding(options)).questions,[]);
    delete context.unresolved_questions;delete context.rule_review;
    result=await readConversationOnboarding(options);
    assert.deepEqual(result.questions,['receipt question']);
    const html=conversationHTML({id:'w',state:'active'},null,result);
    assert.doesNotMatch(html,/receipt question/);assert.doesNotMatch(html,/已有候选可先核对/);
  }
});

function fixture(){
  const state={identity:{user:{id:1}},generation:1,ready:true,invalid:false,warehouseId:'old',view:'graph'};
  let current=true,committed=false,selected=false;
  const options={warehouseId:'new',snapshot:()=>({...state}),isCurrent:()=>current,
    readWarehouses:async()=>({items:[{id:'new',state:'active'}]}),
    commit:()=>{committed=true;},select:async(id,view)=>{selected=true;state.generation++;state.warehouseId=id;state.view=view;}};
  return {state,options,cancel:()=>{current=false;},get committed(){return committed;},get selected(){return selected;}};
}
test('confirmed warehouse entry selects the new warehouse conversation',async()=>{
  const f=fixture();await enterOnboardingWarehouse(f.options);
  assert.equal(f.state.warehouseId,'new');assert.equal(f.state.view,'conversation');
});
test('delayed list cannot commit or select after account, view or onboarding changes',async()=>{
  for(const change of [f=>{f.state.identity={user:{id:2}};},f=>{f.state.generation++;},f=>f.cancel(),f=>{f.state.invalid=true;}]){
    const f=fixture();let resolve;f.options.readWarehouses=()=>new Promise(r=>{resolve=r;});
    const pending=enterOnboardingWarehouse(f.options);change(f);resolve({items:[{id:'new',state:'active'}]});
    await assert.rejects(pending);assert.equal(f.committed,false);assert.equal(f.selected,false);
  }
});
test('inactive warehouse and silently refused navigation never count as successful entry',async()=>{
  const f=fixture();f.options.readWarehouses=async()=>({items:[{id:'new',state:'deleted'}]});
  await assert.rejects(enterOnboardingWarehouse(f.options));assert.equal(f.selected,false);
  const refused=fixture();refused.options.select=async()=>{};
  await assert.rejects(enterOnboardingWarehouse(refused.options));
});
test('account or selection changes during entry cannot complete the old flow',async()=>{
  for(const change of [f=>{f.state.identity={user:{id:2}};},f=>{f.state.generation++;},f=>f.cancel()]){
    const f=fixture();let finish;
    f.options.select=async(id,view)=>{f.state.warehouseId=id;f.state.view=view;f.state.generation++;await new Promise(r=>{finish=r;});};
    const pending=enterOnboardingWarehouse(f.options);await Promise.resolve();change(f);finish();
    await assert.rejects(pending);
  }
});
test('conversation loading escapes user text and never claims processing succeeded',()=>{
  const html=conversationHTML({id:'w',state:'active',name:'<img onerror=alert(1)>'},{status:'published',version_number:2,name:'确认本体',changed:true});
  assert.ok(!html.includes('<img'));assert.doesNotMatch(html,/生效版本：2/); // Old onboarding receipts are not proof of the current version.
  assert.match(html,/正在准备会话/);assert.doesNotMatch(html,/解析完成|已自动保存|版本：1/);
  assert.doesNotMatch(conversationHTML(null),/确认本体/);
});

const referenceProposal={id:'p',status:'succeeded',valid:true,result:{outcome:'needs_clarification',questions:['合同属于哪个业务？'],
  explanation:'需要明确用途',suggestions:[{kind:'entity',name:'CONTRACT',label:'<合同>'}]}};
test('material workspace omits onboarding suggestions and reset navigation',()=>{
  const html=conversationHTML({id:'w"',state:'active'},null,{proposal:referenceProposal});
  assert.doesNotMatch(html,/&lt;合同&gt;|合同属于哪个业务|建仓建议|核对并确认本体|data-warehouse-view="onboarding"/);
  assert.match(html,/当前仓库本体图谱/);assert.doesNotMatch(html,/mw-welcome-upload|data-cv="material-add"/);
  const list=materialListHTML({state:{loaded:true,materialIndex:{},intents:[],warehouseMaterialTotal:0},saved:{conversationId:'current'}});
  assert.doesNotMatch(list,/data-cv="material-add"/);
  assert.doesNotMatch(html,/已确认发布|data-rule="publish"/);
  const published=conversationHTML({id:'w',state:'active'},null,{proposal:referenceProposal,publication:{status:'published'}});
  assert.doesNotMatch(published,/继续补充回答/);assert.doesNotMatch(published,/&lt;合同&gt;/);
  assert.doesNotMatch(conversationHTML({id:'w',state:'active'},null,null,false),/data-warehouse-view="onboarding"/);
});

test('warehouse suggestion recovery reads existing receipts without generating or publishing',async()=>{
  const calls=[];
  const result=await readConversationOnboarding({warehouseId:'w',isCurrent:()=>true,call:async(action,input)=>{
    calls.push({action,input});return action==='onboarding-context'?{proposal:{id:'p'}}:referenceProposal;
  }});
  assert.deepEqual(result.proposal,referenceProposal);
  assert.deepEqual(calls,[{action:'onboarding-context',input:{warehouseId:'w'}},
    {action:'onboarding-suggestion',input:{warehouseId:'w',suggestionId:'p'}}]);
});

test('warehouse suggestion reads reject superseded sessions and mismatched receipts',async()=>{
  for(const boundary of ['context','suggestion']){
    let current=true;
    await assert.rejects(readConversationOnboarding({warehouseId:'w',isCurrent:()=>current,call:async action=>{
      if(action==='onboarding-'+boundary)current=false;
      return action==='onboarding-context'?{proposal:{id:'p'}}:referenceProposal;
    }}),/WAREHOUSE_CHANGED/);
  }
  await assert.rejects(readConversationOnboarding({warehouseId:'w',isCurrent:()=>true,call:async action=>
    action==='onboarding-context'?{proposal:{id:'p'}}:{...referenceProposal,id:'other'}}),/SEMANTICA_INVALID_RESPONSE/);
});

test('published question notes restore only for the matching actor and proposal; server empty list is authoritative',async()=>{
  const identity={boxId:'box',user:{id:1},dataScope:'personal'};
  const key=ruleReviewKey(identity,'w','p');
  const storage={getItem:k=>k===key?JSON.stringify({questions:['后续用途？']}):null};
  let publication={status:'published'},proposal={...referenceProposal,status:'stale',valid:false,result:undefined};
  const options={warehouseId:'w',identity,storage,isCurrent:()=>true,call:async action=>action==='onboarding-context'
    ?{proposal,rule_review:{proposal_id:'p',publication}}:proposal};
  assert.deepEqual((await readConversationOnboarding(options)).questions,['后续用途？']);
  assert.deepEqual((await readConversationOnboarding({...options,identity:{...identity,user:{id:2}}})).questions,[]);
  publication={...publication,unresolved_questions:[]};
  assert.deepEqual((await readConversationOnboarding(options)).questions,[]);
  proposal={...referenceProposal,id:'new',result:{outcome:'ready',questions:[],suggestions:[{kind:'entity',name:'NEW'}]}};
  const next=await readConversationOnboarding(options);
  assert.equal(next.publication,null);assert.deepEqual(next.questions,[]);
});
