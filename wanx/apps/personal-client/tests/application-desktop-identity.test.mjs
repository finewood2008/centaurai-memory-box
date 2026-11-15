import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,symlink,rm,realpath} from 'node:fs/promises';import path from 'node:path';import os from 'node:os';
import {applicationIcon,applicationExecutable} from '../applications/desktop-runtime.mjs';
test('application icon belongs to its installed package; external links are not trusted',async()=>{
 const sandbox=await mkdtemp(path.join(os.tmpdir(),'app-icon-'));
 const root=path.join(sandbox,'package');
 try{
  const resources=path.join(root,'resources');
  await mkdir(resources,{recursive:true});
  const icon=path.join(resources,'icon.png');
  await writeFile(icon,'own');
  assert.equal(await applicationIcon(root),await realpath(icon));
  await rm(resources,{recursive:true});
  const outside=path.join(sandbox,'outside');
  await mkdir(outside);
  await writeFile(path.join(outside,'icon.png'),'external');
  await symlink(outside,resources,process.platform==='win32'?'junction':'dir');
  assert.equal(await applicationIcon(root),null);
 }finally{await rm(sandbox,{recursive:true,force:true});}
});
test('bundled apps and development/Windows runtimes retain their existing executable',async()=>{
 for(const options of [{platform:'win32'},{platform:'linux'},{platform:'darwin'},{platform:'darwin',record:{launchMode:'bundled'}}])assert.equal(await applicationExecutable({applicationRoot:'/unused',record:{},electronPath:'/dev/runtime',...options}),'/dev/runtime');
});
