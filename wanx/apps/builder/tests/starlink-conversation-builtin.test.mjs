import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {SemanticaService} from '../../team-client/applications/starlink/shell/service.mjs';
import {conversationActions} from '../../team-client/applications/starlink/shared/conversation-contract.mjs';
import {createHostClient} from '../../personal-client/host-sdk/index.cjs';

const warehouseId='10000000-0000-4000-8000-000000000001';
const base='/api/semantica/warehouses/'+warehouseId+'/workbench/conversations/conversation/intents/intent';
const input={warehouseId,conversationId:'conversation',intentId:'intent',operationId:'synthetic-change'};
const cases=[
  ['context','/change-context',{}, {_native_operation_id:input.operationId,selected_item_ids:[]}],
  ['generate','/change-proposals',{contextDigest:'a'.repeat(64),instruction:'核对合同日期'},
    {_native_operation_id:input.operationId,operation_id:input.operationId,selected_item_ids:[],context_digest:'a'.repeat(64),instruction:'核对合同日期'}],
  ['read','/change-proposals/proposal/read',{proposalId:'proposal'},{_native_operation_id:input.operationId}],
  ['apply','/change-proposals/proposal/apply',{proposalId:'proposal',proposalDigest:'b'.repeat(64),confirmed:true},
    {_native_operation_id:input.operationId,operation_id:input.operationId,proposal_digest:'b'.repeat(64),confirmed:true}],
];

test('the pinned builtin exposes the material conversation and publication actions',()=>{
  for(const name of ['ontologies','published-run','editor-claim',...['context','generate','read','apply','draft','items','preview','publication','source','heartbeat','publish','publish-retry','draft-create','rule-publish'].map(x=>'change-'+x)])
    assert.equal(conversationActions.has('conversation-'+name),true,name);
});

for(const edition of ['personal-client','team-client']) {
  test(`${edition}: the pinned builtin sends conversation changes through its real Host and SDK`,async t=>{
    const {createApplicationSession}=await import(`../../${edition}/app-host/session.mjs`);
    const {createDashboardGateway}=await import(`../../${edition}/octop/gateway.mjs`);
    const seen=[];
    const box=http.createServer(async(req,res)=>{
      const chunks=[];for await(const chunk of req)chunks.push(chunk);
      seen.push({path:req.url,method:req.method,body:JSON.parse(Buffer.concat(chunks)),origin:req.headers.origin,authorization:req.headers.authorization});
      res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'});
      res.end(JSON.stringify({resource_id:'synthetic-proposal',status:'prepared'}));
    });
    box.listen(0,'127.0.0.1');await once(box,'listening');
    const gateway=await createDashboardGateway({targetURL:`http://127.0.0.1:${box.address().port}`,session:{getToken:()=>'synthetic-box-token',close(){}}});
    const session=await createApplicationSession({hostApplicationId:'wanx-host',applicationId:'centaurai.wanx.semantica',installPath:'/synthetic/starlink',
      createConnection:()=>({context:()=>({boxId:'synthetic-box',user:{id:1},dataScope:'personal',connection:'ready'}),request:options=>gateway.request(options),subscribe:()=>()=>{}})});
    const client=createHostClient({baseURL:session.environment.WANX_HOST_BASE_URL,token:session.environment.WANX_HOST_TOKEN});
    const service=new SemanticaService({host:client});
    t.after(async()=>{service.invalidate();client.close();await session.close();await gateway.close();box.closeAllConnections();await new Promise(resolve=>box.close(resolve));});
    for(const [action,suffix,extra,body] of cases){
      assert.deepEqual(await service.call('conversation-change-'+action,{...input,...extra}),{resource_id:'synthetic-proposal',status:'prepared'});
      assert.deepEqual(seen.at(-1),{path:base+suffix,method:'POST',body,origin:undefined,authorization:'Bearer synthetic-box-token'});
    }
    assert.equal(seen.length,4,'each operation is forwarded once');
  });
}
