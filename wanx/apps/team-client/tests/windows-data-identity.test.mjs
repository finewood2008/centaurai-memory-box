import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import test from "node:test";

// Exercise the actual readers in a subprocess: Windows lstat may return dev=0,
// while fstat returns the volume ID. Keep this shim out of other test files.
const preload = `
 import fs from 'node:fs/promises';
 import {syncBuiltinESMExports} from 'node:module';
 const original=fs.lstat,originalStat=fs.stat;
 fs.lstat=async (...args)=>{const info=await original(...args);
  if(info.isFile()&&/[\\\\/](?:roles\\.json|\\.data-schema\\.json|centaurai\\.wanx\\.zhijun\\.json)$/.test(String(args[0])))info.dev=0;
  return info;
 };
 fs.stat=async(...args)=>{const info=await originalStat(...args);if(info.isFile())info.dev=0;return info};
 syncBuiltinESMExports();
`;
const url='data:text/javascript;base64,'+Buffer.from(preload).toString('base64');
const directory=fileURLToPath(new URL('./',import.meta.url));
test('Windows volume-less path stats preserve trusted data and still reject invalid profiles',{timeout:30000},()=>{
 const env={...process.env,WANX_ELECTRON_APP:''};delete env.NODE_TEST_CONTEXT;
 const child=spawnSync(process.execPath,['--import',url,'--test',
  fileURLToPath(new URL('zhijun-data.test.mjs',import.meta.url)),
  fileURLToPath(new URL('application-data-schema.test.mjs',import.meta.url)),
  fileURLToPath(new URL('upgrade-review-compat.test.mjs',import.meta.url))],
  {cwd:directory,encoding:'utf8',timeout:25000,env});
 assert.equal(child.status,0,child.stdout+'\n'+child.stderr);
 assert.match(child.stdout,/(?:tests|test suites)/);
});

test('a file-handle volume mismatch remains rejected',{timeout:10000},()=>{
 const source=`
  import fs from 'node:fs/promises';import path from 'node:path';import os from 'node:os';
  import {syncBuiltinESMExports} from 'node:module';import assert from 'node:assert/strict';
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'wanx-file-volume-'));
  try{
   const directory=path.join(root,'applications','.runtime','test.app');await fs.mkdir(directory,{recursive:true});
   const writer={artifactId:'test',descriptorDigest:'test'},applicationId='test.app';
   await fs.writeFile(path.join(directory,'.data-schema.json'),JSON.stringify({schemaVersion:1,applicationId,dataSchemaVersion:'1.0.0',writer}));
   const lstat=fs.lstat,stat=fs.stat,open=fs.open;let opened=0;
   fs.lstat=async(...a)=>{const s=await lstat(...a);if(s.isFile())s.dev=0;return s};
   fs.stat=async(...a)=>{const s=await stat(...a);if(s.isFile())s.dev=0;return s};
   fs.open=async(...a)=>{const h=await open(...a);if(++opened===2){const stat=h.stat.bind(h);h.stat=async(...x)=>{const s=await stat(...x);s.dev+=1;return s}}return h};
   syncBuiltinESMExports();
   const {readDataSchema}=await import(${JSON.stringify(new URL('../applications/data-schema.mjs',import.meta.url).href)});
   await assert.rejects(readDataSchema({applicationRoot:path.join(root,'applications'),directory,applicationId,writer}),{code:'APPLICATION_DATA_COMPATIBILITY_UNKNOWN'});
  }finally{await fs.rm(root,{recursive:true,force:true})}
 `;
 const child=spawnSync(process.execPath,['--input-type=module','-e',source],{encoding:'utf8',timeout:9000});
 assert.equal(child.status,0,child.stdout+'\n'+child.stderr);
});
