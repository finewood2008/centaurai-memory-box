import test from 'node:test';
import assert from 'node:assert/strict';
import {createWarehouseJournal,warehouseRecoveryScope} from '../integration/team-client/starlink/quick-warehouse.mjs';

test('recovery storage is mandatory and accessed lazily without preventing page initialization',()=>{
  for(const getStorage of [undefined,()=>{throw Error('SecurityError')}]){
    const journal=createWarehouseJournal(getStorage);
    assert.throws(()=>journal.read('owner'),/WAREHOUSE_RECOVERY_UNAVAILABLE/);
    assert.throws(()=>journal.write('owner',{}),/WAREHOUSE_RECOVERY_UNAVAILABLE/);
  }
});

test('malformed recovery records are preserved and block accidental replacement',()=>{
  for(const value of ['{','{}','[]','{"input":{"name":"x","description":"","operationId":"invalid"}}']){
    let writes=0;const journal=createWarehouseJournal({getItem:()=>value,setItem(){writes++}});
    assert.throws(()=>journal.read('owner'),/WAREHOUSE_RECOVERY_UNAVAILABLE/);assert.equal(writes,0);
  }
});

test('local recovery follows stable data ownership, not cloud login or connection generation',()=>{
  const state={dataOwnerId:'local-owner-epoch-1',activeDeviceId:'box',account:{accountId:'cloud-a'},dataContextId:'session-a',dataIdentity:{profileId:'profile',clientId:'client',generation:1}};
  const key=warehouseRecoveryScope(state,'personal');
  assert.equal(key,warehouseRecoveryScope({...state,account:{accountId:'cloud-b'},dataContextId:'session-b',dataIdentity:{...state.dataIdentity,generation:2}},'personal'));
  for(const next of [{...state,dataOwnerId:'new-principal'},{...state,activeDeviceId:'other-box'}])assert.notEqual(key,warehouseRecoveryScope(next,'personal'));
  assert.notEqual(key,warehouseRecoveryScope(state,'team'));
  assert.equal(warehouseRecoveryScope({...state,dataOwnerId:null},'personal'),null);
});
