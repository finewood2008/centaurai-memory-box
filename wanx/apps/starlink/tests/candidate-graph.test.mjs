import test from 'node:test';
import assert from 'node:assert/strict';
import {candidateNetwork,readCandidateNetwork,currentCandidateGraph,candidateGraphKey,candidateNetworkHTML} from '../ui/conversation-candidate-graph.mjs';
import {candidateHTML} from '../ui/conversation-view.mjs';
const entity=(key,name=key)=>({kind:'entity',candidate_key:key,payload:{name,type:'ORG',properties:{备注:'原文属性'}},evidence:[{excerpt:'合成原文'}]});
const relation=(a,b)=>({kind:'relation',candidate_key:'link',payload:{type:'USES',source_candidate_key:a,target_candidate_key:b},evidence:[{excerpt:'关系依据'}]});
test('candidate legend, focus, nodes and details share current ontology labels without changing type codes',async()=>{
  const unknown={...entity('u'),payload:{name:'未知实体',type:'CUSTOM_TYPE'}},items=[entity('a'),entity('b'),relation('a','b'),unknown];
  const raw=JSON.stringify(items),flow=fixture(items),data=await readCandidateNetwork(flow);
  flow.state.ontology={schema:{entity_types:[{name:'ORG',label:'组织'}],relation_types:[{name:'USES',label:'使用'}]}};
  flow.state.candidateGraph=data;flow.state.candidateView='graph';data.selected='2';
  const html=candidateHTML(flow);
  assert.match(html,/组织/);assert.match(html,/<span class="cv-fact-type">使用<\/span>/);assert.match(html,/CUSTOM_TYPE/);assert.match(html,/#7b8490/);
  assert.doesNotMatch(html,/>ORG<|>USES<|CONCEPT/);
  flow.state.ontology.schema.entity_types[0].label='机构';
  assert.match(candidateHTML(flow),/机构/);assert.doesNotMatch(candidateHTML(flow),/组织/);
  flow.state.candidateView='list';assert.match(candidateHTML(flow),/<span class="cv-fact-type">机构<\/span>/);
  assert.equal(JSON.stringify(items),raw);
});
function fixture(items){
  const detail={id:'intent',revision:3,document_version_id:'v',execution:{id:'run'},status:'awaiting_review',source_status:'available'};
  const calls=[];
  const flow={saved:{conversationId:'session'},state:{detail,candidates:{items:items.slice(0,20),offset:0,total:items.length}},calls,
    read:async(action,input)=>{calls.push({action,input});return action==='conversation-candidates'?{execution_id:'run',items:items.slice(input.offset,input.offset+input.limit),offset:input.offset,total:items.length}:{...detail};}};
  return flow;
}
test('graph loads beyond the first page and connects cross-page entity identities',async()=>{
  const items=[entity('a','同名'),relation('a','b'),...Array.from({length:49},(_,i)=>entity('x'+i)),entity('b','同名')],flow=fixture(items);
  const data=await readCandidateNetwork(flow),network=candidateNetwork(data.items);
  assert.equal(data.total,52);assert.equal(data.items.length,52);
  assert.deepEqual(flow.calls.filter(c=>c.action==='conversation-candidates').map(c=>c.input.offset),[0,50]);
  assert.equal(network.edges.length,1);assert.notEqual(network.edges[0].s,network.edges[0].t);
  assert.equal(network.nodes.length,51);assert.equal(flow.state.candidates.items.length,20);
});
test('missing or ambiguous endpoints never create invented links; self and parallel links survive',()=>{
  const network=candidateNetwork([entity('a'),entity('b'),relation('a','a'),relation('a','b'),relation('b','a'),relation('missing','a')]);
  assert.equal(network.edges.length,3);assert.equal(network.unresolved,1);
  assert.equal(candidateNetwork([entity('a'),entity('a'),relation('a','a')]).edges.length,0);
});
test('source changes and inconsistent pages reject the entire graph',async()=>{
  for(const variant of ['execution','revision','total','offset','empty']){
    const flow=fixture(Array.from({length:60},(_,i)=>entity(String(i)))),read=flow.read;
    flow.read=async(action,input)=>{const v=await read(action,input);
      if(action==='conversation-intent'&&variant==='revision')v.revision++;
      if(action==='conversation-candidates'){
        if(variant==='execution')v.execution_id='other';
        if(variant==='offset')v.offset++;
        if(input.offset&&variant==='total')v.total++;
        if(variant==='empty')v.items=[];
      }return v;};
    await assert.rejects(readCandidateNetwork(flow),{code:'MODELING_SNAPSHOT_CHANGED'});
  }
});
test('graph preview is bounded and explicitly reports partial loading',async()=>{
  const flow=fixture(Array.from({length:1002},(_,i)=>entity(String(i)))),data=await readCandidateNetwork(flow);
  assert.equal(data.items.length,1000);assert.equal(data.total,1002);
  const html=candidateNetworkHTML(data);assert.match(html,/1000 \/ 1002/);assert.match(html,/最多加载 1000 项/);
  assert.equal((html.match(/class="cv-network-node/g)||[]).length,40);
});
test('stale, changed or different materials cannot display a cached graph',async()=>{
  const flow=fixture([entity('a')]);flow.state.candidateGraph=await readCandidateNetwork(flow);
  assert.ok(currentCandidateGraph(flow));flow.state.detail.revision++;assert.equal(currentCandidateGraph(flow),null);
  flow.state.detail.revision--;flow.saved.conversationId='other';assert.equal(currentCandidateGraph(flow),null);
  flow.saved.conversationId='session';flow.state.detail.source_status='source_changed';assert.equal(currentCandidateGraph(flow),null);
});
test('graph detail escapes labels, preserves evidence and keeps publication confirmation separate',async()=>{
  const flow=fixture([entity('a','<img onerror=x>'),entity('b','乙公司'),relation('a','b')]);
  flow.state.candidateGraph=await readCandidateNetwork(flow);flow.state.candidateGraph.selected='2';flow.state.candidateView='graph';
  const html=candidateHTML(flow);assert.match(html,/未发布/);assert.match(html,/&lt;img onerror=x&gt; → 乙公司/);
  assert.match(html,/关系依据/);assert.doesNotMatch(html,/<img|data-cv="change-publish"/);
  assert.match(html,/data-cv="review"/);assert.doesNotMatch(html,/data-cv="candidates-next"/);
  flow.state.candidateView='list';assert.match(candidateHTML(flow),/data-cv="candidates-next"/);
});
test('focusing an entity limits edges to direct neighbors without mutating candidates',()=>{
  const items=[entity('a'),entity('b'),entity('c'),relation('a','b'),relation('b','c')],before=JSON.stringify(items);
  const data={items,total:5,selected:null,focus:'0',zoom:1,key:candidateGraphKey(fixture(items))};
  const html=candidateNetworkHTML(data);assert.equal((html.match(/class="cv-network-node/g)||[]).length,2);
  assert.equal((html.match(/class="cv-network-edge/g)||[]).length,1);assert.equal(JSON.stringify(items),before);
});
