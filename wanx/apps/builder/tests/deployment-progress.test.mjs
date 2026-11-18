import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
const result=await build({entryPoints:[new URL('../ui/deployment/model.ts',import.meta.url).pathname],bundle:true,platform:'node',format:'esm',write:false});
const model=await import('data:text/javascript;base64,'+Buffer.from(result.outputFiles[0].text).toString('base64'));
const operation='a'.repeat(32);
const event={sequence:1,operationId:operation,operationRevision:2,createdAt:100,type:'progress',state:'waiting_box',phase:'prepare_backend'};
const page=item=>({items:[item],nextCursor:1,hasMore:false});
test('event parser retains a safe reason after the operation has recovered',()=>{
 const value=model.parseEventPage(page({...event,errorCode:'DEPENDENCY_UNAVAILABLE',error:{message:'private-secret'}}),operation,0);
 assert.equal(value.items[0].errorCode,'DEPENDENCY_UNAVAILABLE');
 assert.ok(!('error' in value.items[0]));
});
test('old events without a reason remain readable',()=>{
 assert.equal(model.parseEventPage(page(event),operation,0).items[0].errorCode,undefined);
});
test('unknown and raw event reasons cannot become visible details',()=>{
 for(const errorCode of ['FUTURE_ERROR','https://private-host/token=secret',{message:'secret'}]) {
  const value=model.parseEventPage(page({...event,errorCode}),operation,0);
  assert.equal(value.items[0].errorCode,'ADAPTER_UNCERTAIN');
  assert.doesNotMatch(JSON.stringify(value),/private-host|secret|FUTURE_ERROR/);
 }
});
test('box-side waiting does not incorrectly claim the connection is lost',()=>{
 assert.equal(model.stateLabel('waiting_box'),'等待盒端处理');
 assert.equal(typeof model.progressReason,'function');
 assert.match(model.progressReason('DEPENDENCY_UNAVAILABLE'),/依赖服务/);
 assert.doesNotMatch(model.progressReason('DEPENDENCY_UNAVAILABLE'),/无法确认部署信息|盒子连接/);
 assert.doesNotMatch(model.progressReason('https://private-host/token=secret'),/secret|private-host/);
});
test('definite concurrency rejection tells the user to refresh and confirm again',()=>{
 assert.match(model.errorMessage(Error('DEPLOYMENT_ENVIRONMENT_BUSY')), /其他部署.*刷新.*重新确认/);
});

const {createElement}=await import('react');
const {renderToStaticMarkup}=await import('react-dom/server');
const rendered=await build({entryPoints:[new URL('../ui/deployment/DeploymentProgress.tsx',import.meta.url).pathname],bundle:true,platform:'node',format:'esm',jsx:'automatic',write:false,plugins:[{name:'shared-react',setup(builder){builder.onResolve({filter:/^react(?:\/.*)?$/},args=>({path:import.meta.resolve(args.path),external:true}))}}]});
const {OperationNotice,DeploymentEvents}=await import('data:text/javascript;base64,'+Buffer.from(rendered.outputFiles[0].text).toString('base64'));
test('a waiting operation is a status with safe reason and no resubmit action',()=>{
 const html=renderToStaticMarkup(createElement(OperationNotice,{operation:{state:'waiting_box',phase:'verify_candidate',errorCode:'DEPENDENCY_UNAVAILABLE'}}));
 assert.match(html,/role="status"/);assert.match(html,/验证待部署版本/);assert.match(html,/依赖服务/);assert.match(html,/无需重新提交/);
 assert.doesNotMatch(html,/role="alert"|deployment-error|<button|盒子连接/);
 assert.equal(renderToStaticMarkup(createElement(OperationNotice,{operation:{state:'succeeded',phase:'completed',errorCode:null}})),'');
});
test('history shows past reason and legacy absence without suggesting a current failure',()=>{
 const events=[{...event,errorCode:'DEPENDENCY_UNAVAILABLE'},{...event,sequence:2},{...event,sequence:3,state:'succeeded',phase:'completed'}];
 const html=renderToStaticMarkup(createElement(DeploymentEvents,{events,loading:false,error:'',hasMore:false,truncated:false,onLoad(){throw Error('read-only render');}}));
 assert.match(html,/当时原因：盒端依赖服务/);assert.match(html,/该历史记录未保存具体原因/);assert.match(html,/部署操作成功/);
 assert.doesNotMatch(html,/role="alert"|无法确认部署信息|重新提交/);
});
