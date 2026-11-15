import test from 'node:test';
import assert from 'node:assert/strict';
import {createPersonalDataService} from '../integration/personal-client/data-service.mjs';
import {createTeamDataService} from '../integration/team-client/data-service.mjs';

const warehouseId='12345678-1234-1234-1234-123456789abc';
const operationId='12345678-1234-1234-1234-123456789def';
function setup(scope){
  let accountId='account',deviceId='box',generation=0,role='admin',response={status:200,value:{supported:true,review_count:1,paused_count:1}},pending;
  const requests=[],listeners=new Set();
  const client={
    snapshot:()=>({phase:'ready',account:{phase:'authenticated',accountId,clientId:'client'},connection:{deviceId,gatewayURL:'http://peer'}}),
    subscribe:fn=>(listeners.add(fn),()=>listeners.delete(fn)),
    async applicationConnection(){
      const captured=generation;let closed=false;
      function live(){if(closed||captured!==generation)throw Object.assign(Error('HOST_SESSION_EXPIRED'),{code:'HOST_SESSION_EXPIRED'});}
      return {context(){live();return {protocolVersion:1,accountId,clientId:'client',boxId:deviceId,user:{id:1,role}};},
        subscribe:fn=>(listeners.add(fn),()=>listeners.delete(fn)),close(){closed=true;},
        async request(input){
          live();requests.push(input);
          if(input.path==='/api/auth/me')return {status:200,headers:{},body:Buffer.from(JSON.stringify({id:1,role,application_id:'wanx'}))};
          const result=pending?await pending:response;
          return {status:result.status,headers:{},body:Buffer.from(JSON.stringify(result.value))};
        }};
    },
  };
  const service=(scope==='personal'?createPersonalDataService:createTeamDataService)({client,applications:{}});
  return {service,requests,
    respond(value,status=200){response={value,status};},defer(value){pending=value;},role(value){role=value;},
    switch(field){generation++;if(field==='device')deviceId='other-box';else accountId='other-account';for(const fn of [...listeners])fn();},
    writes:()=>requests.filter(request=>request.path.startsWith('/api/semantica/')&&request.method==='POST'),
  };
}

for(const scope of ['personal','team']){
  test(`${scope} warehouse labels come from the exact published ontology, not the first draft`,async()=>{
    const s=setup(scope);
    const original=s.service;
    try{
      // The transport fixture returns one object for both GETs; its items simulate version history.
      s.respond({id:warehouseId,current_ontology:{id:operationId,status:'published'},items:[
        {id:warehouseId,status:'draft',schema:{entity_types:[{name:'METRIC',label:'错误草稿'}]}},
        {id:operationId,status:'published',schema:{entity_types:[{name:'METRIC',label:'指标'}],relation_types:[{name:'MEASURES',label:'衡量'}]}}
      ]});
      const result=await original.action('warehouse',{id:warehouseId});
      assert.deepEqual(result.ontology_labels,{entities:{METRIC:'指标'},relations:{MEASURES:'衡量'}});
      assert(s.requests.some(r=>r.path===`/api/semantica/warehouses/${warehouseId}/workbench/ontologies`));
    }finally{s.service.close();}
  });
  test(`${scope} quick warehouse creation preserves request identity and ontology receipts`,async()=>{
    const s=setup(scope),input={operationId,name:'通用资料',description:''};
    const receipt={id:warehouseId,current_ontology:{id:operationId,status:'published',template_id:'personal_general',template_version:2,version_number:1}};
    try{
      s.respond(receipt);
      assert.deepEqual(await s.service.action('create-warehouse',input),receipt);
      await s.service.action('create-warehouse',input);
      const writes=s.writes();assert.equal(writes.length,2);
      assert.deepEqual(JSON.parse(writes[0].body),{operation_id:operationId,name:'通用资料',description:''});
      assert.deepEqual(writes[0].body,writes[1].body);
      s.respond({code:'WAREHOUSE_NAME_CONFLICT'},409);
      await assert.rejects(s.service.action('create-warehouse',input),{code:'WAREHOUSE_NAME_CONFLICT'});
    }finally{s.service.close();}
  });
  test(`${scope} document deletion requires confirmation and preserves scoped retry identity`,async()=>{
    const s=setup(scope),input={warehouseId,id:operationId,versionId:warehouseId,operationId,confirmed:true};
    try{
      await assert.rejects(s.service.action('delete-document',{...input,confirmed:false}),{code:'TEAM_DATA_TARGET_INVALID'});
      assert.equal(s.requests.filter(r=>r.method==='DELETE').length,0);
      s.respond({deleted:true});
      await s.service.action('delete-document',input);await s.service.action('delete-document',input);
      const writes=s.requests.filter(r=>r.method==='DELETE');assert.equal(writes.length,2);
      assert.equal(writes[0].path,`/api/semantica/warehouses/${warehouseId}/documents/${operationId}`);
      assert.deepEqual(JSON.parse(writes[0].body),{operation_id:operationId,expected_version_id:warehouseId});
      assert.deepEqual(writes[0].body,writes[1].body);
    }finally{s.service.close();}
  });
  test(`${scope} unsupported governance summary is a capability result, not empty reviews`,async()=>{
    const s=setup(scope);
    try{
      s.respond({code:'SEMANTICA_OPERATION_NOT_ALLOWED'},404);
      assert.deepEqual(await s.service.action('governance-summary',{warehouseId}),{supported:false});
      await assert.rejects(s.service.action('governance-reviews',{warehouseId}),{code:'SEMANTICA_OPERATION_NOT_ALLOWED'});
      s.respond({code:'SEMANTICA_RESOURCE_FORBIDDEN'},403);
      await assert.rejects(s.service.action('governance-summary',{warehouseId}),{code:'SEMANTICA_RESOURCE_FORBIDDEN'});
    }finally{s.service.close();}
  });
  test(`${scope} authorization summary rejects incomplete or mismatched warehouse responses`,async()=>{
    const s=setup(scope);try{
      s.respond({id:warehouseId,name:'fixture'});
      await assert.rejects(s.service.action('authorization-summary',{warehouseId}),{code:'TEAM_DATA_RESPONSE_INVALID'});
      s.respond({id:'other-warehouse',items:[]});
      await assert.rejects(s.service.action('authorization-summary',{warehouseId}),{code:'TEAM_DATA_RESPONSE_INVALID'});
      assert.equal(s.writes().length,0);
    }finally{s.service.close();}
  });
  test(`${scope} governance uses only warehouse-bound private routes and retains actual server state`,async()=>{
    const s=setup(scope),prefix=`/api/semantica/warehouses/${warehouseId}/workbench/governance`;
    try{
      assert.deepEqual(await s.service.action('governance-summary',{warehouseId}),{supported:true,review_count:1,paused_count:1});
      assert.equal(s.requests.at(-1).path,prefix+'/summary');
      await s.service.action('governance-reviews',{warehouseId,offset:20,limit:10});
      assert.equal(s.requests.at(-1).path,prefix+'/reviews?offset=20&limit=10');
      const detail={id:'review_1',revision:4,evidence:[{document_id:'doc',document_version_id:'v1',excerpt:'existing source'}],actions:[{id:'unflag',label:'解除暂停'}]};
      s.respond(detail);
      assert.deepEqual(await s.service.action('governance-detail',{warehouseId,reviewId:'review_1'}),detail);
      assert.equal(s.requests.at(-1).path,prefix+'/reviews/review_1');
      assert(s.requests.filter(r=>r.path.startsWith('/api/semantica/')).every(r=>r.method==='GET'&&(scope==='team'?r.headers['x-wanx-data-context']==='team':!r.headers['x-wanx-data-context'])));
      s.respond({code:'WAREHOUSE_GOVERNANCE_UNAVAILABLE'},503);
      await assert.rejects(s.service.action('governance-summary',{warehouseId}),{code:'WAREHOUSE_GOVERNANCE_UNAVAILABLE'});
    }finally{s.service.close();}
  });
  test(`${scope} governance writes bind revision, explicit confirmation and the same signed retry operation`,async()=>{
    const s=setup(scope),prefix=`/api/semantica/warehouses/${warehouseId}/workbench/governance`;
    const body={operation_id:operationId,expected_revision:4,_native_operation_id:operationId};
    const cases=[
      ['governance-flag',{kind:'entity',targetId:'entity_1',expectedRevision:0},'/flag',{...body,expected_revision:0,kind:'entity',target_id:'entity_1',reason:'用户标记待核对'}],
      ['governance-resolve',{reviewId:'review_1',actionId:'keep_pending',reason:'证据不足'},'/reviews/review_1/resolve',{...body,action_id:'keep_pending',reason:'证据不足'}],
      ['governance-propose',{reviewId:'review_1',reason:'根据已绑定来源修正'},'/proposals',{...body,review_id:'review_1',reason:'根据已绑定来源修正'}],
      ['governance-apply',{proposalId:'proposal_1',confirmed:true},'/proposals/proposal_1/apply',{...body,confirmed:true}],
      ['governance-unflag',{reviewId:'review_1'},'/unflag',{...body,review_id:'review_1'}],
    ];
    try{
      for(const [action,input,suffix,wire]of cases){
        const request={warehouseId,operationId,expectedRevision:4,...input};
        await s.service.action(action,request);await s.service.action(action,request);
        const last=s.writes().slice(-2);
        assert.equal(last.length,2);assert(last.every(r=>r.path===prefix+suffix));
        assert.deepEqual(JSON.parse(last[0].body),wire);assert.deepEqual(JSON.parse(last[1].body),wire);
      }
    }finally{s.service.close();}
  });
  test(`${scope} governance rejects missing bindings, arbitrary paths and unconfirmed corrections before transport`,async()=>{
    const s=setup(scope),common={warehouseId,operationId,expectedRevision:4};
    const invalid=[
      ['governance-summary',{warehouseId,workspaceId:'other'}],
      ['governance-reviews',{warehouseId,offset:-1}],['governance-reviews',{warehouseId,limit:51}],
      ['governance-detail',{warehouseId,reviewId:'../review'}],
      ['governance-flag',{...common,kind:'person',targetId:'entity'}],
      ['governance-flag',{...common,kind:'entity',targetId:'../other'}],
      ['governance-flag',{...common,kind:'entity',targetId:'entity',expectedRevision:-1}],
      ['governance-flag',{...common,kind:'entity',targetId:'entity',operationId:undefined}],
      ['governance-resolve',{...common,reviewId:'review',actionId:'unflag',expectedRevision:0}],
      ['governance-resolve',{...common,reviewId:'review',actionId:'unflag',url:'https://other'}],
      ['governance-propose',{...common,reviewId:'review',reason:' '}],
      ['governance-propose',{...common,reviewId:'review',reason:'x'.repeat(2001)}],
      ['governance-apply',{...common,proposalId:'proposal',confirmed:false}],
      ['governance-unflag',{...common,reviewId:'review',operationId:'different'}],
    ];
    try{
      for(const [action,input]of invalid)await assert.rejects(s.service.action(action,input),{code:'TEAM_DATA_TARGET_INVALID'});
      assert.equal(s.requests.filter(r=>r.path.startsWith('/api/semantica/')).length,0);
      await assert.rejects(s.service.action('workbench-request',{url:'/api/settings'}),{code:'TEAM_DATA_ACTION_DENIED'});
      if(scope==='team'){s.role('user');await assert.rejects(s.service.action('governance-summary',{warehouseId}),{code:'TEAM_ADMIN_REQUIRED'});}
    }finally{s.service.close();}
  });
  for(const field of ['account','device'])test(`${scope} ignores late governance responses after ${field} changes`,async()=>{
    const s=setup(scope);let finish;s.defer(new Promise(resolve=>finish=resolve));
    const request=s.service.action('governance-detail',{warehouseId,reviewId:'review'});
    await new Promise(resolve=>setImmediate(resolve));s.switch(field);finish({status:200,value:{id:'old-review',revision:1}});
    try{await assert.rejects(request);}finally{s.service.close();}
  });
  test(`${scope} existing task retries preserve a caller operation ID`,async()=>{
    const s=setup(scope);try{
      for(const action of ['create-warehouse','retry-job','build-index']){
        const input={name:'isolated fixture',warehouseId,id:'job',operationId};
        await s.service.action(action,input);await s.service.action(action,input);
        assert(s.writes().slice(-2).every(r=>JSON.parse(r.body).operation_id===operationId));
      }
      const count=s.writes().length;
      await assert.rejects(s.service.action('retry-job',{warehouseId,id:'job',operationId:'invalid'}),{code:'TEAM_DATA_TARGET_INVALID'});
      assert.equal(s.writes().length,count);
    }finally{s.service.close();}
  });
}
