import{test}from'node:test';import assert from'node:assert/strict';
import{createProjectPreview}from'../integration/project-preview.mjs';
const id='a'.repeat(32),hash='b'.repeat(64);
function layout(session,artifactHash){return{session,packageSha256:hash,standardLayout:{artifactHash,packageSha256:hash,format:'wanx-standard-layout-v1',document:'<!doctype html><p>Preview</p>'}}}
function setup(){const calls=[];const session={key:'scope',assertLive(){},async request(route,method,body){calls.push({route,method,body});return body?layout('private',body.artifactHash):{}}};return{view:createProjectPreview(async()=>session),calls}}
test('legacy preview is refused and its runtime lease is released',async()=>{
 const calls=[];const session={key:'scope',assertLive(){},async request(route,method){calls.push(method);return {session:'private',bundle:'legacy'}}};
 await assert.rejects(createProjectPreview(async()=>session).previewOpen({projectId:id,artifactHash:hash}),/STANDARD_PREVIEW_REQUIRED/);
 assert.deepEqual(calls,['POST','DELETE']);
});
test('new version revokes old preview handles and close is idempotent',async()=>{const h=setup(),one=await h.view.previewOpen({projectId:id,artifactHash:hash}),two=await h.view.previewOpen({projectId:id,artifactHash:'c'.repeat(64)});assert.ok(h.calls.some(v=>v.method==='DELETE'));await assert.rejects(h.view.previewInvoke({handle:one.handle,method:'data.get'}),/PREVIEW_STALE/);await h.view.previewClose({handle:two.handle});await h.view.previewClose({handle:two.handle});await assert.rejects(h.view.previewInvoke({handle:two.handle,method:'data.get'}),/PREVIEW_STALE/)});
test('late open results cannot replace current project',async()=>{let resolve;let n=0;const deleted=[];const s={key:'scope',assertLive(){},async request(route,method,body){if(method==='DELETE'){deleted.push(route);return{}};if(++n===1)return new Promise(r=>resolve=r);return layout('new',body.artifactHash)}};const h=createProjectPreview(async()=>s),old=h.previewOpen({projectId:id,artifactHash:hash});await new Promise(r=>setImmediate(r));const current=await h.previewOpen({projectId:'d'.repeat(32),artifactHash:hash});resolve({session:'old',bundle:'',css:''});await assert.rejects(old,/PREVIEW_STALE/);assert.ok(deleted.some(v=>v.endsWith('/old')));await assert.rejects(h.previewInvoke({handle:current.handle,method:'data.list'}),/EXPERT_DEPLOYMENT_REQUIRED/)});


test('standard runtime wire opens its verified offline layout without a legacy bundle or business calls',async()=>{
 const calls=[],document='<!doctype html><p>尚未部署，仅布局预览</p>',standardLayout={format:'wanx-standard-layout-v1',artifactHash:hash,packageSha256:'c'.repeat(64),document};
 const s={key:'scope',assertLive(){},async request(route,method,body){calls.push({route,method,body});return{session:'MAIN_ONLY',packageSha256:'c'.repeat(64),standardLayout}}};
 const view=createProjectPreview(async()=>s),opened=await view.previewOpen({projectId:id,artifactHash:hash});
 assert.equal(opened.document,document);assert.equal(opened.layoutOnly,true);assert.equal(opened.session,undefined);
 for(const [method,params] of [['data.list',{}],['model.list',{}],['foundation.invoke',{operation:'expert.tasks',input:{}}]])await assert.rejects(view.previewInvoke({handle:opened.handle,method,params}),/EXPERT_DEPLOYMENT_REQUIRED/);
 assert.equal(calls.length,1);await view.previewClose({handle:opened.handle});assert.equal(calls.at(-1).method,'DELETE');
});
