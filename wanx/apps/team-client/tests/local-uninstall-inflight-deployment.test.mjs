import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, writeFile, rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import {createApplicationManager} from '../build/app/applications/manager.mjs';
import {writeApplicationZip} from './support/application-zip.mjs';
import {writeMiniappPackage} from '../../builder/core/package.mjs';

test('local uninstall cancels an already admitted deployment; a later explicit deployment can install', {timeout:10000}, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'local-uninstall-inflight-'));
  t.after(() => rm(root, {recursive:true, force:true}));
  const slot = 'ai.wanx.selfmade.' + 'a'.repeat(32), base = 'example.local.expert';
  const manifest = {
    applicationId:base, name:'Local deployed expert', version:'0.1.0', protocolVersion:3,
    runtime:'electron', launchMode:'shared', entrypoint:'main.cjs', capabilities:['identity.read'],
    compatibility:{backendProductId:'wanx', clientRange:'>=0.1.0 <2.0.0', hostProtocolRange:'>=1.0.0 <2.0.0',
      backendContracts:[{id:'wanx.expert-app.v1', range:'>=1.0.0 <2.0.0', features:['context','expert','data']}],
      resourceDependencies:[], localDataSchema:{readRange:'=1.0.0', writeVersion:'1.0.0'}},
  };
  const archivePath = path.join(root, 'standard.zip');
  await writeApplicationZip(archivePath, [
    {name:'application.manifest.json', body:JSON.stringify(manifest)},
    {name:'main.cjs', body:'module.exports={}'},
  ]);
  const packageSha256 = createHash('sha256').update(await readFile(archivePath)).digest('hex');
  const binding = {schemaVersion:1, profile:'wanx-expert-app-v1', baseApplicationId:base, slotApplicationId:slot,
    boxId:'synthetic-box', environment:'dev', generation:1, operationId:'b'.repeat(32), fence:1,
    artifactHash:'c'.repeat(64), scopeId:'d'.repeat(64), ticketId:'e'.repeat(32), payloadDigest:'sha256:'+'f'.repeat(64)};
  let pause = false, entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const manager = await createApplicationManager({applicationRoot:path.join(root,'apps'),
    getCompatibilityContext:async ({phase}) => {
      if (pause && phase === 'candidate') { entered(); await gate; }
      return {hostProtocol:1, localDataSchemaVersion:'1.0.0'};
    },
  });
  t.after(() => { pause = false; release(); return manager.close(); });
  const first = {archivePath, manifest, packageSha256, artifactHash:binding.artifactHash, binding};
  await manager.installStandardDeployment(first);
  const data = path.join(root, 'apps/.runtime', slot);
  await mkdir(data, {recursive:true}); await writeFile(path.join(data,'retained.txt'), 'business data');
  const next = {...first, binding:{...binding, generation:2, operationId:'1'.repeat(32)}};
  pause = true;
  const pending = manager.installStandardDeployment(next);
  // Attach the assertion before releasing the gate to preserve rejection ownership.
  const rejected = assert.rejects(pending, {code:'APPLICATION_DEPLOYMENT_USER_REMOVED'});
  await started;
  const removing = manager.uninstallLocal(slot);
  // Allow local removal admission to revoke the earlier deployment session.
  await new Promise(resolve => setImmediate(resolve));
  pause = false; release();
  await Promise.all([rejected, removing]);
  assert.deepEqual(await manager.listInstalled(), []);
  assert.equal(await readFile(path.join(data,'retained.txt'), 'utf8'), 'business data');
  const installed = await manager.installStandardDeployment(next);
  assert.equal(installed.deployment.generation, 2);
  assert.equal(await readFile(path.join(data,'retained.txt'), 'utf8'), 'business data');
});

for (const edition of ['personal', 'team']) {
  test(`${edition}: local removal fences a miniapp delivery admitted before its package read`, async t => {
    const {createApplicationManager} = await import(`../../${edition}-client/build/app/applications/manager.mjs`);
    const root = await mkdtemp(path.join(os.tmpdir(), 'local-uninstall-admission-'));
    t.after(() => rm(root, {recursive:true, force:true}));
    const assets = path.join(root, 'assets'); await mkdir(assets);
    for (const file of ['runtime-main.cjs','runtime-preload.cjs','runtime-renderer.js','runtime.html'])
      await writeFile(path.join(assets, file), 'module.exports={}');
    const slot = 'ai.wanx.selfmade.' + 'a'.repeat(32);
    async function miniapp(generation) {
      const deployment = {schemaVersion:1, profile:'wanx-expert-app-v1', operationId:String(generation).repeat(32),
        generation, environment:'dev', baseApplicationId:'example.local.expert', slotApplicationId:slot, boxId:'synthetic-box'};
      const artifactHash = String(generation).repeat(64), sourceDir = path.join(root, `package-${generation}`);
      await writeMiniappPackage({applicationId:slot, name:'Local deployed app', version:`0.1.${generation}`, artifactHash,
        manifest:{schemaVersion:1, name:'Local deployed app', entry:'src/app.js', capabilities:['foundation'], collections:{}},
        bundle:'test', css:'', runtimeNamespace:'studio', deployment}, sourceDir, {assets});
      return {sourceDir, binding:{...deployment, fence:1, artifactHash}};
    }
    const manager = await createApplicationManager({applicationRoot:path.join(root, 'apps')});
    t.after(() => manager.close());
    await manager.installDeployment(await miniapp(1));
    const data = path.join(root, 'apps/.runtime', slot);
    await mkdir(data, {recursive:true}); await writeFile(path.join(data, 'retained.txt'), 'business data');
    const next = await miniapp(2);
    let removing;
    const pending = manager.installDeployment({...next, assertSession() {
      // The request has been admitted, but its first asynchronous package read
      // has not completed. This is the pre-serialization race, without timers.
      removing ||= manager.uninstallLocal(slot);
    }});
    await assert.rejects(pending, {code:'APPLICATION_DEPLOYMENT_USER_REMOVED'});
    await removing;
    assert.deepEqual(await manager.listInstalled(), []);
    assert.equal(await readFile(path.join(data, 'retained.txt'), 'utf8'), 'business data');
    assert.equal((await manager.installDeployment(next)).deployment.generation, 2);
    assert.equal(await readFile(path.join(data, 'retained.txt'), 'utf8'), 'business data');
  });
}
