import {validStarlinkTarget} from './starlink-target.mjs';
import {fileIdentity} from './file-identity.mjs';
import path from "node:path";
import semver from "semver";
import { constants } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readdir, realpath, rename, rm } from "node:fs/promises";
import { verifyEnvelope } from "./descriptor.mjs";
import { createApplicationSession } from "../app-host/session.mjs";
import { createApplicationInstaller } from "./installer.mjs";
import { createApplicationLauncher } from "./launcher.mjs";
import { assertApplicationCompatibility } from "./compatibility.mjs";
import { createDefaultApplicationStore } from "./delivery.mjs";
import { inspectZhijunData } from "./zhijun-data.mjs";
import { inspectAiBrowserData } from "./ai-browser-data.mjs";
import { inspectCentaurloopData } from "./centaurloop-data.mjs";
import { applicationProfilePath, localApplicationProfile } from "./data-profile.mjs";
import { applicationExecutable } from "./desktop-runtime.mjs";
import { readDataSchema, writeDataSchema } from "./data-schema.mjs";

export async function createApplicationManager({
  applicationRoot,
  applicationId,
  context,
  request,
  stream,
  createConnection,
  spawn,
  electronPath,
  runtimeArgs,
  launcherArgs,
  trustedKeys = {},
  getCompatibilityContext,
  prepareApplication,
  authorizeRelease,
  openWorkshop,
  assertClientUsable = () => {},
  getDataIdentity,
} = {}) {
  applicationRoot = path.resolve(applicationRoot);
  const defaultApplicationDeliveryStore = createDefaultApplicationStore(path.join(applicationRoot, ".delivery"));
  const profileKey = () => { const identity = getDataIdentity?.(); return identity?.profileId ? localApplicationProfile(identity) : null; };
  const storageContext = () => {
    const profile = profileKey();
    return { profile, root: path.join(applicationRoot, ".data-access", ...(profile ? [profile] : [])),
      assertLive() { if (profileKey() !== profile) throw dataUnknown(); } };
  };
  const dataUnknown = () => Object.assign(new Error("APPLICATION_DATA_COMPATIBILITY_UNKNOWN"), { code: "APPLICATION_DATA_COMPATIBILITY_UNKNOWN" });
  async function dataAccessDirectory(create = false, scope = storageContext()) {
    scope.assertLive(); const dataAccessRoot = scope.root;
    try {
      if (create && scope.profile) {
        const parent = path.join(applicationRoot, ".data-access");
        try { await mkdir(parent, { mode: 0o700 }); } catch (error) { if (error.code !== "EEXIST") throw error; }
        const info = await lstat(parent);
        if (!info.isDirectory() || info.isSymbolicLink() || await realpath(parent) !== path.join(await realpath(applicationRoot), ".data-access")) throw dataUnknown();
      }
      if (create) await mkdir(dataAccessRoot, { mode: 0o700 });
    } catch (error) { if (error.code !== "EEXIST") throw dataUnknown(); }
    try {
      const info = await lstat(dataAccessRoot);
      if (!info.isDirectory() || info.isSymbolicLink() ||
          await realpath(dataAccessRoot) !== path.join(await realpath(applicationRoot), ".data-access", ...(scope.profile ? [scope.profile] : []))) throw dataUnknown();
      scope.assertLive();
      return dataAccessRoot;
    } catch (error) { if (error.code === "ENOENT" && !create) return null; throw dataUnknown(); }
  }
  const sameFile = (a,b) => a.dev===b.dev && a.ino===b.ino && a.size===b.size && a.mtimeMs===b.mtimeMs && a.ctimeMs===b.ctimeMs && a.nlink===b.nlink;
  async function readDataAccess(id, scope = storageContext()) {
    if (!await dataAccessDirectory(false, scope)) return null;
    const filename = path.join(scope.root, `${id}.json`);
    let info;
    try { info = await lstat(filename); }
    catch (error) { if (error.code === "ENOENT") return null; throw dataUnknown(); }
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 4096) throw dataUnknown();
    let handle;
    try {
      // lstat and fstat use different Windows volume metadata. Preserve the
      // no-link snapshot, and verify full volume/file identity through read-only file handles.
      const snapshot = await fileIdentity(filename);
      handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
      const opened = await handle.stat();
      if (!opened.isFile() || !sameFile(snapshot, opened) || opened.ino !== info.ino || opened.size !== info.size || opened.size > 4096) throw dataUnknown();
      const value = JSON.parse(await handle.readFile("utf8"));
      if (!sameFile(snapshot, await handle.stat()) || !sameFile(snapshot, await fileIdentity(filename)) || !sameFile(info, await lstat(filename))) throw dataUnknown();
      const validWriter = writer => writer && Object.keys(writer).sort().join() === "artifactId,descriptorDigest" &&
        typeof writer.artifactId === "string" && /^[a-f0-9-]{36}$/.test(writer.artifactId) &&
        typeof writer.descriptorDigest === "string" && /^[a-f0-9]{64}$/.test(writer.descriptorDigest);
      const versioned = value?.schemaVersion === 2;
      if (![1, 2].includes(value?.schemaVersion) || value.applicationId !== id ||
          Object.keys(value).sort().join() !== (versioned ? "applicationId,dataSchemaVersion,schemaVersion,stampPending,writer" : "applicationId,schemaVersion,writer") ||
          !validWriter(value.writer) || versioned && !semver.valid(value.dataSchemaVersion)) throw dataUnknown();
      // Recovery may atomically replace this Host record. Release its reader
      // first so Windows can replace the destination without a sharing conflict.
      await handle.close();
      handle = null;
      if (versioned && value.stampPending !== null) {
        const pending = value.stampPending;
        if (!pending || Object.keys(pending).sort().join() !== "location,previous" ||
            !["primary", "legacy"].includes(pending.location) || scope.profile && pending.location !== "primary" ||
            pending.previous !== null && (!pending.previous || Object.keys(pending.previous).sort().join() !== "dataSchemaVersion,writer" ||
              !validWriter(pending.previous.writer) || !semver.valid(pending.previous.dataSchemaVersion))) throw dataUnknown();
        await finishSchemaCommit(id, value, scope);
      }
      if (!await dataAccessDirectory(false, scope)) throw dataUnknown();
      const writer = { ...value.writer };
      if (versioned) Object.defineProperty(writer, "dataSchemaVersion", { value: value.dataSchemaVersion });
      return writer;
    } catch { throw dataUnknown(); }
    finally { await handle?.close(); }
  }
  const writerFor = descriptor => descriptor?.schemaVersion >= 2 ? {
    artifactId: descriptor.artifactId,
    descriptorDigest: createHash("sha256").update(JSON.stringify(descriptor)).digest("hex"),
  } : null;
  const sameWriter = (left, right) => Boolean(left && right && left.artifactId === right.artifactId && left.descriptorDigest === right.descriptorDigest);
  const profileDirectories = (id, scope) => scope.profile ? [applicationProfilePath(applicationRoot, id, scope.profile)]
    : [path.join(applicationRoot, ".runtime", id), path.join(applicationRoot, "..", "application-data", id)];
  async function activeProfile(id, manifest, scope) {
    const directories = profileDirectories(id, scope);
    if (directories.length === 1 || manifest.launchMode === "bundled") return { directory: directories[0], location: "primary" };
    try { await lstat(directories[0]); return { directory: directories[0], location: "primary" }; }
    catch (error) { if (error.code !== "ENOENT") throw dataUnknown(); }
    try { await lstat(directories[1]); return { directory: directories[1], location: "legacy" }; }
    catch (error) { if (error.code !== "ENOENT") throw dataUnknown(); }
    return { directory: directories[0], location: "primary" };
  }
  async function writeDataAccessValue(id, value, scope) {
    const dataAccessRoot = scope.root;
    await dataAccessDirectory(true, scope);
    const temporary = path.join(dataAccessRoot, `.${id}-${randomUUID()}.tmp`);
    try {
      const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); } finally { await handle.close(); }
      await dataAccessDirectory(false, scope);
      await rename(temporary, path.join(dataAccessRoot, `${id}.json`));
      if (process.platform !== "win32") {
        const directory = await open(dataAccessRoot, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        try { await directory.sync(); } finally { await directory.close(); }
      }
    } catch { throw dataUnknown(); }
    finally { await rm(temporary, { force: true }); }
  }
  async function finishSchemaCommit(id, value, scope) {
    const directory = profileDirectories(id, scope)[value.stampPending.location === "legacy" ? 1 : 0];
    const input = { applicationRoot, directory, applicationId: id, assertLive: scope.assertLive };
    let accepted = false;
    try { accepted = await readDataSchema({ ...input, writer: value.writer }) === value.dataSchemaVersion; } catch { /* Check the exact pre-commit marker next. */ }
    if (!accepted) {
      const previous = value.stampPending.previous;
      const actual = await readDataSchema({ ...input, writer: previous?.writer });
      if (actual !== (previous?.dataSchemaVersion ?? null)) throw dataUnknown();
    }
    await writeDataSchema({ ...input, writer: value.writer, dataSchemaVersion: value.dataSchemaVersion });
    await writeDataAccessValue(id, { ...value, stampPending: null }, scope);
  }
  async function commitDataSchema(id, writer, dataSchemaVersion, active, previous, scope) {
    // One atomic Host record is the authority; a pending marker projection can
    // be completed after a crash without blessing an arbitrary changed marker.
    const value = { schemaVersion: 2, applicationId: id, writer: { artifactId: writer.artifactId, descriptorDigest: writer.descriptorDigest },
      dataSchemaVersion, stampPending: { location: active.location, previous } };
    await writeDataAccessValue(id, value, scope);
    await finishSchemaCommit(id, value, scope);
  }
  const compatibilityContext = async (input, access) => {
    const id = input.manifest.applicationId, scope = storageContext();
    const writer = access === undefined ? await readDataAccess(id, scope) : access;
    let localDataPresent = Boolean(writer);
    const directories = profileDirectories(id, scope);
    const active = await activeProfile(id, input.manifest, scope);
    for (const directory of directories) {
      try { localDataPresent ||= (await readdir(directory)).length > 0; }
      catch (error) {
        if (error.code !== "ENOENT") throw dataUnknown();
      }
    }
    // Host markers bind the schema to the last verified writer in this profile.
    const stamped = await readDataSchema({ applicationRoot, directory: active.directory, applicationId: id, writer, assertLive: scope.assertLive });
    if (stamped && writer?.dataSchemaVersion && stamped !== writer.dataSchemaVersion) throw dataUnknown();
    // Inspect audited layouts too: a marker cannot hide damaged/unsafe data.
    // Their historical layout versions only supply evidence when no Host marker exists.
    const dataInput = { manifest: input.descriptor?.manifest, profileDirectories: directories };
    const local = await inspectZhijunData(dataInput) ?? await inspectAiBrowserData(dataInput) ?? await inspectCentaurloopData(dataInput);
    if (local?.status === "unknown") throw dataUnknown();
    if (local) localDataPresent = local.localDataPresent;
    // Never infer the actual schema from writeVersion. Refresh authenticated
    // provider evidence after all disk reads and reject conflicting evidence.
    const supplied = await getCompatibilityContext?.(input) || {};
    scope.assertLive();
    const required = input.manifest.compatibility.localDataSchema.readRange;
    for (const version of [stamped, writer?.dataSchemaVersion, stamped || writer?.dataSchemaVersion ? null : local?.localDataSchemaVersion, supplied.localDataSchemaVersion])
      if (version != null && semver.valid(version) && !semver.satisfies(version, required))
        throw Object.assign(new Error("APPLICATION_DATA_SCHEMA_INCOMPATIBLE"), { code: "APPLICATION_DATA_SCHEMA_INCOMPATIBLE" });
    let localDataSchemaVersion = stamped || writer?.dataSchemaVersion || local?.localDataSchemaVersion;
    if (localDataSchemaVersion && supplied.localDataSchemaVersion != null &&
        localDataSchemaVersion !== supplied.localDataSchemaVersion) throw dataUnknown();
    localDataSchemaVersion ||= supplied.localDataSchemaVersion;
    // Only the exact signed artifact that already accessed this data may heal
    // a missing marker. A new candidate's writeVersion is never old-data proof.
    if (localDataSchemaVersion == null && input.phase !== "rollback" &&
        sameWriter(writer, writerFor(input.descriptor)))
      localDataSchemaVersion = input.descriptor.manifest.compatibility.localDataSchema.writeVersion;
    return { ...supplied,
      ...(localDataSchemaVersion != null ? { localDataSchemaVersion } : {}),
      localDataPresent: localDataPresent || supplied.localDataPresent === true };
  };
  const installer = createApplicationInstaller({
    rootDir: applicationRoot, trustedKeys, getCompatibilityContext: compatibilityContext, prepareApplication, authorizeRelease,
    hasTrustedDataContinuity: async descriptor => sameWriter(await readDataAccess(descriptor.applicationId), writerFor(descriptor)),
  });
  await installer.recover();
  const mutations = new Map();
  const dismissedDefaults = new Set();
  function assertOpen() {
    if (closed) throw Object.assign(new Error("APPLICATIONS_CLOSED"), { code: "APPLICATIONS_CLOSED" });
    if (maintenance) throw Object.assign(new Error("UPDATE_IN_PROGRESS"), { code: "UPDATE_IN_PROGRESS" });
  }
  async function track(operation) {
    installing.add(operation);
    try { return await operation; } finally { installing.delete(operation); }
  }
  function mutate(id, operation, assertSession = () => {}) {
    assertOpen();
    if (mutations.has(id)) return Promise.reject(Object.assign(new Error("MARKET_OPERATION_BUSY"), { code: "MARKET_OPERATION_BUSY" }));
    const check = () => { controller.signal.throwIfAborted(); assertSession(); };
    const pending = Promise.resolve().then(async () => {
      check();
      if (operation === installer.uninstall) dismissedDefaults.add(id);
      if (operation === installer.rollback) await installer.assertRollbackCompatible(id);
      check();
      await launcher.stop(id);
      check();
      // Preserve explicit removal even if the process exits during uninstall.
      // Default delivery must not reinstall an application the user removed.
      if (operation === installer.uninstall) await defaultApplicationDeliveryStore.dismiss(id, check);
      check();
      return operation(id, check);
    }).finally(() => mutations.delete(id));
    mutations.set(id, pending);
    return track(pending);
  }
  const installing = new Set(), controller = new AbortController();
  let closed = false, closing, maintenance = false;
  const launcher = createApplicationLauncher({
    assertClientUsable,
    resolveRecord: async input => {
      const id=typeof input === "string" ? input : input.applicationId;
      const target=typeof input === "object" ? input.launchContext : undefined;
      if(target && (id!=="centaurai.wanx.semantica" || !validStarlinkTarget(target)))
        throw Object.assign(Error("TEAM_DATA_TARGET_INVALID"),{code:"TEAM_DATA_TARGET_INVALID"});
      const launchScope = storageContext();
      let record = await installer.resolveCurrent(id);
      launchScope.assertLive();
      if (record.protocolVersion < 2) return {...record, launchContext:target};
      // Derive identity from the envelope again, not the mutable descriptor
      // copy in the local install record.
      const descriptor = record.envelope ? verifyEnvelope(record.envelope, trustedKeys) : undefined;
      const controlled = record.releaseAccess === "account";
      if (controlled) {
        if (!descriptor || !authorizeRelease) throw Object.assign(new Error("MARKET_RELEASE_ACCESS_REQUIRED"), { code: "MARKET_RELEASE_ACCESS_REQUIRED" });
        const permit = await authorizeRelease(descriptor);
        if (!permit) throw Object.assign(new Error("MARKET_RELEASE_ACCESS_REQUIRED"), { code: "MARKET_RELEASE_ACCESS_REQUIRED" });
        permit.assertLive();
      }
      const writer = writerFor(descriptor), previousWriter = await readDataAccess(id);
      if (record.protocolVersion === 3) {
        // Reject incompatible local data/Host requirements before preparing
        // remote resources. Launch repeats these checks after preparation.
        await assertApplicationCompatibility(record, {
          getCompatibilityContext: input => compatibilityContext(input, previousWriter), descriptor, phase: "import",
          trustedDataContinuity: sameWriter(previousWriter, writer),
        });
        // A binding is scoped to an account, device and ownership epoch. Keep
        // the legacy launch path for pre-candidate installs; new selections
        // revalidate/rebind the same signed artifact before opening on a box.
        if (record.bindingSetId) {
          const prepared = await installer.prepareCurrent(id, { signal: controller.signal });
          if (prepared.artifactId !== record.artifactId) throw Object.assign(new Error("UPDATE_SESSION_CHANGED"), { code: "UPDATE_SESSION_CHANGED" });
          if (prepared.resourcePreparation?.status !== "ready") {
            const code = prepared.resourcePreparation?.code || "APPLICATION_RESOURCES_NOT_READY";
            throw Object.assign(new Error(code), { code });
          }
          record = prepared;
        }
      }
      let preparedConnection, launchDataSchemaVersion;
      await assertApplicationCompatibility(record, {
        getCompatibilityContext: async input => {
          const supplied = await compatibilityContext(input, previousWriter);
          launchDataSchemaVersion = supplied.localDataSchemaVersion;
          if (record.protocolVersion === 3) preparedConnection = supplied.applicationConnection;
          return supplied;
        }, descriptor, phase: "launch",
        trustedDataContinuity: sameWriter(previousWriter, writer),
      });
      // Commit before any child can access the profile. If startup is canceled,
      // retain this possible-writer evidence rather than assuming nothing wrote.
      launchScope.assertLive();
      if (writer) {
        const active = await activeProfile(id, record, launchScope);
        const stamped = await readDataSchema({ applicationRoot, directory: active.directory, applicationId: id, writer: previousWriter, assertLive: launchScope.assertLive });
        if (stamped && !semver.satisfies(stamped, record.compatibility.localDataSchema.readRange))
          throw Object.assign(new Error("APPLICATION_DATA_SCHEMA_INCOMPATIBLE"), { code: "APPLICATION_DATA_SCHEMA_INCOMPATIBLE" });
        const knownSchema = stamped || previousWriter?.dataSchemaVersion || launchDataSchemaVersion;
        const writeSchema = record.compatibility.localDataSchema.writeVersion;
        // Opening with a lower-writing package is not evidence of a completed
        // data downgrade. Retain the highest known possible writer schema.
        const committedSchema = semver.valid(knownSchema) && semver.gt(knownSchema, writeSchema) ? knownSchema : writeSchema;
        await commitDataSchema(id, writer, committedSchema,
          active, stamped ? { writer: { artifactId: previousWriter.artifactId, descriptorDigest: previousWriter.descriptorDigest }, dataSchemaVersion: stamped } : null, launchScope);
      }
      launchScope.assertLive();
      if (record.protocolVersion === 3 && !preparedConnection) throw Object.assign(new Error("APPLICATION_RESOURCES_NOT_READY"), { code: "APPLICATION_RESOURCES_NOT_READY" });
      return { ...record, launchContext:target, ...(preparedConnection ? { preparedConnection } : {}),
        ...(controlled ? { authorizeRelease: options => authorizeRelease(descriptor, options) } : {}) };
    },
    // Builtin Starlink upgrades must retain local versions after launch too.
    // Signed releases keep the installer's existing rollback/retention policy.
    onStarted: record => record.applicationId === "centaurai.wanx.semantica" && !record.envelope
      ? undefined : installer.prune(record.applicationId, record.version),
    host: {
      createSession(record, { signal }) {
        const bindPersonalTarget=connection=>record.launchContext?{...connection,context:()=>({...connection.context(),dataScope:"personal",starlinkTarget:record.launchContext})}:connection;
        return createApplicationSession({
          hostApplicationId: applicationId,
          applicationId: record.applicationId,
          installPath: record.installPath,
          capabilities: record.capabilities,
          backendContracts: record.compatibility?.backendContracts || [],
          openWorkshop,
          createConnection: async options => {
            if (record.preparedConnection?.kind === "local-trust-v1") {
              if (!record.preparedConnection.deriveApplication) throw Object.assign(new Error("APPLICATION_DATA_CONTEXT_REQUIRED"), { code: "APPLICATION_DATA_CONTEXT_REQUIRED" });
              return bindPersonalTarget(await record.preparedConnection.deriveApplication(options));
            }
            return bindPersonalTarget(record.preparedConnection || await createConnection?.(record.applicationId, {
              launchId: options.launchId, ...(options.capabilities ? { capabilities: options.capabilities } : {}),
              ...(options.backendContracts?.length ? { backendContracts: options.backendContracts } : {}),
            }) || { context, request, openStream: stream });
          },
          authorizeRelease: record.authorizeRelease,
          signal,
        });
      },
    },
    spawn,
    electronPath,
    resolveExecutable: record => applicationExecutable({record,applicationRoot,electronPath}),
    runtimeArgs,
    launcherArgs,
  });
  return Object.freeze({
    async install(input) {
      assertOpen();
      if (mutations.size) throw Object.assign(new Error("MARKET_OPERATION_BUSY"), { code: "MARKET_OPERATION_BUSY" });
      return track(installer.install(input, { signal: controller.signal }));
    },
    async installDeployment(input, {signal}={}) {
      assertOpen();
      const combined=signal?AbortSignal.any([controller.signal,signal]):controller.signal;
      return track(installer.installDeployment(input,{signal:combined}));
    },
    async installVerifiedPackage(input) {
      assertOpen();
      const descriptor = verifyEnvelope(input.envelope, trustedKeys);
      if (mutations.has(descriptor.applicationId)) throw Object.assign(new Error("MARKET_OPERATION_BUSY"), { code: "MARKET_OPERATION_BUSY" });
      if (input.onlyIfMissing) {
        const id = descriptor.applicationId, originalCheck = input.assertSession;
        if (await defaultApplicationDeliveryStore.isDismissed(id)) dismissedDefaults.add(id);
        const assertSession = () => {
          assertOpen();
          originalCheck?.();
          if (dismissedDefaults.has(id)) throw Object.assign(new Error("DEFAULT_APPLICATION_USER_REMOVED"), { code: "DEFAULT_APPLICATION_USER_REMOVED" });
          if (mutations.has(id)) throw Object.assign(new Error("MARKET_OPERATION_BUSY"), { code: "MARKET_OPERATION_BUSY" });
        };
        assertSession();
        input = { ...input, assertSession };
      }
      // Preparing an update never interrupts the running version; launch owns switching.
      return track(installer.installVerifiedPackage(input, { signal: controller.signal }));
    },
    uninstall: (id, check) => mutate(id, installer.uninstall, check),
    rollback: (id, check) => mutate(id, installer.rollback, check),
    async selectCurrent(id, version) {
      assertOpen();
      return track(installer.selectCurrent(id, version, { signal: controller.signal }));
    },
    listInstalled: installer.list,
    defaultApplicationDeliveryStore,
    async prepareInstalledApplication(id, assertSession = () => {}) {
      assertOpen();
      return track((async () => {
        const check = () => { controller.signal.throwIfAborted(); assertSession(); };
        check();
        const current = await installer.resolveCurrent(id);
        check();
        const descriptor = current.envelope ? verifyEnvelope(current.envelope, trustedKeys) : undefined;
        const continuity = sameWriter(await readDataAccess(id), writerFor(descriptor));
        check();
        let permit;
        // Resource-free account releases still require current authorization.
        // prepareCurrent can return early when there are no resource bindings.
        if (current.releaseAccess === "account") {
          if (!descriptor || !authorizeRelease) throw Object.assign(new Error("MARKET_RELEASE_ACCESS_REQUIRED"), { code: "MARKET_RELEASE_ACCESS_REQUIRED" });
          permit = await authorizeRelease(descriptor, { signal: controller.signal });
          check();
          if (!permit) throw Object.assign(new Error("MARKET_RELEASE_ACCESS_REQUIRED"), { code: "MARKET_RELEASE_ACCESS_REQUIRED" });
          permit.assertLive();
        }
        await assertApplicationCompatibility(current, { getCompatibilityContext: compatibilityContext, descriptor,
          phase: "import", trustedDataContinuity: continuity });
        check();
        const result = await installer.prepareCurrent(id, { assertSession, signal: controller.signal });
        check();
        if (!result.resourcePreparation || result.resourcePreparation.status === "ready") {
          await assertApplicationCompatibility(result, { getCompatibilityContext: compatibilityContext, descriptor,
            phase: "launch", trustedDataContinuity: continuity });
        }
        check();
        permit?.assertLive();
        return result;
      })());
    },
    async launch(input) {
      const id=typeof input === "string" ? input : input.applicationId;
      assertOpen();
      assertClientUsable();
      if (mutations.has(id)) return Promise.reject(Object.assign(new Error("MARKET_OPERATION_BUSY"), { code: "MARKET_OPERATION_BUSY" }));
      return track(launcher.launch(input));
    },
    isBusy: () => maintenance || installing.size > 0 || mutations.size > 0,
    beginMaintenance() {
      assertOpen();
      if (installing.size || mutations.size) throw Object.assign(new Error("UPDATE_IN_PROGRESS"), { code: "UPDATE_IN_PROGRESS" });
      maintenance = true;
      let released = false;
      return () => { if (!released) { released = true; maintenance = false; } };
    },
    activate: launcher.activate,
    stop: launcher.stop,
    close() {
      closed = true;
      controller.abort();
      return closing ||= (async () => {
        const results = await Promise.allSettled([launcher.close(), ...installing]);
        if (results[0].status === "rejected") throw results[0].reason;
      })().catch(error => { closing = null; throw error; });
    },
    installRoot: path.resolve(applicationRoot),
  });
}
