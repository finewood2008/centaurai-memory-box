import { answerStarxiaotu, identifyStarxiaotuIntent, starxiaotuModels } from './starxiaotu-agent.mjs';
import { SemanticaService } from '../shell/service.mjs';
import { workbenchErrorReply } from '../shell/workbench-errors.mjs';
import { onboardingActions } from '../shared/onboarding-contract.mjs';
import { conversationActions } from '../shared/conversation-contract.mjs';
import drive from '../../personal-client/host-sdk/drive.cjs';
import { dataInteractionKey, dataOwnerKey } from '../../personal-client/device-trust/data-context.mjs';
import { createStarlinkSpaceAnnotations } from '../../builder/integration/personal-client/starlink-space-annotations.mjs';
import { syncProcessingModels } from './processing-model-scope.mjs';

const warehouseUuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const actions = new Set(['initialize', 'warehouses', 'warehouse', 'select-warehouse', 'runtime',
  'assistant-intent', 'starxiaotu-models', 'save-starxiaotu-model',
  'create-warehouse', 'prepare-delete', 'delete-warehouse', 'documents', 'document', 'document-text', 'delete-document', 'download', 'correct', 'warehouse-import-status', 'jobs',
  'graph', 'search', 'starxiaotu-answer', 'evidence', 'retrieval', 'retry-job', 'build-index', 'processing',
  'model-catalog', 'check-models', 'save-models', 'sync-models', 'reprocess-models',
  'select-space-files', 'space-list', 'release-files', 'upload', 'workbench-request',
  ...onboardingActions, ...conversationActions]);
const fail = code => Object.assign(new Error(code), { code });

// Uses the client's current application connection, never desktop environment credentials.
export function createStarlinkPanelService({ client, personalSpace, selectSave, emit = () => {}, openModels = () => {}, starxiaotuModelStore }) {
  let active, pending, revision = 0, disposed = false;
  let modelWrites = Promise.resolve();
  async function selection(context, change) {
    if (!starxiaotuModelStore) return null;
    const owner = dataOwnerKey(client.snapshot());
    if (!owner || !context.boxId || context.user?.id == null) throw fail('HOST_SESSION_EXPIRED');
    const scope = JSON.stringify([owner, context.boxId, context.user.id]);
    const load = async () => {
      try { return await starxiaotuModelStore.load() || {}; }
      catch { throw fail('MODEL_PREFERENCE_UNAVAILABLE'); }
    };
    if (!change) return (await load())[scope] ?? null;
    const write = modelWrites.then(async () => {
      change.check();
      const records = await load();
      change.check();
      if (change.ref === null) delete records[scope];
      else records[scope] = change.ref;
      try { await starxiaotuModelStore.save(records); }
      catch { throw fail('MODEL_PREFERENCE_UNAVAILABLE'); }
    });
    modelWrites = write.catch(() => {});
    await write;
  }
  const key = () => dataInteractionKey(client.snapshot());
  let observedKey = key();
  function invalidate(notify = true) {
    revision++;
    const previous = active;
    active = pending = null;
    previous?.service.close();
    previous?.unwatch?.();
    previous?.link.close?.();
    if (notify) emit({ type: 'invalidated' });
  }
  function live(value) {
    if (disposed || !key() || value.key !== key() || value.revision !== revision) throw fail('HOST_SESSION_EXPIRED');
    return value.link.context();
  }
  const stop = client.subscribe(() => {
    const next = key();
    if (next !== observedKey) { observedKey = next; invalidate(); }
    else if (active) { try { live(active); } catch { invalidate(); } }
  });
  async function entry() {
    if (disposed || !key()) throw fail('HOST_SESSION_EXPIRED');
    if (active) { try { live(active); return active; } catch { invalidate(); } }
    if (pending) return pending;
    const scope = key(), generation = revision;
    const work = (async () => {
      const link = await client.applicationConnection('centaurai.wanx.semantica');
      const value = { key: scope, revision: generation, link };
      try {
        live(value);
        const host = {
          close() {},
          context: async () => { live(value); return { ...link.context(), dataScope: 'personal' }; },
          onSessionInvalidated: notify => link.subscribe(() => { try { live(value); } catch { notify(); } }),
          async request(path, { body, headers = {}, method = 'GET', ...options } = {}) {
            live(value);
            headers = Object.fromEntries(Object.entries(headers).filter(([name]) => name.toLowerCase() !== 'x-wanx-data-context'));
            if (body != null && !(body instanceof Uint8Array)) {
              body = Buffer.from(JSON.stringify(body)); headers['content-type'] = 'application/json';
            }
            const response = await link.request({ path, method, headers, ...options, ...(body != null ? { body } : {}) });
            live(value);
            return new Response(response.body.length ? response.body : null, { status: response.status, headers: response.headers });
          },
        };
        host.drive = drive.createDriveClient(host);
        value.service = new SemanticaService({ host, selectFiles: async () => { throw fail('SEMANTICA_OPERATION_NOT_ALLOWED'); }, selectSave, emit: event => {
          if (disposed || value.revision !== revision || value.key !== key()) return;
          if (event.type === 'invalidated') {
            if (active === value) invalidate();
            else { value.service?.close(); link.close?.(); invalidate(); }
          } else emit(event);
        } });
        value.annotations = createStarlinkSpaceAnnotations({ space: personalSpace, service: value.service, check: () => live(value) });
        value.service.context = await host.context();
        live(value); active = value;
        value.unwatch = link.onInvalidated?.(() => { if (active === value) invalidate(); });
        return value;
      } catch (error) { value.service?.close(); link.close?.(); throw error; }
    })();
    pending = work;
    try { return await work; } finally { if (pending === work) pending = null; }
  }
  return {
    async action(action, input = {}) {
      try {
        // A new panel document resets its own service before initializing. Do not
        // echo this reset back as a session failure and destroy that document.
        if (action === 'reset') { invalidate(false); return { ok: true, value: null }; }
        if (!actions.has(action) && !['launch-target', 'launch-target-applied', 'open-model-management'].includes(action)) throw fail('SEMANTICA_OPERATION_NOT_ALLOWED');
        if (action === 'prepare-delete' || action === 'delete-warehouse') {
          if (typeof input.warehouseId !== 'string' || !warehouseUuid.test(input.warehouseId) ||
              typeof input.operationId !== 'string' || !warehouseUuid.test(input.operationId)) throw fail('INVALID_RESOURCE');
          if (action === 'delete-warehouse' && (typeof input.token !== 'string' || !input.token.length ||
              typeof input.typedName !== 'string' || !input.typedName.trim())) throw fail('INVALID_RESOURCE');
        }
        // The global guide uses the box model connection without opening a project data session.
        if (action === 'starxiaotu-answer' && input.applicationGuide === true) {
          const value = {key: key(), revision, link: await client.applicationConnection()};
          try {
            live(value);
            const answer = await answerStarxiaotu({client, link:value.link, input, live:() => live(value)});
            live(value);
            return {ok:true, value:answer};
          } finally { value.link.close?.(); }
        }
        const value = await entry(); live(value);
        if (action === 'launch-target') return { ok: true, value: null };
        if (action === 'launch-target-applied') return { ok: true, value: { applied: true } };
        if (action === 'open-model-management') { await openModels(); live(value); return { ok: true, value: { opened: true } }; }
        const assistant = {client, service: value.service, link: value.link, input, live: () => live(value), selection};
        let result;
        if (action === 'starxiaotu-models' || action === 'save-starxiaotu-model') {
          if (!starxiaotuModelStore) throw fail('SEMANTICA_OPERATION_NOT_ALLOWED');
          const ref = action === 'save-starxiaotu-model' ? input.modelRef : undefined;
          if (action === 'save-starxiaotu-model' && ref !== null &&
              (typeof ref !== 'string' || !ref.trim() || ref.length > 512)) throw fail('INVALID_RESOURCE');
          result = await starxiaotuModels(assistant, ref);
        } else if (action === 'sync-models' || action === 'save-models' && input.applyToAll === true) {
          if (value.savingSharedModels) throw fail('MODEL_CONFIG_CONFLICT');
          const retry = action === 'sync-models';
          const scopeKey = context => JSON.stringify([context.accountId, context.boxId, context.user?.id]);
          const owner = scopeKey(live(value));
          const authorized = value.processingModelSync;
          if (retry && (authorized?.owner !== owner || authorized.revision !== input.expectedRevision)) {
            throw fail('MODEL_CONFIG_CONFLICT');
          }
          const guard = () => {
            if (scopeKey(live(value)) !== owner) throw fail('HOST_SESSION_EXPIRED');
          };
          value.savingSharedModels = true;
          try {
            result = await syncProcessingModels(action, input, {guard, call: (operation, payload) => {
              guard();
              return value.service.call(operation, payload);
            }});
            guard();
            value.processingModelSync = result.modelSync.pending ? {owner, revision:retry ? input.expectedRevision : result.revision} : null;
          } finally { value.savingSharedModels = false; }
        } else if (action === 'starxiaotu-answer') result = await answerStarxiaotu(assistant);
        else if (action === 'assistant-intent' && starxiaotuModelStore) result = await identifyStarxiaotuIntent(assistant);
        else result = await value.annotations.run(action, input, () => value.service.call(action, input));
        live(value);
        return { ok: true, value: result };
      } catch (error) {
        // Ordinary material/Drive errors have their own UI recovery messages.
        // Keep their public code without exposing arbitrary exception text.
        if (/^(?:SPACE|NETWORK)_[A-Z_]+$/.test(error?.code || '')) return {ok:false,code:error.code};
        return workbenchErrorReply(error);
      }
    },
    close() { disposed = true; stop(); invalidate(); },
  };
}
