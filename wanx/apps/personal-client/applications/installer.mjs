import { access, cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { renameSync } from "node:fs";
import { verifyEnvelope, marketFailure } from "./descriptor.mjs";
import { extractApplicationArchive as extractVerifiedArchive, verifyPackageHash } from "./verified-archive.mjs";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import path from "node:path";
import semver from "semver";
import { assertApplicationPlatform, isComparableApplicationVersion, readApplicationManifest, resolveApplicationEntry, validateApplicationManifest } from "./manifest.mjs";
import { extractApplicationArchive } from "./archive.mjs";
import { assertApplicationCompatibility } from "./compatibility.mjs";
import { localBindingScope } from './local-binding-scope.mjs';

const fail = (code) => Object.assign(new Error(code), { code });
const safePart = value => value.replace(/[^A-Za-z0-9._-]/g, "_");
const operationIdValid = value => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
async function renameInstalledDirectory(source, target) {
  for (let attempt = 0; ; attempt++) {
    try { return await rename(source, target); }
    catch (error) {
      if (process.platform !== "win32" || !["EPERM", "EACCES", "EBUSY"].includes(error.code) || attempt >= 5) throw error;
      await setTimeout(50 * 2 ** attempt);
    }
  }
}
function bindingSelection(value, artifactId, code = "APPLICATION_CURRENT_INVALID") {
  if (!value || !["bindingSetId", "operationId", "bindingScope"].some(key => Object.hasOwn(value, key))) return {};
  const scope = value.bindingScope;
  if (scope?.schemaVersion === 2 || scope?.authorization === 'local-trust-v1') {
    if (typeof value.bindingSetId !== 'string' || !/^[a-f0-9]{64}$/.test(value.bindingSetId) || !operationIdValid(value.operationId)) throw fail(code);
    try { return { bindingSetId: value.bindingSetId, operationId: value.operationId, bindingScope: localBindingScope(scope, { artifactId }) }; }
    catch { throw fail(code); }
  }
  if (typeof value.bindingSetId !== "string" || !/^[a-f0-9]{64}$/.test(value.bindingSetId) || !operationIdValid(value.operationId) ||
      !scope || scope.artifactId !== artifactId || !Number.isSafeInteger(scope.ownershipEpoch) || scope.ownershipEpoch < 1 ||
      [scope.accountId, scope.deviceId].some(item => typeof item !== "string" || !item || item.length > 256)) throw fail(code);
  return { bindingSetId: value.bindingSetId, operationId: value.operationId,
    bindingScope: { accountId: scope.accountId, deviceId: scope.deviceId, ownershipEpoch: scope.ownershipEpoch, artifactId: scope.artifactId } };
}

export function createApplicationInstaller({ rootDir, now = () => Date.now(), copy = cp, trustedKeys = {}, getCompatibilityContext, hasTrustedDataContinuity, prepareApplication, authorizeRelease } = {}) {
  if (typeof rootDir !== "string" || !rootDir) throw new TypeError("rootDir is required");
  rootDir = path.resolve(rootDir);
  const installedPath = manifest => path.join(rootDir, safePart(manifest.applicationId), safePart(manifest.version));
  const operations = new Map();
  function serialize(id, operation) {
    const result = (operations.get(id) || Promise.resolve()).catch(() => {}).then(operation);
    operations.set(id, result);
    void result.finally(() => { if (operations.get(id) === result) operations.delete(id); }).catch(() => {});
    return result;
  }
  function appDirectory(id) {
    if (typeof id !== "string" || !/^[a-z][a-z0-9._-]{1,63}$/.test(id)) throw fail("INVALID_APPLICATION_ID");
    return path.join(rootDir, id);
  }
  async function recordsFor(id) {
    const directory = appDirectory(id);
    let versions;
    try { versions = await readdir(directory, { withFileTypes: true }); }
    catch (error) { if (error.code === "ENOENT") return []; throw error; }
    const records = [];
    for (const version of versions) {
      if (!version.isDirectory() || version.name.startsWith(".")) continue;
      try {
        const record = JSON.parse(await readFile(path.join(directory, version.name, ".wanx-install.json"), "utf8"));
        validateApplicationManifest(record, { allowLegacyVersion: true, signed: Boolean(record.envelope) });
        if (record.applicationId !== id || path.resolve(record.installPath) !== path.resolve(directory, version.name)) continue;
        if (record.envelope) {
          const descriptor = verifyEnvelope(record.envelope, trustedKeys);
          if (record.artifactId !== descriptor.artifactId || descriptor.artifactId !== version.name ||
              JSON.stringify(validateApplicationManifest(descriptor.manifest, { signed: true })) !== JSON.stringify(validateApplicationManifest(record, { signed: true }))) continue;
        } else if (record.deployment ? version.name !== `managed-${record.deployment.generation}-${record.deployment.operationId}` : safePart(record.version) !== version.name) continue;
        records.push(record);
      } catch { /* Ignore incomplete installations, never their containing current-version record. */ }
    }
    return records;
  }
  const choice = records => ({
    applicationId: records[0].applicationId, name: records[0].name,
    selectionRequired: true,
    versions: records.map(({ version, installedAt }) => ({ version, installedAt })),
  });
  async function removalFor(id) {
    const file = path.join(appDirectory(id), '.wanx-local-removal.json');
    try {
      const info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 65536) throw fail('APPLICATION_DEPLOYMENT_INVALID');
      const value = JSON.parse(await readFile(file, 'utf8')), binding = value?.binding;
      if (value.schemaVersion !== 1 || !binding || binding.slotApplicationId !== id ||
          !Number.isSafeInteger(binding.generation) || binding.generation < 1 || !operationIdValid(binding.operationId))
        throw fail('APPLICATION_DEPLOYMENT_INVALID');
      return value;
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw fail('APPLICATION_DEPLOYMENT_INVALID');
    }
  }
  async function removalState(id) {
    const removal = await removalFor(id);
    if (!removal) return null;
    let marker;
    try { marker = JSON.parse(await readFile(path.join(appDirectory(id), '.wanx-managed-deployment.json'), 'utf8')); }
    catch { throw fail('APPLICATION_DEPLOYMENT_INVALID'); }
    if (!Number.isSafeInteger(marker.generation) || marker.generation < 1 ||
        ['profile','baseApplicationId','slotApplicationId','environment','boxId','scopeId'].some(key => marker[key] !== removal.binding[key]))
      throw fail('APPLICATION_DEPLOYMENT_INVALID');
    return {removal, pending: marker.generation <= removal.binding.generation};
  }
  async function finishLocalRemoval(id, assertSession = () => {}) {
    if (!(await removalState(id))?.pending) return;
    const directory = appDirectory(id), info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw fail('APPLICATION_DEPLOYMENT_INVALID');
    for (const name of await readdir(directory)) {
      if (['.wanx-managed-deployment.json', '.wanx-local-removal.json'].includes(name)) continue;
      assertSession();
      await rm(path.join(directory, name), {recursive:true, force:true});
    }
  }
  async function admitManagedInstall(id, binding, assertSession) {
    const removal = await removalFor(id);
    if (!removal) return;
    if (binding.generation <= removal.binding.generation) throw fail('APPLICATION_DEPLOYMENT_USER_REMOVED');
    // Complete an interrupted removal before advancing the high-water marker.
    // All calls share the slot serializer, so cleanup cannot remove a new install.
    await finishLocalRemoval(id, assertSession);
    assertSession();
  }
  async function currentFor(id, records = null) {
    if ((await removalState(id))?.pending) return null;
    records ||= await recordsFor(id);
    if (!records.length) return null;
    let current;
    try { current = JSON.parse(await readFile(path.join(appDirectory(id), ".current-version.json"), "utf8")); }
    catch (error) { if (error.code !== "ENOENT") throw fail("APPLICATION_CURRENT_INVALID"); }
    if (!current) {
      try {
        const state = JSON.parse(await readFile(path.join(appDirectory(id), ".wanx-state.json"), "utf8"));
        if (state.schemaVersion !== 1 || typeof state.current !== "string") throw fail("APPLICATION_CURRENT_INVALID");
        current = { key: state.current, previousKey: state.previous };
      } catch (error) { if (error.code !== "ENOENT") throw fail("APPLICATION_CURRENT_INVALID"); }
    }
    if (current) {
      if (Array.isArray(current.choices)) {
        const choices = current.choices.map(version => records.find(record => record.version === version));
        if (!choices.length || choices.some(record => !record)) throw fail("APPLICATION_CURRENT_INVALID");
        return choice(choices);
      }
      const record = records.find(record => current.key ? path.basename(record.installPath) === current.key : record.version === current.version);
      if (!record) throw fail("APPLICATION_CURRENT_INVALID");
      const previous = records.find(record => path.basename(record.installPath) === current.previousKey);
      return { ...record, ...bindingSelection(current, record.artifactId), ...(previous?.envelope ? {
        previous: { version: previous.version, artifactId: previous.artifactId, ...bindingSelection(current.previousBinding, previous.artifactId) },
      } : {}) };
    }
    // A signed artifact without a committed pointer is an interrupted install.
    records = records.filter(record => !record.envelope && !record.deployment);
    if (!records.length) return null;
    if (records.some(record => !isComparableApplicationVersion(record.version))) return choice(records);
    const sorted = records.toSorted((a, b) => semver.rcompare(a.version, b.version));
    if (sorted.length > 1 && semver.eq(sorted[0].version, sorted[1].version)) return choice(records);
    return sorted[0];
  }
  async function managedSlot(id) {
    try { await lstat(path.join(appDirectory(id),'.wanx-managed-deployment.json')); return true; }
    catch(error) { if(error.code!=='ENOENT')throw error; }
    return Boolean((await currentFor(id))?.deployment);
  }
  async function assertUnmanaged(id) {
    if(await managedSlot(id))throw fail('APPLICATION_MANAGED_DEPLOYMENT_REQUIRED');
  }
  async function publish(id, current, signal, assertSession = () => {}) {
    const directory = appDirectory(id), temporary = path.join(directory, `.current-${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, JSON.stringify(current), { mode: 0o600, flag: "wx" });
      signal?.throwIfAborted();
      // Authorization and pointer publication must not yield between checking and commit.
      assertSession();
      renameSync(temporary, path.join(directory, ".current-version.json"));
    } finally { await rm(temporary, { force: true }); }
  }
  async function pendingFor(id, records = null) {
    let pending;
    try { pending = JSON.parse(await readFile(path.join(appDirectory(id), ".pending-install.json"), "utf8")); }
    catch (error) { if (error.code === "ENOENT") return null; throw fail("APPLICATION_PENDING_INVALID"); }
    records ||= await recordsFor(id);
    const record = records.find(item => item.envelope && item.artifactId === pending.artifactId);
    if (pending.schemaVersion !== 1 || !record || !["pending", "blocked"].includes(pending.preparation?.status) ||
        typeof pending.preparation.code !== "string" || !/^[A-Z][A-Z0-9_]{1,80}$/.test(pending.preparation.code) ||
        pending.operationId !== undefined && !operationIdValid(pending.operationId))
      throw fail("APPLICATION_PENDING_INVALID");
    return { ...record, ...(pending.operationId ? { operationId: pending.operationId } : {}), installationState: "pending", resourcePreparation: pending.preparation };
  }
  async function savePending(id, artifactId, operationId, preparation, check) {
    const directory = appDirectory(id), temporary = path.join(directory, `.pending-${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, JSON.stringify({ schemaVersion: 1, artifactId, operationId, preparation }), { mode: 0o600, flag: "wx" });
      check();
      renameSync(temporary, path.join(directory, ".pending-install.json"));
    } finally { await rm(temporary, { force: true }); }
  }
  async function clearPending(id, artifactId) {
    const pending = await pendingFor(id);
    if (pending?.artifactId === artifactId) await rm(path.join(appDirectory(id), ".pending-install.json"), { force: true });
  }
  const preparationView = value => ({
    status: value?.status === "blocked" ? "blocked" : "pending",
    code: typeof value?.code === "string" && /^[A-Z][A-Z0-9_]{1,80}$/.test(value.code)
      ? value.code : "APPLICATION_RESOURCES_PENDING",
  });
  async function installationView(id) {
    const current = await currentFor(id);
    let pending;
    try { pending = await pendingFor(id); }
    catch (error) { if (!current) throw error; return current; }
    if (!current) return pending;
    // A committed pointer wins over a leftover intent after a process exits
    // between pointer publication and pending-marker cleanup.
    return pending && pending.artifactId !== current.artifactId ? { ...current, pendingInstallation: pending } : current;
  }

  async function install({ archivePath, sourceDir, ...options } = {}, { signal } = {}) {
    signal?.throwIfAborted();
    if (archivePath !== undefined && options.standardArtifactHash !== undefined) {
      const {standardArtifactHash, manifest: expected, ...extra} = options;
      if (sourceDir || typeof archivePath !== "string" || Object.keys(extra).length || !/^[a-f0-9]{64}$/.test(standardArtifactHash) || expected?.protocolVersion !== 3) throw fail("APPLICATION_SOURCE_REQUIRED");
      await mkdir(rootDir, {recursive:true, mode:0o700});
      const staging = await mkdtemp(path.join(await realpath(rootDir), ".unpacking-"));
      try {
        const bytes = await readFile(archivePath);
        if (createHash("sha256").update(bytes).digest("hex") !== standardArtifactHash) throw fail("APPLICATION_ARTIFACT_INVALID");
        const frozen = path.join(staging,"application.zip"), destination = path.join(staging,"content");
        await writeFile(frozen,bytes,{flag:"wx",mode:0o600});
        await mkdir(destination);
        const source = await extractApplicationArchive(frozen,destination);
        const manifest = await readApplicationManifest(path.join(source,"application.manifest.json"));
        if (JSON.stringify(manifest) !== JSON.stringify(validateApplicationManifest(expected))) throw fail("APPLICATION_MANIFEST_MISMATCH");
        return await installDirectory({sourceDir:source,manifest},signal,standardArtifactHash);
      } finally { await rm(staging,{recursive:true,force:true}); }
    }
    if (archivePath !== undefined) {
      if (typeof archivePath !== "string" || !archivePath || sourceDir || Object.keys(options).length)
        throw fail("APPLICATION_SOURCE_REQUIRED");
      await mkdir(rootDir, { recursive: true, mode: 0o700 });
      const staging = await mkdtemp(path.join(await realpath(rootDir), ".unpacking-"));
      try {
        const extracted = await extractApplicationArchive(archivePath, staging);
        return await installDirectory({ sourceDir: extracted }, signal);
      } finally { await rm(staging, { recursive: true, force: true }); }
    }
    return installDirectory({ sourceDir, ...options }, signal);
  }
  async function installDirectory({ sourceDir, manifest: suppliedManifest, manifestPath }, signal, packageSha256) {
    if (typeof sourceDir !== "string" || !sourceDir) throw fail("APPLICATION_SOURCE_REQUIRED");
    let source;
    try { source = await stat(sourceDir); } catch { throw fail("APPLICATION_SOURCE_NOT_FOUND"); }
    if (!source.isDirectory()) throw fail("APPLICATION_SOURCE_NOT_DIRECTORY");
    const manifest = suppliedManifest ? validateApplicationManifest(suppliedManifest)
      : await readApplicationManifest(manifestPath || path.join(sourceDir, "application.manifest.json"));
    if (manifest.releaseAccess === "account") throw fail("MARKET_RELEASE_ACCESS_SIGNED_PACKAGE_REQUIRED");
    assertApplicationPlatform(manifest);
    await assertApplicationCompatibility(manifest, { getCompatibilityContext, phase: "import" });
    await resolveApplicationEntry(sourceDir, manifest);
    return serialize(manifest.applicationId, async () => {
      signal?.throwIfAborted();
      const current = await currentFor(manifest.applicationId);
      await assertUnmanaged(manifest.applicationId);
      if (current?.selectionRequired) throw fail("APPLICATION_VERSION_SELECTION_REQUIRED");
      if (current && isComparableApplicationVersion(current.version)) {
        const comparison = semver.compare(manifest.version, current.version);
        if (comparison <= 0) throw fail(comparison === 0 ? "APPLICATION_VERSION_ALREADY_INSTALLED" : "APPLICATION_VERSION_DOWNGRADE");
      }
      const target = installedPath(manifest);
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      try { await access(target); throw fail("APPLICATION_VERSION_ALREADY_INSTALLED"); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      const staging = await mkdtemp(path.join(path.dirname(target), ".installing-"));
      const temporary = path.join(staging, "content");
      const record = { ...manifest, installPath: target, installedAt: now(), installationSource: "local", ...(packageSha256 ? {packageSha256} : {}) };
      let committed = false;
      try {
        await copy(sourceDir, temporary, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
        await resolveApplicationEntry(temporary, manifest);
        await writeFile(path.join(temporary, ".wanx-install.json"), JSON.stringify(record), { mode: 0o600, flag: "wx" });
        signal?.throwIfAborted();
        await renameInstalledDirectory(temporary, target);
        committed = true;
        const selection = current && !isComparableApplicationVersion(current.version)
          ? { choices: [current.version, record.version] } : { version: record.version };
        await publish(manifest.applicationId, selection, signal);
        return selection.choices ? choice([current, record]) : Object.freeze(record);
      } catch (error) {
        if (committed) await rm(target, { recursive: true, force: true });
        if (signal?.aborted) throw signal.reason;
        if (["EEXIST", "ENOTEMPTY"].includes(error?.code)) throw fail("APPLICATION_VERSION_ALREADY_INSTALLED");
        throw fail("APPLICATION_INSTALL_FAILED");
      } finally { await rm(staging, { recursive: true, force: true }); }
    });
  }

  // Main-process-only entry: a server-issued deployment ticket owns this slot.
  async function installDeployment({sourceDir,binding,assertSession=()=>{}}={}, {signal}={}) {
    const fields=['profile','baseApplicationId','slotApplicationId','environment','boxId','operationId','generation','fence','artifactHash'];
    if(!binding||fields.some(k=>binding[k]===undefined)||!['wanx-miniapp-v1','wanx-expert-app-v1'].includes(binding.profile)||
      !/^ai\.wanx\.selfmade\.[a-f0-9]{32}$/.test(binding.slotApplicationId)||
      !(typeof binding.baseApplicationId==='string'&&(binding.profile==='wanx-miniapp-v1'?/^ai\.wanx\.selfmade\.[a-f0-9]{32}$/:/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/).test(binding.baseApplicationId))||
      binding.slotApplicationId===binding.baseApplicationId||!['dev','prod'].includes(binding.environment)||!operationIdValid(binding.operationId)||
      !Number.isSafeInteger(binding.generation)||binding.generation<1||!Number.isSafeInteger(binding.fence)||binding.fence<1||
      !/^[a-f0-9]{64}$/.test(binding.artifactHash)||typeof binding.boxId!=='string'||!binding.boxId)throw fail('APPLICATION_DEPLOYMENT_INVALID');
    const check=()=>{signal?.throwIfAborted();assertSession()};check();
    const manifest=await readApplicationManifest(path.join(sourceDir,'application.manifest.json'));
    const payload=JSON.parse(await readFile(path.join(sourceDir,'miniapp.runtime.json'),'utf8'));
    const expected={schemaVersion:1,profile:binding.profile,operationId:binding.operationId,environment:binding.environment,generation:binding.generation,baseApplicationId:binding.baseApplicationId,slotApplicationId:binding.slotApplicationId,boxId:binding.boxId};
    if(manifest.applicationId!==binding.slotApplicationId||payload.applicationId!==binding.slotApplicationId||payload.artifactHash!==binding.artifactHash||
      !payload.deployment||Object.keys(payload.deployment).length!==Object.keys(expected).length||Object.keys(expected).some(k=>payload.deployment[k]!==expected[k]))throw fail('APPLICATION_DEPLOYMENT_MISMATCH');
    await assertApplicationCompatibility(manifest,{getCompatibilityContext,phase:'import'});
    await resolveApplicationEntry(sourceDir,manifest);
    return serialize(manifest.applicationId,async()=>{
      check();const directory=appDirectory(manifest.applicationId);const current=await currentFor(manifest.applicationId);
      const stableKeys=['profile','baseApplicationId','slotApplicationId','environment','boxId'];
      if(current&&!current.deployment)throw fail('APPLICATION_DEPLOYMENT_SLOT_OCCUPIED');
      const marker=path.join(directory,'.wanx-managed-deployment.json');
      let previous;try{previous=JSON.parse(await readFile(marker,'utf8'))}catch(e){if(e.code!=='ENOENT')throw fail('APPLICATION_DEPLOYMENT_INVALID')}
      if(previous){
        if(stableKeys.some(k=>previous[k]!==binding[k]))throw fail('APPLICATION_DEPLOYMENT_SLOT_OCCUPIED');
        if(binding.generation<previous.generation||binding.generation===previous.generation&&(binding.operationId!==previous.operationId||binding.artifactHash!==previous.artifactHash||binding.fence<previous.fence))throw fail('APPLICATION_DEPLOYMENT_STALE');
      }
      await admitManagedInstall(manifest.applicationId, binding, check);
      await mkdir(directory,{recursive:true,mode:0o700});check();
      // Persist the high-water mark before any installation; uncertain failures fence older work.
      const temporaryMarker=path.join(directory,`.deployment-${randomUUID()}.tmp`);
      try{await writeFile(temporaryMarker,JSON.stringify(binding),{flag:'wx',mode:0o600});check();renameSync(temporaryMarker,marker)}finally{await rm(temporaryMarker,{force:true})}
      const target=path.join(directory,`managed-${binding.generation}-${binding.operationId}`);
      let record;
      try{
        record=JSON.parse(await readFile(path.join(target,'.wanx-install.json'),'utf8'));
        const installed=JSON.parse(await readFile(path.join(target,'miniapp.runtime.json'),'utf8'));
        if(record.deployment?.artifactHash!==binding.artifactHash||JSON.stringify(installed)!==JSON.stringify(payload))throw fail('APPLICATION_DEPLOYMENT_MISMATCH');
      }catch(error){
        if(error.code!=='ENOENT')throw error;
        const staging=await mkdtemp(path.join(directory,'.deploying-'));
        try{
          const content=path.join(staging,'content');await copy(sourceDir,content,{recursive:true,errorOnExist:true,force:false,verbatimSymlinks:true});
          await resolveApplicationEntry(content,manifest);check();
          if(JSON.stringify(JSON.parse(await readFile(path.join(content,'miniapp.runtime.json'),'utf8')))!==JSON.stringify(payload))throw fail('APPLICATION_DEPLOYMENT_MISMATCH');
          record={...manifest,installPath:target,installedAt:now(),installationSource:'selfmade',deployment:{...binding}};
          await writeFile(path.join(content,'.wanx-install.json'),JSON.stringify(record),{flag:'wx',mode:0o600});check();
          await renameInstalledDirectory(content,target);
        }finally{await rm(staging,{recursive:true,force:true})}
      }
      check();await publish(manifest.applicationId,{key:path.basename(target)},signal,assertSession);
      return currentFor(manifest.applicationId);
    });
  }
  async function list() {
    let apps;
    try { apps = await readdir(rootDir, { withFileTypes: true }); }
    catch (error) { if (error.code === "ENOENT") return []; throw error; }
    const result = [];
    for (const app of apps) {
      if (!app.isDirectory() || !/^[a-z][a-z0-9._-]{1,63}$/.test(app.name)) continue;
      const current = await serialize(app.name, () => installationView(app.name));
      if (current) result.push(current.protocolVersion === 3 && current.compatibility.resourceDependencies.length
        && current.installationState !== "pending"
        ? { ...current, resourcePreparation: { status: "pending", code: "APPLICATION_RESOURCES_PENDING" } } : current);
    }
    return result;
  }
  async function resolveCurrent(id) {
    appDirectory(id);
    return serialize(id, async () => {
      const current = await currentFor(id);
      if (!current) throw fail(await pendingFor(id) ? "APPLICATION_RESOURCES_PENDING" : "APPLICATION_NOT_INSTALLED");
      if (current.selectionRequired) throw fail("APPLICATION_VERSION_SELECTION_REQUIRED");
      return current;
    });
  }
  async function selectCurrent(id, version, { signal } = {}) {
    appDirectory(id);
    return serialize(id, async () => {
      await assertUnmanaged(id);
      const current = await currentFor(id);
      if (!current?.selectionRequired || !current.versions.some(record => record.version === version))
        throw fail("APPLICATION_VERSION_SELECTION_INVALID");
      const selected = (await recordsFor(id)).find(record => record.version === version);
      const descriptor = selected.envelope ? verifyEnvelope(selected.envelope, trustedKeys) : undefined;
      await assertApplicationCompatibility(selected, { getCompatibilityContext, descriptor, phase: "select",
        trustedDataContinuity: descriptor?.schemaVersion >= 2 && await hasTrustedDataContinuity?.(descriptor) === true });
      let pointer = {};
      try { pointer = JSON.parse(await readFile(path.join(appDirectory(id), ".current-version.json"), "utf8")); }
      catch (error) { if (error.code !== "ENOENT") throw fail("APPLICATION_CURRENT_INVALID"); }
      const binding = selected.artifactId === pointer.key ? bindingSelection(pointer, selected.artifactId) : {};
      await publish(id, { version, ...(selected.artifactId ? { key: selected.artifactId } : {}), ...binding }, signal);
      return currentFor(id);
    });
  }
  async function prune(id, inUseVersion) {
    return serialize(id, async () => {
      if(await managedSlot(id))return;
      const records = await recordsFor(id), current = await currentFor(id, records);
      let pending;
      try { pending = await pendingFor(id, records); } catch { return; }
      if (!current || current.selectionRequired) return;
      for (const record of records) {
        if (record.version !== current.version && record.version !== inUseVersion && !(record.artifactId &&
            [current.previous?.artifactId, pending?.artifactId].includes(record.artifactId)))
          await rm(record.installPath, { recursive: true, force: true });
      }
    });
  }
  async function installVerifiedPackage({ archivePath, envelope, assertSession = () => {}, onlyIfMissing = false, installationSource = "local" } = {}, { signal } = {}) {
    const descriptor = verifyEnvelope(envelope, trustedKeys);
    if (descriptor.packageType !== "wanxapp") throw marketFailure("MARKET_INCOMPATIBLE");
    let access;
    const controlled = descriptor.manifest.releaseAccess === "account";
    const check = () => { signal?.throwIfAborted(); assertSession(); access?.assertSession(); };
    async function confirmAccess() {
      check();
      if (!controlled) return;
      if (!authorizeRelease) throw fail("MARKET_RELEASE_ACCESS_REQUIRED");
      const permit = await authorizeRelease(descriptor, { signal });
      check();
      if (!permit) throw fail("MARKET_RELEASE_ACCESS_REQUIRED");
      permit.assertLive(); access = permit;
    }
    return serialize(descriptor.applicationId, async () => {
      check();
      await assertUnmanaged(descriptor.applicationId);
      // Delivery defaults must never replace a version installed by the user,
      // including one committed while the package was downloading.
      if (onlyIfMissing) {
        const existing = await currentFor(descriptor.applicationId);
        check();
        if (existing) return existing;
      }
      await confirmAccess();
      await assertApplicationCompatibility(descriptor.manifest, {
        getCompatibilityContext, descriptor, phase: "install",
        // Only the Host can attest that this exact signed artifact last opened the data.
        trustedDataContinuity: descriptor.schemaVersion >= 2 && await hasTrustedDataContinuity?.(descriptor) === true,
      });
      check();
      const current = await currentFor(descriptor.applicationId);
      if (current?.selectionRequired) throw fail("APPLICATION_VERSION_SELECTION_REQUIRED");
      if (current && isComparableApplicationVersion(current.version) && semver.compare(descriptor.version, current.version) <= 0)
        throw marketFailure("MARKET_UPDATE_NOT_AVAILABLE");
      const directory = appDirectory(descriptor.applicationId), target = path.join(directory, descriptor.artifactId);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const temporary = path.join(directory, `.staging-${randomUUID()}`);
      let moved = false, committed = false, staged = false, preparation;
      try {
        await verifyPackageHash(archivePath, descriptor, check);
        const manifest = await extractVerifiedArchive(archivePath, temporary, descriptor, check);
        const record = { ...manifest, artifactId: descriptor.artifactId, descriptor, envelope, installPath: target, installedAt: now(), installationSource: installationSource === "cloud" ? "cloud" : "local" };
        await writeFile(path.join(temporary, ".wanx-install.json"), JSON.stringify(record), { mode: 0o600, flag: "wx" });
        check();
        const retained = (await recordsFor(descriptor.applicationId)).find(item => item.installPath === target);
        if (retained) {
          if (JSON.stringify(retained.envelope) !== JSON.stringify(envelope)) throw marketFailure("MARKET_PACKAGE_INVALID");
          await compareInstalledContent(temporary, target, check);
        } else {
          await renameInstalledDirectory(temporary, target);
          moved = true;
        }
        const selection = current && !isComparableApplicationVersion(current.version)
          ? { choices: [current.version, record.version], key: descriptor.artifactId }
          : { version: record.version, key: descriptor.artifactId, previousKey: current ? path.basename(current.installPath) : null,
            ...(current?.bindingSetId ? { previousBinding: bindingSelection(current, current.artifactId) } : {}) };
        // Keep a durable candidate independently of the current pointer. A box
        // error, offline install or process restart must not activate this copy.
        if (manifest.protocolVersion === 3 && manifest.compatibility.resourceDependencies.length) {
          const pending = await pendingFor(descriptor.applicationId);
          const operationId = pending?.artifactId === descriptor.artifactId && pending.operationId || randomUUID();
          await savePending(descriptor.applicationId, descriptor.artifactId, operationId, preparationView(), check);
          staged = true;
          try { preparation = await prepareApplication?.({ manifest, descriptor, operationId, phase: "install" }); }
          catch (error) {
            check();
            await savePending(descriptor.applicationId, descriptor.artifactId, operationId,
              preparationView({ status: "blocked", code: error.code }), check);
            throw error;
          }
          check();
          preparation?.assertCurrent?.();
          if (preparation?.status !== "ready") {
            await savePending(descriptor.applicationId, descriptor.artifactId, operationId, preparationView(preparation), check);
            return installationView(descriptor.applicationId);
          }
          if (preparation.operationId !== operationId || !preparation.bindingSetId) throw fail("APPLICATION_PREPARATION_INVALID");
          Object.assign(selection, bindingSelection(preparation, descriptor.artifactId, "APPLICATION_PREPARATION_INVALID"));
        }
        check();
        await confirmAccess();
        await publish(descriptor.applicationId, selection, signal, () => {
          check(); access?.assertLive(); preparation?.assertCurrent?.();
        });
        committed = true;
        if (staged) await clearPending(descriptor.applicationId, descriptor.artifactId);
        return selection.choices ? choice([current, record]) : { ...await currentFor(descriptor.applicationId),
          ...(preparation ? { resourcePreparation: { status: "ready" } } : {}) };
      } finally {
        await rm(temporary, { recursive: true, force: true });
        if (moved && !committed && !staged) await rm(target, { recursive: true, force: true });
      }
    });
  }
  async function prepareCurrent(id, { assertSession = () => {}, signal } = {}) {
    appDirectory(id);
    return serialize(id, async () => {
      const current = await currentFor(id);
      if (!current || current.selectionRequired) throw fail("APPLICATION_NOT_INSTALLED");
      if (current.protocolVersion !== 3 || !current.compatibility.resourceDependencies.length) return current;
      if (!current.envelope) throw fail("APPLICATION_RESOURCE_ARTIFACT_REQUIRED");
      // The local install record is not an authority for the resource manifest.
      const descriptor = verifyEnvelope(current.envelope, trustedKeys), manifest = descriptor.manifest;
      if (descriptor.artifactId !== current.artifactId) throw fail("APPLICATION_CURRENT_INVALID");
      let permit;
      const check = () => { signal?.throwIfAborted(); assertSession(); permit?.assertSession?.(); };
      async function confirmAccess() {
        check();
        if (manifest.releaseAccess !== "account") return;
        if (!authorizeRelease) throw fail("MARKET_RELEASE_ACCESS_REQUIRED");
        const next = await authorizeRelease(descriptor, { signal });
        check();
        if (!next) throw fail("MARKET_RELEASE_ACCESS_REQUIRED");
        next.assertLive(); permit = next;
      }
      await confirmAccess();
      const operationId = current.operationId || `rebind-${descriptor.artifactId}`;
      const preparation = await prepareApplication?.({ manifest, descriptor, operationId, phase: "rebind" });
      check(); preparation?.assertCurrent?.();
      if (preparation?.status !== "ready") return { ...current, resourcePreparation: preparationView(preparation) };
      if (preparation.operationId !== operationId || !preparation.bindingSetId) throw fail("APPLICATION_PREPARATION_INVALID");
      const binding = bindingSelection(preparation, descriptor.artifactId, "APPLICATION_PREPARATION_INVALID");
      await confirmAccess();
      const assertCurrent = () => { check(); permit?.assertLive(); preparation.assertCurrent?.(); };
      if (JSON.stringify(bindingSelection(current, current.artifactId)) === JSON.stringify(binding)) {
        assertCurrent();
        return { ...current, resourcePreparation: { status: "ready" } };
      }
      const selection = { version: current.version, key: current.artifactId,
        previousKey: current.previous?.artifactId || null, ...binding,
        ...(current.previous?.bindingSetId ? { previousBinding: bindingSelection(current.previous, current.previous.artifactId) } : {}),
      };
      await publish(id, selection, signal, assertCurrent);
      return { ...await currentFor(id), resourcePreparation: { status: "ready" } };
    });
  }
  async function recover() {
    let apps;
    try { apps = await readdir(rootDir, { withFileTypes: true }); } catch (error) { if (error.code === "ENOENT") return; throw error; }
    for (const app of apps) {
      if (app.name.startsWith(".removed-") || app.name.startsWith(".unpacking-")) {
        await rm(path.join(rootDir, app.name), { recursive: true, force: true });
      } else if (app.isDirectory() && /^[a-z][a-z0-9._-]{1,63}$/.test(app.name)) {
        await serialize(app.name, () => finishLocalRemoval(app.name));
        let current, pending;
        try { current = await currentFor(app.name); pending = await pendingFor(app.name); } catch { continue; }
        const retainedVersions = current?.selectionRequired ? current.versions.map(item => item.version) : [current?.version, current?.previous?.version];
        for (const record of await recordsFor(app.name)) {
          if (record.envelope && !retainedVersions.includes(record.version) && record.artifactId !== pending?.artifactId)
            await rm(record.installPath, { recursive: true, force: true });
        }
        if (pending && pending.artifactId === current?.artifactId) await clearPending(app.name, pending.artifactId);
        for (const item of await readdir(appDirectory(app.name))) {
          if (item.startsWith(".staging-") || item.startsWith(".installing-") || item.startsWith(".local-removal-") && item.endsWith(".tmp") || item.startsWith(".pending-") && item.endsWith(".tmp") ||
              (item.startsWith(".current-") || item.startsWith(".wanx-state.json.")) && item.endsWith(".tmp"))
            await rm(path.join(appDirectory(app.name), item), { recursive: true, force: true });
        }
      }
    }
  }
  async function uninstallLocal(id, assertSession = () => {}) {
    appDirectory(id);
    return serialize(id, async () => {
      assertSession();
      if (!await managedSlot(id)) {
        const removed = path.join(rootDir, `.removed-${randomUUID()}`);
        assertSession();
        try { renameSync(appDirectory(id), removed); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        await rm(removed, {recursive:true, force:true});
        return {applicationId:id, state:'uninstalled'};
      }
      const directory = appDirectory(id), info = await lstat(directory);
      if (!info.isDirectory() || info.isSymbolicLink()) throw fail('APPLICATION_DEPLOYMENT_INVALID');
      let binding;
      try { binding = JSON.parse(await readFile(path.join(directory, '.wanx-managed-deployment.json'), 'utf8')); }
      catch { throw fail('APPLICATION_DEPLOYMENT_INVALID'); }
      if (binding.slotApplicationId !== id || !Number.isSafeInteger(binding.generation) || binding.generation < 1 ||
          !operationIdValid(binding.operationId)) throw fail('APPLICATION_DEPLOYMENT_INVALID');
      const temporary = path.join(directory, `.local-removal-${randomUUID()}.tmp`);
      try {
        await writeFile(temporary, JSON.stringify({schemaVersion:1, binding}), {flag:'wx', mode:0o600});
        assertSession();
        renameSync(temporary, path.join(directory, '.wanx-local-removal.json'));
      } finally { await rm(temporary, {force:true}); }
      // The tombstone hides the old pointer immediately, including after a crash.
      await finishLocalRemoval(id, assertSession);
      return {applicationId:id, state:'uninstalled'};
    });
  }
  async function uninstall(id, assertSession = () => {}) {
    appDirectory(id);
    return serialize(id, async () => {
      await assertUnmanaged(id);
      assertSession();
      const removed = path.join(rootDir, `.removed-${randomUUID()}`);
      try { renameSync(appDirectory(id), removed); } catch (error) { if (error.code !== "ENOENT") throw error; }
      await rm(removed, { recursive: true, force: true });
      return { applicationId: id, state: "uninstalled" };
    });
  }
  async function rollback(id, assertSession = () => {}) {
    appDirectory(id);
    return serialize(id, async () => {
      await assertUnmanaged(id);
      const current = await currentFor(id), records = await recordsFor(id);
      const previous = current?.previous && records.find(record => record.artifactId === current.previous.artifactId);
      if (!previous?.envelope) throw marketFailure("MARKET_ROLLBACK_UNAVAILABLE");
      const prepared = await prepareRollback(current, previous, assertSession);
      await resolveApplicationEntry(previous.installPath, previous);
      await publish(id, { version: previous.version, key: previous.artifactId, previousKey: path.basename(current.installPath),
        ...bindingSelection(prepared.selected, previous.artifactId),
        ...(current.bindingSetId ? { previousBinding: bindingSelection(current, current.artifactId) } : {}),
      }, undefined, prepared.assertCurrent);
      return currentFor(id);
    });
  }
  async function prepareRollback(current, previous, assertSession = () => {}) {
    const descriptor = verifyEnvelope(previous.envelope, trustedKeys), manifest = descriptor.manifest;
    if (descriptor.artifactId !== previous.artifactId) throw fail("APPLICATION_CURRENT_INVALID");
    let selected = { ...previous, descriptor, ...bindingSelection(current.previous, previous.artifactId) };
    let access, preparation;
    const check = () => { assertSession(); access?.assertSession?.(); preparation?.assertCurrent?.(); };
    async function confirmAccess() {
      check();
      if (manifest.releaseAccess !== "account") return;
      if (!authorizeRelease) throw fail("MARKET_RELEASE_ACCESS_REQUIRED");
      const next = await authorizeRelease(descriptor);
      check();
      if (!next) throw fail("MARKET_RELEASE_ACCESS_REQUIRED");
      next.assertLive(); access = next;
    }
    await confirmAccess();
    if (manifest.protocolVersion === 3 && manifest.compatibility.resourceDependencies.length) {
      // A retained binding belongs to its original account and box. Prepare a
      // candidate in the current scope without changing either active pointer.
      const operationId = selected.operationId || `rollback-${descriptor.artifactId}`;
      preparation = await prepareApplication?.({ manifest, descriptor, operationId, phase: "rollback" });
      check();
      if (preparation?.status !== "ready") throw fail(preparationView(preparation).code);
      if (preparation.operationId !== operationId || !preparation.bindingSetId) throw fail("APPLICATION_PREPARATION_INVALID");
      selected = { ...selected, ...bindingSelection(preparation, descriptor.artifactId, "APPLICATION_PREPARATION_INVALID") };
    }
    const compatibility = await checkRollback(current, selected);
    await confirmAccess();
    const assertCurrent = () => { check(); access?.assertLive(); compatibility.assertCurrent?.(); };
    assertCurrent();
    return { selected, compatibility: compatibility.compatibility, assertCurrent };
  }
  async function checkRollback(current, previous) {
    if (current?.protocolVersion >= 2 && previous.protocolVersion < 2) throw fail("APPLICATION_DATA_COMPATIBILITY_UNKNOWN");
    let assertCurrent;
    const compatibility = await assertApplicationCompatibility(previous, {
      getCompatibilityContext: async input => {
        const context = await getCompatibilityContext?.(input);
        assertCurrent = context?.assertCurrent;
        return context;
      }, descriptor: previous.descriptor, phase: "rollback",
    });
    return { compatibility, assertCurrent };
  }
  async function assertRollbackCompatible(id) {
    appDirectory(id);
    return serialize(id, async () => {
      const current = await currentFor(id), records = await recordsFor(id);
      const previous = current?.previous && records.find(record => record.artifactId === current.previous.artifactId);
      if (!previous?.envelope) throw marketFailure("MARKET_ROLLBACK_UNAVAILABLE");
      return (await prepareRollback(current, previous)).compatibility;
    });
  }
  return Object.freeze({ install, installDeployment, installVerifiedPackage, prepareCurrent, list, installedPath, resolveCurrent, selectCurrent, prune, recover, uninstall, uninstallLocal, assertUnmanaged, rollback, assertRollbackCompatible });
}

// Reinstalling the retained previous artifact must not overwrite a usable copy.
// Compare it with the freshly verified archive before switching the active pointer.
async function compareInstalledContent(expectedDir, actualDir, assertSession) {
  const expected = (await readdir(expectedDir)).filter((name) => name !== ".wanx-install.json").sort();
  const actual = (await readdir(actualDir)).filter((name) => name !== ".wanx-install.json").sort();
  if (JSON.stringify(expected) !== JSON.stringify(actual)) throw marketFailure("MARKET_PACKAGE_INVALID");
  for (const name of expected) {
    assertSession();
    const a = path.join(expectedDir, name), b = path.join(actualDir, name);
    const as = await lstat(a), bs = await lstat(b);
    if (bs.isSymbolicLink() || as.isDirectory() !== bs.isDirectory() || as.isFile() !== bs.isFile()) throw marketFailure("MARKET_PACKAGE_INVALID");
    if (as.isDirectory()) await compareInstalledContent(a, b, assertSession);
    else {
      if (as.size !== bs.size) throw marketFailure("MARKET_PACKAGE_INVALID");
      const { createHash } = await import("node:crypto"), { createReadStream } = await import("node:fs");
      const hash = async (file) => {
        const digest = createHash("sha256");
        for await (const chunk of createReadStream(file)) { assertSession(); digest.update(chunk); }
        return digest.digest("hex");
      };
      if (await hash(a) !== await hash(b)) throw marketFailure("MARKET_PACKAGE_INVALID");
    }
  }
}
