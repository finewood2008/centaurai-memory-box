import {test} from 'node:test';
import assert from 'node:assert/strict';
import {studioRoute} from '../integration/workspace-policy.mjs';

test('Studio expert selection and adopted release export have finite method/path contracts',()=>{
 const root='/api/app-studio/projects/'+'a'.repeat(32)+'/deployment/';
 for(const[tail,method]of [['expert','GET'],['expert','PUT'],['release','POST']]){
  assert.equal(studioRoute(root+tail,method),root+tail);
  for(const suffix of ['?','?path=/data','/','#fragment','%2f'])assert.throws(()=>studioRoute(root+tail+suffix,method),/STUDIO_PATH_DENIED/);
 }
 for(const[tail,method]of [['expert','POST'],['expert','DELETE'],['expert','HEAD'],['release','GET'],['release','PUT'],['release','DELETE']])assert.throws(()=>studioRoute(root+tail,method),/STUDIO_PATH_DENIED/);
 assert.throws(()=>studioRoute(root.replace('a'.repeat(32),'other')+'expert','GET'),/STUDIO_PATH_DENIED/);
});
