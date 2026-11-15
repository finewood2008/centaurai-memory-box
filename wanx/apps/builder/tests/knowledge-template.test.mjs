import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRepository} from '../templates/knowledge-qa/src/repository.js';
import {answer,retrieve,validateAnswer,parseJSON,fingerprint,allowedScores} from '../templates/knowledge-qa/src/engine.js';
import {packTemplate} from '../templates/pack.mjs';
import {workshopTemplates,workshopTemplate} from '../templates/catalog.mjs';
import {createPersonalWorkshop} from '../integration/personal-client/workshop-service.mjs';

const templateRoot=new URL('../templates/knowledge-qa/',import.meta.url);
const defaults=JSON.parse(await readFile(new URL('src/config.json',templateRoot),'utf8'));
const settings={...defaults,threshold:0.2};
const document={_id:'doc-a',title:'培训证明',body:'申请培训证明请在学习中心提交申请，由培训负责人核对学习记录。',status:'published',digest:'synthetic'};
const base={settings,documents:[document],canons:[]};
const generate=async()=>({text:JSON.stringify({answer:'请在学习中心提交申请。[1]',claims:[{id:'1',quote:'在学习中心提交申请'}]})});

function fixture(){
 const tables=new Map();let serial=0;
 const api={model:{generate},files:{select:async()=>[{id:'selected',name:'合成培训资料.txt'}],read:async()=>({text:document.body})},data:{
  list:async({collection,offset=0,limit=200})=>{const all=[...(tables.get(collection)||new Map()).values()];return{items:structuredClone(all.slice(offset,offset+limit)),total:all.length};},
  get:async({collection,id})=>structuredClone(tables.get(collection)?.get(id)||null),
  put:async({collection,id,value,expectedRevision=0})=>{const rows=tables.get(collection)||new Map();tables.set(collection,rows);id||='record-'+(++serial);const old=rows.get(id);if(expectedRevision!==(old?._revision||0))throw Error('RECORD_CHANGED');const row={...old,...value,_id:id,_revision:expectedRevision+1};rows.set(id,row);return structuredClone(row);},
  delete:async({collection,id,expectedRevision})=>{const rows=tables.get(collection);if(rows.get(id)?._revision!==expectedRevision)throw Error('RECORD_CHANGED');rows.delete(id);return{deleted:true};}
 }};
 return{api,repo:createRepository(api),tables};
}

test('editable source matches the current compiler, catalog and recursive source digest',async()=>{
 const source=await packTemplate(templateRoot.pathname,{applicationId:'centaurai.wanx.template.knowledge-qa',version:'0.3.0'});
 const installed=workshopTemplate('template:knowledge-qa');assert.deepEqual(source,installed);
 const manifest=JSON.parse(source.files['miniapp.manifest.json']);assert.deepEqual(manifest.capabilities,['data','model','files','knowledge','dialogue']);
 assert.ok(workshopTemplates()[0].description.includes('星图知识库'));
 installed.files['src/config.json']='{}';assert.notEqual(workshopTemplate('template:knowledge-qa').files['src/config.json'],'{}');
 assert.equal(workshopTemplate('unknown'),null);
});
test('only published documents are retrieved and evidence ids refer to actual text',()=>{
 const result=retrieve('培训证明',[document,{...document,_id:'draft',status:'draft'},{...document,_id:'retired',status:'retired'}],0.2);
 assert.equal(result.length,1);assert.equal(result[0].documentId,'doc-a');assert.equal(result[0].id,'1');
 assert.deepEqual(retrieve('银河系的火山',[document],0.35),[]);
});
test('published canon is returned verbatim and draft canons never answer',async()=>{
 const canon={_id:'c',question:'费用是多少？\n培训费用',answer:'合成口径：¥128.50，保留原文。',status:'published'};
 let calls=0;const model=async()=>{calls++;throw Error('must not call');};
 const result=await answer('费用是多少',{settings,documents:[],canons:[canon]},model);
 assert.equal(result.answer,canon.answer);assert.equal(result.canonId,'c');assert.equal(calls,0);
 assert.equal((await answer('费用是多少',{settings,documents:[],canons:[{...canon,status:'draft'}]},model)).kind,'handoff');
});
test('unknown questions and explicit human requests hand off without calling the model',async()=>{
 let calls=0;const model=async()=>{calls++;throw Error('must not call');};
 assert.equal((await answer('银河系的火山',base,model)).kind,'handoff');
 assert.equal((await answer('我要转人工',base,model)).kind,'handoff');assert.equal(calls,0);
});
test('grounded model answer passes, hallucinated/missing citations or fabricated quotes fail closed',async()=>{
 assert.equal((await answer('申请培训证明',base,generate)).kind,'answer');
 for(const value of [{answer:'没有编号',claims:[]},{answer:'答案[99]',claims:[{id:'99',quote:document.body}]},{answer:'答案[1]',claims:[{id:'1',quote:'资料里没有这段话'}]},{answer:'答案[0]',claims:[]}]){
  const result=await answer('培训证明',base,async()=>({text:JSON.stringify(value)}));assert.equal(result.kind,'handoff');
 }
 assert.equal(validateAnswer({answer:'文本[1]',claims:[{id:'1',quote:'在学习中心提交申请'}]},[{id:'1',text:document.body}]),'文本[1]');
 assert.throws(()=>parseJSON('not json'));assert.throws(()=>parseJSON('[]'));
});
test('model outages and malformed output create handoff results',async()=>{
 for(const model of [async()=>{throw Error('upstream');},async()=>({text:'not json'})])assert.equal((await answer('培训证明',base,model)).kind,'handoff');
});
test('unpublished and irrelevant text never enters the model prompt',async()=>{
 let prompt='';const documents=[document,{...document,_id:'private',status:'draft',body:'DO_NOT_SEND'}];
 await answer('培训证明',{...base,documents},async args=>{prompt=args.prompt;return generate();});
 assert.ok(!prompt.includes('DO_NOT_SEND'));assert.ok(prompt.includes(document.body));
});
test('a copied repository starts empty, file selection creates drafts and edits use revisions',async()=>{
 const {repo}=fixture();assert.equal((await repo.snapshot()).documents.length,0);
 const [row]=await repo.importFiles();assert.equal(row.status,'draft');assert.ok(row.sourceId);
 await repo.documentStatus(row,'published');await assert.rejects(()=>repo.documentStatus(row,'retired'),/RECORD_CHANGED/);
 const other=fixture();assert.equal((await other.repo.snapshot()).documents.length,0);
});
test('human replies create drafts and do not publish or claim channel delivery',async()=>{
 const {repo}=fixture();await repo.ask('未知的问题');let data=await repo.snapshot();
 assert.equal(data.handoffs.length,1);const ticket=data.handoffs[0];
 await repo.reply(ticket,'人工确认的合成答复');data=await repo.snapshot();
 assert.equal(data.handoffs[0].status,'replied');assert.equal(data.canons[0].status,'draft');assert.equal(data.canons[0].source,'human_reply');
 await assert.rejects(()=>repo.reply(ticket,'重复答复'),/RECORD_CHANGED/);
 const published=await repo.reviewCanon(data.canons[0],'published');assert.equal(published.status,'published');
 const turn=await repo.ask('未知的问题');assert.equal(turn.answer,'人工确认的合成答复');
});
test('feedback links an unresolved answer to one pending ticket and rejects stale duplicate feedback',async()=>{
 const {repo}=fixture();const c=await repo.saveCanon({question:'常见问题',answer:'合成口径'});await repo.reviewCanon(c,'published');
 const turn=await repo.ask('常见问题');await repo.feedback(turn,'unresolved');await assert.rejects(()=>repo.feedback(turn,'human'),/RECORD_CHANGED/);
 const data=await repo.snapshot();assert.equal(data.handoffs.length,1);assert.equal(data.handoffs[0].turnId,turn._id);
});
test('interrupted human reply can resume without duplicating its draft',async()=>{
 const {repo,api}=fixture();await repo.ask('资料外问题');const ticket=(await repo.snapshot()).handoffs[0];
 const original=api.data.put;let fail=true;
 api.data.put=async args=>{if(fail&&args.collection==='handoffs'&&args.value.status==='replied'){fail=false;throw Error('interrupted');}return original(args);};
 await assert.rejects(()=>repo.reply(ticket,'合成人工答复'),/interrupted/);
 const pending=(await repo.snapshot()).handoffs[0];assert.equal(pending.status,'replying');
 await repo.reply(pending,pending.answer);const data=await repo.snapshot();
 assert.equal(data.canons.length,1);assert.equal(data.handoffs[0].status,'replied');assert.equal(data.canons[0].status,'draft');
});
test('regression runs have no session/ticket side effects and opening requires human scores',async()=>{
 const {repo}=fixture();const canon=await repo.saveCanon({question:'常见问题',answer:'标准原文'});await repo.reviewCanon(canon,'published');
 await repo.saveTest({question:'常见问题',expected:'answer',contains:'标准原文'});
 await repo.saveTest({question:'资料外问题',expected:'handoff',contains:''});
 await assert.rejects(()=>repo.open(true),/ACCEPTANCE_REQUIRED/);
 const run=await repo.runTests();let data=await repo.snapshot();assert.equal(data.turns.length,0);assert.equal(data.handoffs.length,0);
 await assert.rejects(()=>repo.open(true),/ACCEPTANCE_REQUIRED/);
 const results=JSON.parse(run.results).map(r=>({...r,humanScore:1}));await repo.reviewRun(run,results);await repo.open(true);
 const live=await repo.ask('常见问题',false);assert.equal(live.kind,'canon');
 await repo.saveTest({question:'新增问题',expected:'handoff',contains:''});await assert.rejects(()=>repo.ask('常见问题',false),/SERVICE_NOT_OPEN/);
});
test('publishing material invalidates acceptance while saving a draft does not',async()=>{
 const {repo}=fixture();const before=await fingerprint({...await repo.snapshot()});const row=await repo.saveDocument({title:'培训',body:document.body});
 assert.equal(await fingerprint(await repo.snapshot()),before);
 await repo.documentStatus(row,'published');assert.notEqual(await fingerprint(await repo.snapshot()),before);
 assert.equal(allowedScores([{passed:true,humanScore:NaN}],0.8),false);assert.equal(allowedScores([],0.8),false);
});
test('config saves and rollback add new versions and preserve business records',async()=>{
 const {repo}=fixture();const first=await repo.saveSettings({...settings,name:'制度问答'});await repo.ask('没有依据');
 await repo.saveSettings({...first,name:'培训助手'});await repo.saveSettings(first,'恢复自v1');
 const data=await repo.snapshot();assert.equal(data.settings.revision,3);assert.equal(data.settings.name,'制度问答');assert.equal(data.config_versions.length,3);assert.equal(data.turns.length,1);
});
test('AI suggestions are candidates and cannot publish records by model output',async()=>{
 const {repo,api}=fixture();const doc=await repo.saveDocument({title:'培训',body:document.body});await repo.documentStatus(doc,'published');
 api.model.generate=async()=>({text:JSON.stringify({items:[{question:'候选',answer:'候选答案',status:'published'}]})});
 const suggestions=await repo.suggest('canons');assert.equal((await repo.snapshot()).canons.length,0);
 const draft=await repo.saveCanon(suggestions[0],null,'ai_draft');assert.equal(draft.status,'draft');
});
test('initialization respects the actual workshop bridge four-call limit',async()=>{
 const {repo,api}=fixture();const original=api.data.list;let active=0,maximum=0;
 api.data.list=async value=>{maximum=Math.max(maximum,++active);try{assert.ok(active<=4);await new Promise(r=>setTimeout(r,2));return await original(value);}finally{active--;}};
 await repo.snapshot();assert.ok(maximum<=4);
});
test('actual personal-workshop service lists and copies the template without an installed source',async()=>{
 const calls=[];const identity={account:{accountId:'synthetic'},connection:{deviceId:'box'}};
 const link={context:()=>({}),close(){},request:async input=>{
  calls.push(input);if(input.path.endsWith('/sources'))return{status:200,body:JSON.stringify({items:[]})};
  if(input.path.endsWith('/copies'))return{status:200,body:JSON.stringify({id:'a'.repeat(32)})};
  throw Error('unexpected request');
 }};
 const service=createPersonalWorkshop({client:{snapshot:()=>identity,subscribe:()=>()=>{},applicationConnection:async()=>link},applications:{listInstalled:async()=>[]},assets:'synthetic',control:{on(){},isDestroyed:()=>false},ipcMain:{handle(){},removeHandler(){}}});
 try{
  const result=await service.action('sources');assert.equal(result.items.length,2);assert.equal(result.items[0].origin,'工坊模板');
  assert.equal(result.items[0].files,undefined);
  const copied=await service.action('copy',{sourceId:result.items[0].id,name:'制度问答',operationId:'synthetic'});
  assert.equal(copied.projectId,'a'.repeat(32));const request=JSON.parse(calls.find(c=>c.path.endsWith('/copies')).body.toString());
  assert.equal(request.source.sourceHash,workshopTemplate('template:knowledge-qa').sourceHash);
  await assert.rejects(()=>service.action('copy',{sourceId:'unknown'}),/WORKSHOP_SOURCE_CHANGED/);
 }finally{service.close();}
});
