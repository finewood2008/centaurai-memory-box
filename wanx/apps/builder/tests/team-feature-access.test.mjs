import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const source=await readFile(new URL('../integration/team-client/feature-access.js',import.meta.url),'utf8');
const connected={account:{phase:'authenticated',accountId:'alice',clientId:'client'},canLaunchApplications:true,phase:'ready',activeDeviceId:'box',connection:{deviceId:'box'}};
const admin={identity:{permissions:['applications.manage']}};
function fixture(){const window={};vm.runInNewContext(source,{window});return window.createTeamFeatureAccess()}
test('initial, connecting, reconnecting and failed pages expose connection actions without management data',()=>{
 const gate=fixture();
 for(const [phase,status] of [['disconnected','disconnected'],['connecting','connecting'],['recovering','reconnecting'],['unavailable','failed']]){
  const value=gate.sync({...connected,canLaunchApplications:false,phase},admin);
  assert.equal(value.status,status);assert.equal(value.allowed,false);assert.throws(()=>gate.stamp(),/ACCESS_UNAVAILABLE/);
  assert.match(gate.render('construction'),/WanX Builder/);assert.match(gate.render('construction'),/Beta/);
  assert.match(gate.render('data'),/WanX Starlink/);assert.doesNotMatch(gate.render('data'),/Beta/);
  assert.match(gate.render('data'),/show-boxes/);
 }
 gate.sync({...connected,canLaunchApplications:false,phase:'unavailable',reason:'<script>offline</script>'});
 assert.match(gate.render('data'),/&lt;script&gt;/);assert.doesNotMatch(gate.render('data'),/<script>/);
});
test('only live administrator identity opens management, ordinary users and failed verification stay closed',()=>{
 const gate=fixture();assert.equal(gate.sync(connected).status,'verifying');
 assert.equal(gate.sync(connected,{identity:{permissions:[]}}).status,'denied');assert.match(gate.render('data'),/仅管理员可用/);
 assert.equal(gate.sync(connected,{identityError:'TEAM_SERVICE_UNAVAILABLE'}).status,'verification-failed');
 assert.equal(gate.sync(connected,{identityError:'TEAM_LOGIN_DENIED'}).status,'denied');
 assert.equal(gate.sync(connected,admin).allowed,true);
 const live=gate.stamp();gate.sync(connected,{identity:{permissions:[]}});assert.throws(live,/CONTEXT_CHANGED/);
});
test('disconnect retains location but invalidates requests; reconnect requires new identity',()=>{
 const gate=fixture();const before=gate.sync(connected,admin),old=gate.stamp();
 const offline=gate.sync({...connected,canLaunchApplications:false,activeDeviceId:null,connection:null,phase:'disconnected'});
 assert.equal(offline.key,before.key);assert.equal(offline.deviceId,'box');assert.throws(old,/CONTEXT_CHANGED/);
 assert.equal(gate.sync(connected).allowed,false);
 gate.sync(connected,admin);assert.throws(old,/CONTEXT_CHANGED/);gate.stamp()();
});
test('retained navigation identity cannot authorize management while verification is unavailable',()=>{
 const gate=fixture();gate.sync(connected,{...admin,available:true});const live=gate.stamp();
 assert.equal(gate.sync(connected,{...admin,available:false,identityError:'TEAM_REQUEST_FAILED'}).status,'verification-failed');
 assert.equal(gate.snapshot().allowed,false);assert.throws(live,/CONTEXT_CHANGED/);assert.throws(()=>gate.stamp(),/ACCESS_UNAVAILABLE/);
 assert.equal(gate.sync(connected,{...admin,available:false,identityError:null}).status,'verifying');
 assert.throws(()=>gate.stamp(),/ACCESS_UNAVAILABLE/);
 assert.equal(gate.sync(connected,{...admin,available:true}).allowed,true);gate.stamp()();
});
test('accounts, profiles, principals, boxes and logout fence the old context',()=>{
 for(const patch of [{account:{...connected.account,accountId:'bob'}},{activeDeviceId:'box2'},{dataIdentity:{profileId:'new-profile'}},{dataIdentity:{selected:{principalId:'new-user',bindingId:'binding'}}},{account:{phase:'signed_out'}}]){
  const gate=fixture();const before=gate.sync(connected,admin),live=gate.stamp();gate.sync({...connected,...patch});
  assert.notEqual(gate.snapshot().key,before.key);assert.throws(live,/CONTEXT_CHANGED/);
 }
});
