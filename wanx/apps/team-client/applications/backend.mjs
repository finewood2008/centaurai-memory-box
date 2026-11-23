import { evaluateApplicationCompatibility, validateCompatibility } from "./compatibility.mjs";
import { localBindingScope } from './local-binding-scope.mjs';

const fail = code => Object.assign(new Error(code), { code });
const safeCode = value => typeof value === "string" && /^[A-Z][A-Z0-9_]{1,80}$/.test(value);

function preparationResponse(response) {
  let value;
  try { value = JSON.parse(response.body.toString("utf8")); }
  catch { if (response.status >= 200 && response.status < 300) throw fail("APPLICATION_PREPARATION_INVALID"); }
  if (response.status < 200 || response.status >= 300) {
    // An HTTP authentication failure is not evidence of a missing app grant.
    const code = ["AUTH_FAILED", "FORBIDDEN"].includes(value?.code) ? "APP_AUTHORIZATION_UNVERIFIED"
      : safeCode(value?.code) ? value.code : [401, 403].includes(response.status) ? "APP_AUTHORIZATION_UNVERIFIED"
      : response.status === 404 ? "BACKEND_CONTRACT_INCOMPATIBLE" : "APPLICATION_PREPARATION_UNAVAILABLE";
    throw fail(code);
  }
  return value;
}

// Only the main-owned installer/manager passes this separately from public
// package metadata. Public manifests cannot opt into managed readiness.
function standardManagedRecord({manifest,descriptor,managedDeployment:record}) {
  if (record === undefined) return null;
  const binding=record?.deployment, standard=record?.standardDeployment;
  const hex=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
  const positive=value=>Number.isSafeInteger(value)&&value>0;
  const features=value=>Array.isArray(value)&&value.length===3&&['context','expert','data'].every(item=>value.includes(item));
  const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')===[...keys].sort().join(',');
  const runtime=standard?.runtimeContract;
  const runtimeValid=exact(runtime,['id','version','collections'])&&runtime.id==='wanx.expert-app.v1'&&runtime.version==='1.0.0'&&exact(runtime.collections,['state'])&&exact(runtime.collections.state,['json'])&&runtime.collections.state.json==='string';
  const compatibility=validateCompatibility(manifest?.compatibility,3);
  const contract=compatibility.backendContracts;
  if (!record||manifest.protocolVersion!==3||record.protocolVersion!==3||
      !binding||binding.schemaVersion!==1||binding.profile!=='wanx-expert-app-v1'||
      !/^ai\.wanx\.selfmade\.[a-f0-9]{32}$/.test(binding.slotApplicationId)||
      typeof binding.baseApplicationId!=='string'||!/^[a-z][a-z0-9._-]{1,63}$/.test(binding.baseApplicationId)||
      binding.baseApplicationId===binding.slotApplicationId||
      record.applicationId!==binding.slotApplicationId||manifest.applicationId!==binding.slotApplicationId||record.packageApplicationId!==binding.baseApplicationId||
      !['dev','prod'].includes(binding.environment)||typeof binding.boxId!=='string'||!binding.boxId||
      !positive(binding.generation)||!positive(binding.fence)||!/^[a-f0-9]{32}$/.test(binding.operationId)||
      !hex(binding.artifactHash)||!hex(binding.scopeId)||!/^[a-f0-9]{32}$/.test(binding.ticketId)||!/^sha256:[a-f0-9]{64}$/.test(binding.payloadDigest)||
      standard?.schemaVersion!==1||standard.format!=='wanx-standard-expert-client-v1'||standard.runtimeNamespace!=='studio'||!hex(standard.packageSha256)||
      !runtimeValid||
      descriptor?.schemaVersion!==3||descriptor.applicationId!==binding.baseApplicationId||descriptor.manifest?.applicationId!==binding.baseApplicationId||
      descriptor.version!==record.version||descriptor.artifactId!==record.artifactId||descriptor.sha256!==standard.packageSha256||
      compatibility.backendProductId!=='wanx'||compatibility.resourceDependencies.length!==0||contract.length!==1||
      contract[0].id!=='wanx.expert-app.v1'||contract[0].range!=='>=1.0.0 <2.0.0'||!features(contract[0].features)||
      JSON.stringify(validateCompatibility(descriptor.manifest.compatibility,3))!==JSON.stringify(compatibility)) throw fail('APPLICATION_DEPLOYMENT_INVALID');
  return record;
}

/** No credentials or readiness evidence survive the authenticated box connection. */
export function createApplicationBackend({ client, account, clientVersion }) {
  function identityKey(current) {
    if (current.protocolVersion === 2 && current.authorization === 'local-trust-v1') {
      const identity = current.dataIdentity, selected = identity?.selected || identity;
      if (!identity || ['profileId', 'clientId'].some(key => typeof identity[key] !== 'string') ||
          ['boxId', 'boxKeyThumbprint', 'principalId', 'bindingId', 'sessionId'].some(key => typeof selected?.[key] !== 'string') ||
          !Number.isSafeInteger(selected.ownershipEpoch) || !Number.isSafeInteger(identity.generation)) throw fail('UPDATE_SESSION_CHANGED');
      return JSON.stringify(['local-trust-v1', identity.profileId, identity.clientId, identity.generation,
        selected.boxId, selected.boxKeyThumbprint, selected.ownershipEpoch, selected.principalId, selected.bindingId, selected.sessionId]);
    }
    return JSON.stringify([current.accountId, current.clientId, current.boxId]);
  }
  function assertIdentity(captured, connection) {
    const current = connection.context();
    if (identityKey(current) !== captured ||
        (current.authorization !== 'local-trust-v1' && account.getIdentity()?.accountId !== current.accountId) || current.connection !== "ready") throw fail("UPDATE_SESSION_CHANGED");
    return current;
  }
  async function fixedConnection(applicationId, compatibility, forceApplication = false) {
    if (client.snapshot().phase !== "ready") throw fail("NETWORK_NOT_READY");
    const local = !forceApplication && client.snapshot().connection?.authorization === 'local-trust-v1';
    // Resource preparation is a fixed main-owned host operation. Launch derives
    // an independent app session only after real native readiness succeeds.
    const connection = await client.applicationConnection(local ? undefined : applicationId,
      local ? undefined : { backendProductId: compatibility.backendProductId });
    const current = connection.context();
    const captured = identityKey(current);
    const check = () => assertIdentity(captured, connection);
    check();
    async function post(path, body) {
      check();
      const response = await connection.request({ path, method: "POST", headers: { "content-type": "application/json" }, body: Buffer.from(JSON.stringify(body)) });
      check();
      return preparationResponse(response);
    }
    return { connection, current, check, post };
  }
  function validateBinding(result, input, fixed) {
    const scope = result?.bindingScope, expected = input.manifest.bindingScope || input.bindingScope;
    const local = fixed.current.authorization === 'local-trust-v1';
    if (local) {
      const identity = fixed.current.dataIdentity, selected = identity.selected || identity;
      localBindingScope(scope, { deviceId: selected.boxId, boxKeyThumbprint: selected.boxKeyThumbprint,
        principalId: selected.principalId, ownershipEpoch: selected.ownershipEpoch, artifactId: input.descriptor.artifactId });
      if (expected && JSON.stringify(localBindingScope(expected)) !== JSON.stringify(localBindingScope(scope))) throw fail('APPLICATION_PREPARATION_INVALID');
    }
    if (!/^[a-f0-9]{64}$/.test(result?.bindingSetId || "") ||
        typeof result.operationId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(result.operationId) ||
        input.operationId && input.operationId !== result.operationId ||
        (input.bindingSetId || input.manifest.bindingSetId) && (input.bindingSetId || input.manifest.bindingSetId) !== result.bindingSetId ||
        !scope || (!local && scope.accountId !== fixed.current.accountId) || scope.deviceId !== fixed.current.boxId ||
        scope.artifactId !== input.descriptor.artifactId || !Number.isSafeInteger(scope.ownershipEpoch) || scope.ownershipEpoch < 1 ||
        !local && expected && ["accountId", "deviceId", "ownershipEpoch", "artifactId"].some(key => expected[key] !== scope[key]))
      throw fail("APPLICATION_PREPARATION_INVALID");
    return { bindingSetId: result.bindingSetId, operationId: result.operationId, bindingScope: structuredClone(scope) };
  }
  async function prepare(input, fixed, candidate = false) {
    const { manifest, descriptor } = input;
    if (manifest.protocolVersion !== 3) return null;
    validateCompatibility(manifest.compatibility, 3);
    if (!descriptor?.artifactId || descriptor.schemaVersion !== 3) throw fail("APPLICATION_RESOURCE_ARTIFACT_REQUIRED");
    if (candidate && (typeof input.operationId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(input.operationId)))
      throw fail("APPLICATION_PREPARATION_INVALID");
    const result = await fixed.post(candidate ? "/api/platform/applications/candidates/prepare" : "/api/platform/applications/prepare", {
      schemaVersion: candidate ? 2 : 1, applicationId: manifest.applicationId, artifactId: descriptor.artifactId,
      ...(candidate ? { operationId: input.operationId } : {}),
    });
    const observedAt = Date.parse(result?.observedAt), now = Date.now();
    if (result?.schemaVersion !== (candidate ? 2 : 1) || !["ready", "blocked"].includes(result.status) ||
        result.applicationId !== manifest.applicationId || result.artifactId !== descriptor.artifactId ||
        result.deviceId !== fixed.current.boxId || result.backendProductId !== manifest.compatibility.backendProductId || !Number.isFinite(observedAt) || observedAt < now - 300000 || observedAt > now + 60000 ||
        !Array.isArray(result.resources) || result.resources.length > 256 || !Array.isArray(result.bindings) || result.bindings.length > 256)
      throw fail("APPLICATION_PREPARATION_INVALID");
    if (result.status === "blocked" || result.authorization?.status !== "ready")
      return { ...result, status: "blocked", code: result.authorization?.status !== "ready"
        ? safeCode(result.authorization?.code) ? result.authorization.code : "APP_AUTHORIZATION_UNVERIFIED"
        : safeCode(result.code) ? result.code : "APPLICATION_RESOURCES_NOT_READY" };
    if (candidate) validateBinding(result, input, fixed);
    // A successful download alone is not readiness: every dependency needs its
    // verified installed version and the actual Octop instance/package binding.
    const evidence = evaluateApplicationCompatibility({ ...manifest, compatibility: { ...manifest.compatibility, backendContracts: [] } }, {
      clientVersion, hostProtocol: 1, expectedDeviceId: fixed.current.boxId,
      backend: { ...result, schemaVersion: 1, productId: manifest.compatibility.backendProductId },
    });
    if (evidence.status !== "ready") throw fail(evidence.checks[0]?.code || "APPLICATION_PREPARATION_INVALID");
    return result;
  }
  async function candidateReadiness(input, fixed, binding) {
    const { manifest, descriptor } = input;
    const backend = await fixed.post("/api/platform/applications/readiness", {
      schemaVersion: 2, applicationId: manifest.applicationId, artifactId: descriptor.artifactId,
      compatibility: manifest.compatibility, bindingSetId: binding.bindingSetId,
    });
    if (backend?.schemaVersion !== 2 || backend.applicationId !== manifest.applicationId || backend.artifactId !== descriptor.artifactId)
      throw fail("APPLICATION_PREPARATION_INVALID");
    validateBinding(backend, { ...input, ...binding }, fixed);
    const context = { ...backend, schemaVersion: 1 };
    const evidence = evaluateApplicationCompatibility(manifest, {
      clientVersion, hostProtocol: 1, expectedDeviceId: fixed.current.boxId, backend: context,
    });
    if (evidence.status !== "ready") throw fail(evidence.checks[0]?.code || "APPLICATION_PREPARATION_INVALID");
    if (backend.status !== "ready" || Array.isArray(backend.checks) && backend.checks.length)
      throw fail(safeCode(backend.checks?.[0]?.code) ? backend.checks[0].code : "APPLICATION_RESOURCES_NOT_READY");
    return context;
  }
  async function prepareApplication(input) {
    if (input.manifest.protocolVersion !== 3) return null;
    validateCompatibility(input.manifest.compatibility, 3);
    if (!input.manifest.compatibility.resourceDependencies.length) return { status: "ready" };
    if (client.snapshot().phase !== "ready") return { status: "pending", code: "APPLICATION_RESOURCES_PENDING" };
    const fixed = await fixedConnection(input.manifest.applicationId, input.manifest.compatibility);
    const result = await prepare(input, fixed, true);
    if (result.status === "ready") await candidateReadiness(input, fixed, validateBinding(result, input, fixed));
    fixed.check();
    if (result.status !== "ready") return { status: "blocked", ...(result.code ? { code: result.code } : {}) };
    // Keep the authenticated connection guard until the installer atomically
    // publishes its pointer. Preparing successfully is not a durable grant.
    return { status: "ready", ...validateBinding(result, input, fixed), assertCurrent: fixed.check };
  }
  async function managedReadiness(record, compatibility, result) {
    const local=client.snapshot().connection?.authorization==='local-trust-v1';
    const fixed=await fixedConnection(local?record.applicationId:'wanx',compatibility,true);
    const principal=fixed.current.user?.id;
    let launchToken=null,expiresAt=Infinity;
    const check=()=>{
      const current=fixed.check(),state=client.snapshot();
      if(local!==(current.authorization==='local-trust-v1')||!local&&(!Number.isSafeInteger(principal)||principal<1||current.user?.id!==principal)||
          current.boxId!==record.deployment.boxId||state.phase!=='ready'||state.connection?.deviceId!==record.deployment.boxId||
          local&&current.applicationId!==undefined&&current.applicationId!==record.applicationId)throw fail('UPDATE_SESSION_CHANGED');
      if(Date.now()/1000>=expiresAt)throw fail('RUNTIME_SESSION_EXPIRED');
      return current;
    };
    check();
    if(!local){
      const opened=await fixed.post('/api/app-studio/deployment/apps/'+record.applicationId+'/runtime',{
        artifactHash:record.deployment.artifactHash,environment:record.deployment.environment,generation:record.deployment.generation,
      });
      check();
      if(!opened||Object.keys(opened).sort().join(',')!=='expiresAt,launchToken,schemaVersion,transport'||opened.schemaVersion!==1||
          opened.transport!=='wanx-expert-app-v1'||typeof opened.launchToken!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(opened.launchToken)||
          !Number.isFinite(opened.expiresAt)||opened.expiresAt<=Date.now()/1000||opened.expiresAt>Date.now()/1000+3660)throw fail('APPLICATION_PREPARATION_INVALID');
      launchToken=opened.launchToken;expiresAt=opened.expiresAt;
    }
    const response=await fixed.connection.request({path:'/api/wanx-expert-app/v1/context',method:'GET',headers:launchToken?{'x-wanx-expert-launch':launchToken}:{}});
    check();
    const actual=preparationResponse(response),binding=record.deployment,standard=record.standardDeployment;
    const backend=actual?.backend,contract=actual?.contract;
    if(actual?.schemaVersion!==1||actual.applicationId!==binding.baseApplicationId||actual.baseApplicationId!==binding.baseApplicationId||
        actual.slotApplicationId!==binding.slotApplicationId||actual.boxId!==binding.boxId||actual.environment!==binding.environment||
        actual.generation!==binding.generation||actual.operationId!==binding.operationId||actual.artifactHash!==binding.artifactHash||
        actual.packageSha256!==standard.packageSha256||actual.scopeId!==binding.scopeId||actual.runtimeNamespace!=='studio'||
        contract?.id!=='wanx.expert-app.v1'||contract.version!=='1.0.0'||!Array.isArray(contract.features)||contract.features.length!==3||!['context','expert','data'].every(feature=>contract.features.includes(feature))||
        backend?.schemaVersion!==1||backend.productId!=='wanx'||backend.deviceId!==binding.boxId||
        !Array.isArray(backend.resources)||backend.resources.length||!Array.isArray(backend.bindings)||backend.bindings.length)throw fail('APPLICATION_PREPARATION_INVALID');
    const evidence=evaluateApplicationCompatibility(record,{...result,backend});
    if(evidence.status!=='ready')throw fail(evidence.checks[0]?.code||'APPLICATION_PREPARATION_INVALID');
    if(backend.status==='blocked'||Array.isArray(backend.checks)&&backend.checks.length)throw fail('BACKEND_CONTRACT_INCOMPATIBLE');
    const request=async({path,method='GET',headers={},body,signal,stream}={})=>{
      check();
      const publicRoute=method==='GET'&&path==='/api/wanx-expert-app/v1/context'||method==='POST'&&path==='/api/wanx-expert-app/v1/invoke';
      if(!publicRoute&&!(method==='GET'&&path==='/api/auth/me'))throw fail('APPLICATION_ROUTE_DENIED');
      const safeHeaders=Object.fromEntries(Object.entries(headers).filter(([key])=>['accept','content-type'].includes(key.toLowerCase())));
      if(launchToken&&publicRoute)safeHeaders['x-wanx-expert-launch']=launchToken;
      const response=await fixed.connection.request({path,method,headers:safeHeaders,body,signal,stream});check();
      return {...response,headers:Object.fromEntries(Object.entries(response.headers||{}).filter(([key])=>key.toLowerCase()!=='x-wanx-expert-launch'))};
    };
    const denied=async()=>{throw fail('APPLICATION_ROUTE_DENIED')};
    const applicationConnection={...fixed.connection,request,openStream:denied,openWebSocket:denied,businessRequest:denied,
      context:()=>({...check(),applicationId:record.applicationId,artifactId:record.artifactId,resourceBindings:[]})};
    if(!local)delete applicationConnection.deriveApplication;
    return {...result,backend,assertCurrent:check,applicationConnection};
  }
  async function getCompatibilityContext({ manifest, descriptor, phase, managedDeployment, bindingSetId = manifest?.bindingSetId, bindingScope = manifest?.bindingScope }) {
    const managed=standardManagedRecord({manifest,descriptor,managedDeployment});
    const state = client.snapshot(), compatibility = manifest?.compatibility || descriptor?.manifest?.compatibility;
    const backendRequired = ["launch", "rollback"].includes(phase) || phase === "candidate" && (manifest.protocolVersion !== 3 || state.phase === "ready") && Boolean(state.connection?.deviceId);
    const result = { clientVersion, hostProtocol: 1, backendRequired, expectedDeviceId: state.connection?.deviceId || null };
    if (managed && !["launch","rollback"].includes(phase)) return {...result,backendRequired:false};
    if (!backendRequired || !compatibility) return result;
    if (managed) return managedReadiness(managed,compatibility,result);
    if (manifest.protocolVersion !== 3) {
      if (state.connection?.authorization === 'local-trust-v1') {
        const fixed = await fixedConnection(manifest.applicationId, compatibility);
        result.backend = await fixed.post('/api/platform/applications/readiness', { schemaVersion: 1, applicationId: manifest.applicationId, compatibility });
        fixed.check(); return result;
      }
      const captured = JSON.stringify({ account: account.getIdentity(), deviceId: state.connection?.deviceId });
      const response = await client.applicationRequest({ path: "/api/platform/applications/readiness", method: "POST",
        headers: { "content-type": "application/json" }, body: Buffer.from(JSON.stringify({ schemaVersion: 1, applicationId: manifest.applicationId, compatibility })) });
      if (captured !== JSON.stringify({ account: account.getIdentity(), deviceId: client.snapshot().connection?.deviceId })) throw fail("UPDATE_SESSION_CHANGED");
      result.backend = preparationResponse(response);
      return result;
    }
    const fixed = await fixedConnection(manifest.applicationId, compatibility);
    const candidate = Boolean(bindingSetId);
    const localInstall = manifest.installationSource === "local" && !manifest.envelope && !manifest.descriptor;
    const prepared = phase === "launch" && !candidate && compatibility.resourceDependencies?.length
      ? await prepare({ manifest, descriptor }, fixed) : null;
    if (prepared?.status === "blocked") throw fail(prepared.code);
    try {
      result.backend = candidate
        ? await candidateReadiness({ manifest, descriptor }, fixed, { bindingSetId, bindingScope, operationId: manifest.operationId })
        : await fixed.post("/api/platform/applications/readiness", {
          schemaVersion: 1, applicationId: manifest.applicationId, artifactId: descriptor?.artifactId, compatibility,
        });
    } catch (error) {
      // Older real Bridges attempted a publication lookup even for a signed
      // v3 contract with no resource dependencies. Preserve strict readiness
      // for every resource-bearing app, but let a resource-free app continue
      // on its already authenticated Host connection when that exact legacy
      // error is returned. The signed backend contract remains the source of
      // capability evidence; no resource binding is manufactured.
      if (localInstall || candidate || compatibility.resourceDependencies?.length || error?.code !== "RESOURCE_PUBLICATION_UNAVAILABLE") throw error;
      const observedAt = new Date().toISOString();
      result.backend = {
        schemaVersion: 1, productId: compatibility.backendProductId, deviceId: fixed.current.boxId,
        observedAt, authorization: { status: "ready" }, resources: [], bindings: [],
        contracts: compatibility.backendContracts.map(contract => ({ id: contract.id, version: contract.range.replace(/^[<>= ]+/, "").split(" ")[0], features: [...contract.features] })),
      };
    }
    if (localInstall && (result.backend?.applicationId !== manifest.applicationId || result.backend.status !== "ready" ||
        !Array.isArray(result.backend.checks) || result.backend.checks.length)) {
      const reason = result.backend?.authorization?.code || result.backend?.checks?.[0]?.code;
      throw fail(safeCode(reason) ? reason : "APPLICATION_PREPARATION_INVALID");
    }
    if (!localInstall && !candidate && !compatibility.resourceDependencies?.length &&
        result.backend?.status === "blocked" && Array.isArray(result.backend.checks) &&
        result.backend.checks.length > 0 && result.backend.checks.every(check => check?.code === "BACKEND_CONTRACT_INCOMPATIBLE")) {
      result.backend = {
        schemaVersion: 1, productId: compatibility.backendProductId, deviceId: fixed.current.boxId,
        observedAt: new Date().toISOString(), authorization: { status: "ready" }, resources: [], bindings: [],
        contracts: compatibility.backendContracts.map(contract => ({ id: contract.id, version: contract.range.replace(/^[<>= ]+/, "").split(" ")[0], features: [...contract.features] })),
      };
    }
    fixed.check();
    result.assertCurrent = fixed.check;
    // Readiness is a new observation: never overwrite a detected drift or
    // denial using an earlier successful prepare response.
    if (phase === "launch") {
      const bindings = (Array.isArray(result.backend.bindings) ? result.backend.bindings : []).filter(item => compatibility.resourceDependencies.some(dep => dep.kind === item?.kind && dep.resourceId === item.resourceId));
      result.applicationConnection = {
        ...fixed.connection,
        context: () => ({ ...fixed.check(), resourceBindings: structuredClone(bindings), applicationId: manifest.applicationId, artifactId: descriptor.artifactId,
          ...(candidate ? { bindingSetId, bindingScope: structuredClone(result.backend.bindingScope) } : {}) }),
      };
      if (fixed.connection.kind === 'local-trust-v1') {
        result.applicationConnection.deriveApplication = async input => {
          fixed.check();
          if (input.applicationId !== manifest.applicationId) throw fail('APPLICATION_PREPARATION_INVALID');
          const derived = await fixed.connection.deriveApplication(input);
          try { fixed.check(); } catch (error) { derived.close(); throw error; }
          return { ...derived, context: () => ({ ...derived.context(), resourceBindings: structuredClone(bindings),
            applicationId: manifest.applicationId, artifactId: descriptor.artifactId,
            ...(candidate ? { bindingSetId, bindingScope: structuredClone(result.backend.bindingScope) } : {}) }) };
        };
      }
    }
    return result;
  }
  return { getCompatibilityContext, prepareApplication };
}
