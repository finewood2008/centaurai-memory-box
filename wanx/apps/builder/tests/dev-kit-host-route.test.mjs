import test from 'node:test';
import assert from 'node:assert/strict';
import {studioRoute} from '../integration/workspace-policy.mjs';

const path='/api/app-studio/projects/'+'a'.repeat(32)+'/dev-kit';
test('original Kaiwu Host permits the exact read-only project dev-kit descriptor needed by PRD review',()=>{
  assert.equal(studioRoute(path,'GET'),path);
  for(const method of ['POST','PUT','DELETE','HEAD','OPTIONS'])assert.throws(()=>studioRoute(path,method),/STUDIO_PATH_DENIED/);
  for(const route of [path+'?',path+'?boxId=other',path+'/',path+'#fragment',path.replace('dev-kit','%64ev-kit'),path.replace('a'.repeat(32),'other'),path.replace('a'.repeat(32),'../'+'a'.repeat(32)),path.replace('projects/','projects//'),'/api/app-studio/dev-kit','/api/app-studio/projects/'+'a'.repeat(32)+'/legacy-migration'])assert.throws(()=>studioRoute(route,'GET'),/STUDIO_PATH_DENIED/);
});
