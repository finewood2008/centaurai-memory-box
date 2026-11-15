import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {sendStarlinkTarget} from '../integration/team-client/starlink-launch.mjs';
import {createStarlinkTarget} from '../../team-client/applications/starlink/shell/starlink-target.mjs';
test('target handoff waits for the matching launch and target acknowledgement',async()=>{
 const child=new EventEmitter();let message,done=false;child.send=m=>message=m;
 const operation=sendStarlinkTarget({child,session:{launchId:'live'}},{view:'graph'},{timeout:50}).then(()=>done=true);
 child.emit('message',{type:'wanx:starlink-target-result',launchId:'other',requestId:message.requestId,ok:true});await Promise.resolve();assert.equal(done,false);
 child.emit('message',{type:'wanx:starlink-target-result',launchId:'live',requestId:message.requestId,ok:true});await operation;assert.equal(done,true);
});
test('bundled Starlink accepts personal targets only in a personal host session',async()=>{
 const events=[],replies=[],target={kind:'personal-data',version:1,warehouseId:null,view:'warehouses'};
 const personal=createStarlinkTarget({host:{context:async()=>({dataScope:'personal'})},service:{call:async()=>{},assertLive(){}},emit:value=>events.push(value),send:value=>replies.push(value),launchId:'personal'});
 await personal.receive({type:'wanx:starlink-target',launchId:'personal',requestId:'one',target});
 assert.equal(events[0].target.kind,'personal-data');
 await personal.call('launch-target-applied',{requestId:'one',ok:true});
 assert.equal(replies.find(reply=>reply.type==='wanx:starlink-target-result'&&reply.requestId==='one').ok,true);
 const team=createStarlinkTarget({host:{context:async()=>({dataScope:'team'})},service:{call:async()=>{},assertLive(){}},emit:value=>events.push(value),send:value=>replies.push(value),launchId:'team'});
 await team.receive({type:'wanx:starlink-target',launchId:'team',requestId:'two',target});
 assert.equal(replies.at(-1).code,'TEAM_DATA_CONTEXT_REQUIRED');
});
test('old Starlink is reported as incompatible instead of claiming the target opened',async()=>{
 const child=new EventEmitter();child.send=()=>{};
 await assert.rejects(sendStarlinkTarget({child,session:{launchId:'live'}},{view:'graph'},{timeout:5}),{code:'TEAM_STARLINK_UPGRADE_REQUIRED'});
});
