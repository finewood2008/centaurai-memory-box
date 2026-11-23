import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {cp,mkdir,mkdtemp,readFile,rm,symlink,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {finished} from 'node:stream/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {assembleStarlink,verifyPackagedStarlink} from '../tools/assemble-starlink.mjs';
import {needsBundledStarlink} from '../integration/bundled-starlink-version.mjs';
import {clientBuildSource,clientTestSourceSnapshot} from '../../personal-client/tools/package-client-source.mjs';

const root=fileURLToPath(new URL('../../../',import.meta.url));
const require=createRequire(path.join(root,'apps/personal-client/package.json'));
const asar=require('@electron/asar');
const currentStarlinkVersion=JSON.parse(await readFile(new URL('../../team-client/applications/starlink/package.json',import.meta.url),'utf8')).version;
async function directory(t) {const p=await mkdtemp(path.join(os.tmpdir(),'wanx-starlink-builtin-'));t.after(()=>rm(p,{recursive:true,force:true}));return p;}
async function pack(source,target){const stream=await asar.createPackage(source,target);if(stream?.on)await finished(stream);}

test('both editions preserve pinned Starlink with isolated product copy; stale UI and missing dependencies fail verification',async t=>{
 const temp=await directory(t);const digests=[];
 for(const edition of ['personal','team']) {
  const buildRoot=path.join(root,`apps/${edition === 'personal' ? 'personal' : 'team'}-client/build`);
  await mkdir(buildRoot,{recursive:true});
  const outputRoot=await mkdtemp(path.join(buildRoot,'starlink-test-'));t.after(()=>rm(outputRoot,{recursive:true,force:true}));
  const result=await assembleStarlink(edition,{outputRoot});
  assert.equal(result.target,path.join(outputRoot,'applications/starlink'));
  assert.equal(JSON.parse(await readFile(path.join(result.target,'application.manifest.json'),'utf8')).name,edition === 'personal' ? '知识星图' : '万象·星图');
  const stage=path.join(temp,edition),payload=path.join(stage,'applications/starlink');await mkdir(path.dirname(payload),{recursive:true});await cp(result.target,payload,{recursive:true});
  const archive=path.join(temp,edition+'.asar');await pack(stage,archive);
  assert.equal((await verifyPackagedStarlink(archive,path.join(root,edition==='personal'?'apps/personal-client':'apps/team-client'))).version,currentStarlinkVersion);
  digests.push(createHash('sha256').update(await readFile(archive)).digest('hex'));
  if(edition==='personal') {
   await writeFile(path.join(payload,'ui/workbench/index.html'),'stale frontend');const stale=path.join(temp,'stale.asar');await pack(stage,stale);await assert.rejects(verifyPackagedStarlink(stale,path.join(root,'apps/personal-client')),/STARLINK_PACKAGED_HASH_MISMATCH/);
  } else {
   await rm(path.join(payload,'node_modules/ws/index.js'));const missing=path.join(temp,'missing.asar');await pack(stage,missing);await assert.rejects(verifyPackagedStarlink(missing,path.join(root,'apps/team-client')));
  }
 }
 assert.notEqual(digests[0],digests[1]);
});

test('both editions verify Builder-filtered contracts and reject missing or changed runtime schemas',async t=>{
 const temp=await directory(t);
 for(const edition of ['personal','team']) {
  const buildRoot=path.join(root,`apps/${edition === 'personal' ? 'personal' : 'team'}-client/build`);
  await mkdir(buildRoot,{recursive:true});
  const outputRoot=await mkdtemp(path.join(buildRoot,'starlink-test-'));t.after(()=>rm(outputRoot,{recursive:true,force:true}));
  const result=await assembleStarlink(edition,{outputRoot});
  assert.equal(result.target,path.join(outputRoot,'applications/starlink'));
  assert.equal(JSON.parse(await readFile(path.join(result.target,'application.manifest.json'),'utf8')).name,edition === 'personal' ? '知识星图' : '万象·星图');
  const client=path.join(root,edition==='personal'?'apps/personal-client':'apps/team-client');
  const stage=path.join(temp,edition),payload=path.join(stage,'applications/starlink');
  await mkdir(path.dirname(payload),{recursive:true});
  // Mirror Builder's declaration/lockfile exclusions; raw asar.createPackage
  // includes them and otherwise cannot reproduce the production afterPack bug.
  await cp(result.target,payload,{recursive:true,filter:source=>!source.endsWith('.d.ts')&&path.basename(source)!=='package-lock.json'});
  const archive=path.join(temp,edition+'.asar');await pack(stage,archive);
  assert.equal(asar.listPackage(archive).some(name=>name.endsWith('.d.ts')),false);
  assert.equal((await verifyPackagedStarlink(archive,client)).version,currentStarlinkVersion);
  const schema=path.join(payload,'wanx-app-kit/contracts/schemas/error-envelope.v1.schema.json');
  await writeFile(schema,'{}');
  const changed=path.join(temp,edition+'-changed.asar');await pack(stage,changed);
  await assert.rejects(verifyPackagedStarlink(changed,client),/STARLINK_PACKAGED_CONTRACT_MISMATCH/);
  await rm(schema);
  const missing=path.join(temp,edition+'-missing.asar');await pack(stage,missing);
  await assert.rejects(verifyPackagedStarlink(missing,client),/error-envelope\.v1\.schema\.json.*was not found/);
 }
});

test('one upgrade policy preserves newer/equal/custom/selected/signed/running versions in both editions',async t=>{
 const bundle=await directory(t);await writeFile(path.join(bundle,'application.manifest.json'),JSON.stringify({version:currentStarlinkVersion}));
 const idle={activate:()=>false},running={activate:()=>true};
 assert.equal(await needsBundledStarlink(null,bundle,idle),true);
 for(const version of ['0.2.24','0.2.25','0.3.4','0.3.5','0.3.5-rc.20261031','0.3.5-rc.20261101','0.3.5-rc.20261101.box103.1','0.3.5-rc.20261106.1']) assert.equal(await needsBundledStarlink({version},bundle,idle),true);
 for(const version of [currentStarlinkVersion,'0.3.6','0.4.0','custom']) assert.equal(await needsBundledStarlink({version},bundle,idle),false);
 for(const record of [{version:'0.3.4',selectionRequired:true},{version:'0.3.4',artifactId:'signed'},{version:'0.3.4',previous:{version:'0.4.0'}}])assert.equal(await needsBundledStarlink(record,bundle,idle),false);
 assert.equal(await needsBundledStarlink({version:'0.3.4'},bundle,running),false);
 assert.equal(await needsBundledStarlink({version:'0.3.4'},null,idle),false);
});

test('the current builtin upgrades the previous conversation release while protecting running and signed apps',async()=>{
 const bundle=path.join(root,'apps/team-client/applications/starlink');
 const previous='0.3.6-rc.20261105.onboarding.2';
 assert.equal(await needsBundledStarlink({version:previous},bundle,{activate:()=>false}),true);
 assert.equal(await needsBundledStarlink({version:currentStarlinkVersion},bundle,{activate:()=>false}),false);
 assert.equal(await needsBundledStarlink({version:previous},bundle,{activate:()=>true}),false);
 assert.equal(await needsBundledStarlink({version:previous,artifactId:'signed'},bundle,{activate:()=>false}),false);
});

test('formal personal builds and local fingerprints include shared Starlink source',async t=>{
 const repo=await directory(t),client=path.join(repo,'apps/personal-client'),shared=path.join(repo,'apps/team-client/applications/starlink');await mkdir(client,{recursive:true});await mkdir(shared,{recursive:true});await writeFile(path.join(client,'package.json'),'{}');await writeFile(path.join(shared,'main.mjs'),'original');
 const git=args=>execFileSync('git',args,{cwd:repo,stdio:'pipe'});git(['init','-q']);git(['add','.']);git(['-c','user.name=Test','-c','user.email=test@example.invalid','commit','-qm','fixture']);
 assert.equal(clientBuildSource(client).sourceDirty,false);const before=clientTestSourceSnapshot(client);
 await writeFile(path.join(shared,'main.mjs'),'changed');assert.throws(()=>clientBuildSource(client),/CLIENT_SOURCE_TREE_DIRTY/);assert.notEqual(clientTestSourceSnapshot(client),before);
});

test('the real installer retains the previous builtin version and material bytes on upgrade',async t=>{
 const temp=await directory(t),source=path.join(root,'apps/team-client/applications/starlink');
 const {createApplicationInstaller}=await import('../../personal-client/applications/installer.mjs');
 const installer=createApplicationInstaller({rootDir:path.join(temp,'installed')});
 const manifest=JSON.parse(await readFile(path.join(source,'application.manifest.json'),'utf8'));
 const old=await installer.install({sourceDir:source,manifest:{...manifest,version:'0.2.25'}});
 const material=path.join(old.installPath,'retained-material.fixture');await writeFile(material,'retained original and historical version');
 const current=await installer.install({sourceDir:source,manifest});
 assert.equal(current.version,currentStarlinkVersion);assert.equal((await installer.list())[0].version,current.version);
 assert.equal(await readFile(material,'utf8'),'retained original and historical version');
 assert.equal(await readFile(path.join(old.installPath,'shell/main.mjs'),'utf8'),await readFile(path.join(source,'shell/main.mjs'),'utf8'));
});

test('both editions check shared source through a symlinked checkout', {skip: process.platform === 'win32'}, async t=>{
 const temp=await directory(t),repo=path.join(temp,'repo'),alias=path.join(temp,'alias');
 const shared=path.join(repo,'apps/team-client/applications/starlink');
 await mkdir(shared,{recursive:true});await mkdir(path.join(repo,'apps/personal-client'),{recursive:true});
 await writeFile(path.join(repo,'apps/personal-client/package.json'),'{}');
 await writeFile(path.join(repo,'apps/team-client/package.json'),'{}');
 await writeFile(path.join(shared,'main.mjs'),'original');
 const git=args=>execFileSync('git',args,{cwd:repo,stdio:'pipe'});
 git(['init','-q']);git(['add','.']);git(['-c','user.name=Test','-c','user.email=test@example.invalid','commit','-qm','fixture']);
 await symlink(repo,alias,'dir');
 for(const edition of ['personal-client','team-client']) {
  const source=await import(`../../${edition}/tools/package-client-source.mjs`);
  const client=path.join(alias,'apps',edition);
  await writeFile(path.join(shared,'main.mjs'),'original');
  assert.equal(source.clientBuildSource(client).sourceDirty,false);
  const before=source.clientTestSourceSnapshot(client);
  await writeFile(path.join(shared,'main.mjs'),'changed');
  assert.throws(()=>source.clientBuildSource(client),/CLIENT_SOURCE_TREE_DIRTY/);
  assert.notEqual(source.clientTestSourceSnapshot(client),before);
 }
});
