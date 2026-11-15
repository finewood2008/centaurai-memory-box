import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {createPersonalDataService} from '../integration/personal-client/data-service.mjs';
import {createMaterialBrowser} from '../integration/team-client/starlink/materials.mjs';
import {unwrapMaterialResponse} from '../integration/team-client/starlink/material-contract.mjs';

const methods=['rename-warehouse','document-text','evidence','authorization-summary','governance-summary','governance-reviews','governance-detail','governance-resolve','governance-flag','governance-propose','governance-apply','governance-unflag'];
for(const edition of ['personal','team']){
  const source=await readFile(new URL(`../../${edition}-client/local-ui/remote-preload.cjs`,import.meta.url),'utf8');
  function fixture({failure}={}){
    const exposed={},calls=[],value={id:'server-receipt',revision:3};
    vm.runInNewContext(source,{process:{platform:'darwin'},require:name=>{
      assert.equal(name,'electron');return {webUtils:{},contextBridge:{exposeInMainWorld:(name,api)=>{exposed[name]=api;}},
        ipcRenderer:{on(){},removeListener(){},async invoke(channel,input){
          calls.push([channel,input]);
          if(channel!=='wanx-client:data')return {phase:'ready',account:{phase:'authenticated'}};
          if(failure){if(edition==='team')return {ok:false,code:failure};throw Error(failure);}
          return edition==='team'?{ok:true,value}:value;
        }}};
    }});
    return {api:exposed.wanxClient,calls,value};
  }
  test(`${edition} actual preload transports finite typed Starlink actions exactly once`,async()=>{
    const f=fixture();
    const available=edition==='personal'?[...methods,'material-workflows','material-workflow','material-preview','material-transition','material-transition-status']:methods;
    for(const action of available){
      const input={warehouseId:'12345678-1234-1234-1234-123456789abc',operationId:'12345678-1234-1234-1234-123456789def',expectedRevision:3,name:'新名称'};
      const result=await f.api.action('data.'+action,input);
      assert.equal(result.ok,true);assert.deepEqual(result.value,f.value);
      assert.deepEqual(JSON.parse(JSON.stringify(f.calls.findLast(([channel])=>channel==='wanx-client:data'))),['wanx-client:data',{action,input}]);
    }
    assert.equal(f.calls.filter(([channel])=>channel==='wanx-client:data').length,available.length);
  });
  test(`${edition} preload rejects arbitrary Starlink routes without sending them to IPC`,async()=>{
    const f=fixture();
    for(const action of ['data.workbench-request','data.governance-arbitrary','data.delete-warehouse','data.document-text-arbitrary']){
      assert.equal((await f.api.action(action,{url:'/api/governance',method:'POST'})).code,'UNKNOWN_CLIENT_ACTION');
    }
    assert.equal(f.calls.filter(([channel])=>channel==='wanx-client:data').length,0);
  });
  test(`${edition} preload retains service governance rejection as failure without a success value`,async()=>{
    const f=fixture({failure:'WAREHOUSE_GOVERNANCE_REVISION_CONFLICT'});
    const result=await f.api.action('data.governance-apply',{proposalId:'proposal'});
    assert.equal(result.ok,false);assert.equal(result.code,'WAREHOUSE_GOVERNANCE_REVISION_CONFLICT');assert.equal(result.value,undefined);
  });
}

test('personal material status crosses the actual preload and service, retaining HTTP 200 schema diagnostics',async()=>{
  const wid='12345678-1234-1234-1234-123456789abc',requests=[];
  let malformed=false,forbidden=false;
  const client={snapshot:()=>({phase:'ready',account:{phase:'authenticated',accountId:'owner',clientId:'client'},connection:{deviceId:'box',gatewayURL:'http://peer'}}),subscribe:()=>()=>{},applicationConnection:async()=>({context:()=>({user:{id:2},boxId:'box'}),subscribe:()=>()=>{},close(){},request:async input=>{
    requests.push(input.path);
    const workflow={document_id:malformed?'wrong':'doc',document_version_id:'v',workflow_revision:1,automatic_processing:{},actions:{edit_source:{allowed:false,reason:'正文版本受保护'},prepare_automatic:{allowed:true},reextract:{allowed:false}}};
    const isWorkflow=input.path.includes('/workbench/conversations/materials/');
    const value=isWorkflow?(forbidden?{code:'MODELING_OWNER_REQUIRED',detail:'secret must not cross diagnostics'}:workflow):input.path.includes('/text?')?{version_id:'v',text:'authorized-text'}:{document:{id:'doc'},version:{id:'v'}};
    return {status:isWorkflow&&forbidden?403:200,headers:{'x-request-id':'server-request'},body:Buffer.from(JSON.stringify(value))};
  }})};
  const service=createPersonalDataService({client,applications:{}}),exposed={};
  const source=await readFile(new URL('../../personal-client/local-ui/remote-preload.cjs',import.meta.url),'utf8');
  vm.runInNewContext(source,{process:{platform:'win32'},require:()=>({
    webUtils:{},contextBridge:{exposeInMainWorld:(name,api)=>exposed[name]=api},
    ipcRenderer:{on(){},removeListener(){},invoke:async(channel,input)=>channel==='wanx-client:data'?service.action(input.action,input.input):{phase:'ready',account:{phase:'authenticated'}}},
  })});
  const browser=createMaterialBrowser({personal:true,getContext:()=>({scope:'session',warehouseId:wid}),changed(){},call:async(action,input)=>{
    const result=await exposed.wanxClient.action('data.'+action,input);
    if(!result.ok)throw Object.assign(Error(result.code),{code:result.code});
    return unwrapMaterialResponse(result.value);
  }});
  const html=()=>browser.render({documents:[{id:'doc'}],total:1,offset:0});
  try{
    await browser.action('material-open',{id:'doc'});assert.match(html(),/正文版本受保护/);
    assert.doesNotMatch(html(),/data-data-action="reextract-document"[^>]*disabled/);
    malformed=true;await browser.action('material-open',{id:'doc'});assert.match(html(),/HTTP 200；MATERIAL_RESPONSE_INVALID；请求 server-request/);
    forbidden=true;const before=requests.filter(p=>p.includes('/text?')).length;
    await browser.action('material-open',{id:'doc'});assert.match(html(),/HTTP 403；MODELING_OWNER_REQUIRED/);
    assert.doesNotMatch(html(),/authorized-text|secret must not/);assert.equal(requests.filter(p=>p.includes('/text?')).length,before);
  }finally{browser.reset();service.close();}
});
