import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
const source=await readFile(new URL('../integration/team-client/view.js',import.meta.url),'utf8');
function fixture(identitySecurityEnabled){
  const calls=[],dialogs=[],window={};let readIdentity=0;
  const document={querySelectorAll:()=>[],body:{append:d=>dialogs.push(d)},createElement:()=>{
    const form={},error={},button={};return {dataset:{},querySelector:selector=>selector==='form'?form:selector.includes('error')?error:button,addEventListener(){},showModal(){},close(){this.closed=true},remove(){}};
  }};
  vm.runInNewContext(source,{window,document,queueMicrotask,setInterval:()=>0,clearInterval(){},FormData:class{}});
  const view=window.createTeamView({changed(){},request:async(name,input)=>{calls.push([name,input]);
    if(name==='team.identity'){readIdentity++;return {membershipId:'1',displayName:'Owner',permissions:['applications.manage']}}
    if(name==='team.members')return [{membershipId:'1',subject:'Owner',roleId:'manager',status:'active'},{membershipId:'2',subject:'Member',roleId:'member',status:'active'}];
    if(name==='team.invites')return [{invitationId:'3',code:'NATIVE-INVITE',roleId:'member',status:'active'}];
    if(name==='team.invite.create')return {code:'NATIVE-INVITE'};
    if(['team.catalog','team.projects'].includes(name))return [];
    return {opened:true};
  }});
  const state=accountId=>({canLaunchApplications:true,account:{phase:'authenticated',accountId,clientId:'client'},connection:{deviceId:'box'},team:{identitySecurityEnabled}});
  return {view,calls,dialogs,state,reads:()=>readIdentity};
}
test('team view uses native member and invitation actions without local identity state',async()=>{
  const f=fixture();f.view.sync(f.state('one'));await new Promise(resolve=>setImmediate(resolve));await f.view.action('manage');
  assert.match(f.view.page(),/NATIVE-INVITE/);assert.doesNotMatch(f.view.page(),/双钥|独立安全窗口|已批准的管理设备/);
  await f.view.action('invite');assert.ok(f.calls.some(([name])=>name==='team.invite.create'));assert.match(f.dialogs.at(-1).innerHTML,/NATIVE-INVITE/);
  await f.view.action('member',{id:'2',disabled:'true'});await f.dialogs.at(-1).querySelector('form').onsubmit({preventDefault(){},currentTarget:{querySelector:()=>({})}});
  assert.equal(f.calls.find(([name])=>name==='team.member.update')[1].id,2);
  await f.view.action('invite-revoke',{id:'3'});assert.equal(f.calls.find(([name])=>name==='team.invite.revoke')[1].id,3);
  assert.equal(f.calls.some(([name])=>name==='team.security'),false);
  const reads=f.reads();f.view.sync(f.state('two'));await new Promise(resolve=>setImmediate(resolve));assert.equal(f.reads(),reads+1);
});
test('legacy local identity state cannot expose a security or approval entry point',async()=>{
  const f=fixture(true);f.view.sync(f.state('one'));await new Promise(resolve=>setImmediate(resolve));await f.view.action('manage');
  await f.view.action('invite');assert.match(f.dialogs.at(-1).innerHTML,/NATIVE-INVITE/);
  await f.view.action('invite-revoke',{id:'3'});
  assert.equal(f.calls.some(([name])=>name==='team.security'),false);
  assert.equal(f.calls.some(([name])=>name==='team.invite.create'),true);
  f.view.sync({canLaunchApplications:false,team:{identitySecurityEnabled:true}});
  assert.match(f.view.catalog(),/data-action="show-boxes"/);
  assert.doesNotMatch(f.view.catalog(),/data-team-action="login"|设备批准/);
  assert.equal(f.view.login,undefined);
});


const settleIdentity = () => new Promise(resolve => setImmediate(resolve));
const connectedIdentityState = () => ({canLaunchApplications:true,connectionPhase:'ready',account:{phase:'authenticated',accountId:'one',clientId:'client'},connection:{deviceId:'box'}});
const adminIdentity = {membershipId:'1',displayName:'Owner',permissions:['applications.manage']};
function identityFixture(request) {
  const window={},calls=[],dialogs=[];
  const document={querySelectorAll:()=>[],body:{append:dialog=>dialogs.push(dialog)},createElement:()=>({dataset:{},querySelector:()=>({}),addEventListener(){},showModal(){},close(){}})};
  vm.runInNewContext(source,{window,document,queueMicrotask,setInterval:()=>0,clearInterval(){}});
  const view=window.createTeamView({changed(){},request:async(name,input)=>{calls.push(name);return request(name,input)}});
  return {view,calls,dialogs};
}
for (const failedOperation of ['team.identity','team.members','team.projects','team.invites']) {
  test(`temporary ${failedOperation} failure retains the verified navigation role but suspends operations`,async()=>{
    let failed=false;
    const {view,calls}=identityFixture(async name=>{if(failed&&name===failedOperation)throw Error('TEAM_REQUEST_FAILED');return name==='team.identity'?adminIdentity:[]});
    view.sync(connectedIdentityState());await settleIdentity();
    failed=true;await view.action('manage');
    assert.equal(view.snapshot().identity,adminIdentity);
    assert.equal(view.snapshot().available,false);
    assert.ok(view.snapshot().error);
    const count=calls.length;await assert.rejects(view.action('invite'),/TEAM_SESSION_CHANGED/);assert.equal(calls.length,count);
    failed=false;await view.refresh();assert.equal(view.snapshot().available,true);
  });
}
test('same connection recovery preserves role, suspends requests, then immediately verifies on ready',async()=>{
  const {view,calls}=identityFixture(async name=>name==='team.identity'?adminIdentity:[]);
  const state=connectedIdentityState();view.sync(state);await settleIdentity();
  view.sync({...state,canLaunchApplications:false,connectionPhase:'recovering'});
  assert.equal(view.snapshot().identity,adminIdentity);assert.equal(view.snapshot().available,false);
  const count=calls.length;await view.refresh();await assert.rejects(view.action('invite'),/TEAM_SESSION_CHANGED/);assert.equal(calls.length,count);
  view.sync(state);await settleIdentity();assert.equal(view.snapshot().available,true);assert.equal(calls.filter(n=>n==='team.identity').length,2);
});
for (const change of ['logout','account','client','device','disconnected','authorization_required']) {
  test(`${change} clears cached identity immediately`,async()=>{
    let next=false;
    const {view}=identityFixture(async name=>name==='team.identity'?(next?new Promise(()=>{}):adminIdentity):[]);
    const state=connectedIdentityState();view.sync(state);await settleIdentity();next=true;
    const changed=structuredClone(state);
    if(change==='logout')changed.account.phase='signed_out';
    else if(change==='account')changed.account.accountId='two';
    else if(change==='client')changed.account.clientId='two';
    else if(change==='device')changed.connection.deviceId='two';
    else{changed.canLaunchApplications=false;changed.connectionPhase=change}
    view.sync(changed);assert.equal(view.snapshot().identity,null);assert.equal(view.snapshot().available,false);
  });
}
for (const outcome of ['member','TEAM_PERMISSION_DENIED','TEAM_IDENTITY_INVALID','AUTH_FAILED','FORBIDDEN']) {
  test(`confirmed ${outcome} clears admin access`,async()=>{
    let revoke=false;
    const {view}=identityFixture(async name=>{if(name!=='team.identity')return [];if(!revoke)return adminIdentity;if(outcome==='member')return {...adminIdentity,permissions:[]};throw Error(outcome)});
    view.sync(connectedIdentityState());await settleIdentity();revoke=true;await view.refresh();
    assert.equal(Boolean(view.snapshot().identity?.permissions.includes('applications.manage')),false);
  });
}
for(const outcome of ['success','failure'])for(const transition of ['recovering','account']) {
  test(`late identity ${outcome} after ${transition} cannot replace the current identity`,async()=>{
    let resolve,reject,pending=false;
    const {view}=identityFixture(async name=>name==='team.identity'?(pending?new Promise((yes,no)=>{resolve=yes;reject=no}):adminIdentity):[]);
    const state=connectedIdentityState();view.sync(state);await settleIdentity();pending=true;const old=view.refresh();const resolveOld=resolve,rejectOld=reject;
    view.sync(transition==='recovering'?{...state,canLaunchApplications:false,connectionPhase:'recovering'}:{...state,account:{...state.account,accountId:'two'}});
    pending=false;
    if(transition==='recovering')view.sync(state);
    else view.sync({...state,account:{...state.account,accountId:'two'},canLaunchApplications:false,connectionPhase:'disconnected'});
    await settleIdentity();
    if(outcome==='success')resolveOld({...adminIdentity,displayName:'stale'});else rejectOld(Error('TEAM_PERMISSION_DENIED'));
    await old;assert.equal(view.snapshot().identity?.displayName,transition==='recovering'?'Owner':undefined);
  });
}

test('an invitation response arriving after connection recovery cannot open a stale modal',async()=>{
  let complete;
  const {view}=identityFixture(async name=>name==='team.identity'?adminIdentity:name==='team.invite.create'?new Promise(resolve=>complete=resolve):[]);
  const state=connectedIdentityState();view.sync(state);await settleIdentity();
  const pending=view.action('invite');view.sync({...state,canLaunchApplications:false,connectionPhase:'recovering'});
  complete({code:'STALE-INVITE'});await assert.rejects(pending,/TEAM_SESSION_CHANGED/);
});

test('a native FORBIDDEN catalog response blocks cached admin access',async()=>{
  let forbidden=false;
  const {view}=identityFixture(async name=>{if(name==='team.catalog'&&forbidden)throw Error('FORBIDDEN');return name==='team.identity'?adminIdentity:[]});
  view.sync(connectedIdentityState());await settleIdentity();forbidden=true;await view.refresh();
  assert.equal(view.snapshot().identity,null);assert.equal(view.snapshot().available,false);
  await assert.rejects(view.action('invite'),/TEAM_SESSION_CHANGED/);
});


test('context changes clear cached identity even when the account and device are unchanged',async()=>{
  let pending=false;
  const {view}=identityFixture(async name=>name==='team.identity'?(pending?new Promise(()=>{}):adminIdentity):[]);
  const state=connectedIdentityState();view.sync(state,{contextKey:'first'});await settleIdentity();pending=true;
  view.sync(state,{contextKey:'second'});
  assert.equal(view.snapshot().identity,null);assert.equal(view.snapshot().available,false);
});

test('same context recovery preserves publishing selection while identity is reverified',async()=>{
  let finishIdentity,pending=false;
  const {view}=identityFixture(async name=>name==='team.identity'?(pending?new Promise(resolve=>finishIdentity=resolve):adminIdentity):[]);
  const state=connectedIdentityState(),options={contextKey:'same-context'};
  view.sync(state,options);await settleIdentity();await view.action('publishing');
  view.searchPublication('preserved query');await view.action('publication-filter',{filter:'unpublished'});
  view.sync({...state,canLaunchApplications:false,connectionPhase:'recovering'},options);
  pending=true;view.sync(state,options);
  assert.equal(view.snapshot().identity,adminIdentity);assert.equal(view.snapshot().available,false);assert.equal(view.snapshot().identityError,null);
  assert.match(view.publishing(),/value="preserved query"/);assert.match(view.publishing(),/data-filter="unpublished" aria-pressed="true"/);
  finishIdentity(adminIdentity);await settleIdentity();assert.equal(view.snapshot().available,true);
  pending=false;view.sync(state,{contextKey:'new-context'});await settleIdentity();
  assert.doesNotMatch(view.publishing(),/preserved query/);assert.match(view.publishing(),/data-filter="available" aria-pressed="true"/);
});

test('temporary identity failure reports identityError while retaining display identity',async()=>{
  let failed=false;
  const {view}=identityFixture(async name=>{if(name==='team.identity'&&failed)throw Object.assign(Error('temporary'),{code:'TEAM_REQUEST_FAILED'});return name==='team.identity'?adminIdentity:[]});
  view.sync(connectedIdentityState(),{contextKey:'one'});await settleIdentity();failed=true;await view.refresh();
  assert.equal(view.snapshot().identity,adminIdentity);assert.equal(view.snapshot().identityError,'TEAM_REQUEST_FAILED');assert.equal(view.snapshot().available,false);
  failed=false;await view.refresh();assert.equal(view.snapshot().identityError,null);assert.equal(view.snapshot().available,true);
});

test('explicit invalidation blocks operations and late identity results until successful retry',async()=>{
  let pending=false,finishIdentity;
  const {view,calls}=identityFixture(async name=>name==='team.identity'?(pending?new Promise(resolve=>finishIdentity=resolve):adminIdentity):[]);
  view.sync(connectedIdentityState(),{contextKey:'one'});await settleIdentity();pending=true;const old=view.refresh();
  view.invalidate('TEAM_ADMIN_REQUIRED');assert.equal(view.snapshot().identity,null);assert.equal(view.snapshot().identityError,'TEAM_ADMIN_REQUIRED');assert.equal(view.snapshot().available,false);
  const count=calls.length;await assert.rejects(view.action('invite'),/TEAM_SESSION_CHANGED/);assert.equal(calls.length,count);
  finishIdentity(adminIdentity);await old;assert.equal(view.snapshot().identity,null);assert.equal(view.snapshot().available,false);
  pending=false;await view.refresh();assert.equal(view.snapshot().identity,adminIdentity);assert.equal(view.snapshot().identityError,null);assert.equal(view.snapshot().available,true);
});


test('confirmed authorization failure invalidates an older invitation response in the same context',async()=>{
  let forbidden=false,finishInvite;
  const {view,dialogs}=identityFixture(async name=>{
    if(name==='team.invite.create')return new Promise(resolve=>finishInvite=resolve);
    if(name==='team.identity'&&forbidden)throw Error('FORBIDDEN');
    return name==='team.identity'?adminIdentity:[];
  });
  view.sync(connectedIdentityState(),{contextKey:'one'});await settleIdentity();const invitation=view.action('invite');
  forbidden=true;await view.refresh();assert.equal(view.snapshot().loading,false);
  finishInvite({code:'STALE'});await assert.rejects(invitation,/TEAM_SESSION_CHANGED/);assert.equal(dialogs.length,0);
  forbidden=false;await view.refresh();assert.equal(view.snapshot().available,true);
});


test('confirmed member role invalidates an older administrator invitation response',async()=>{
  let demoted=false,finishInvite;
  const {view,dialogs}=identityFixture(async name=>{
    if(name==='team.invite.create')return new Promise(resolve=>finishInvite=resolve);
    return name==='team.identity'?(demoted?{...adminIdentity,permissions:[]}:adminIdentity):[];
  });
  view.sync(connectedIdentityState(),{contextKey:'one'});await settleIdentity();const invitation=view.action('invite');
  demoted=true;await view.refresh();assert.equal(view.snapshot().loading,false);assert.equal(view.snapshot().available,true);
  assert.equal(view.snapshot().identity.permissions.length,0);
  finishInvite({code:'STALE'});await assert.rejects(invitation,/TEAM_SESSION_CHANGED/);assert.equal(dialogs.length,0);
});
