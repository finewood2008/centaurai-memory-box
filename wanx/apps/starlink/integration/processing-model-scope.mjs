const fail = code => Object.assign(new Error(code), {code});
const warehouseIdPattern = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const validRevision = revision => Number.isSafeInteger(revision) && revision >= 0;
const sharedScope = {scope: 'default'};
const batchSize = 6;
const transferring = new Set(['importing', 'import_failed', 'deleting']);

async function settleInBatches(items, guard, run) {
  const results = [];
  for (let index = 0; index < items.length; index += batchSize) {
    guard();
    results.push(...await Promise.allSettled(items.slice(index, index + batchSize).map(run)));
    guard();
  }
  return results;
}

async function projectProfiles(call, guard) {
  const list = await call('warehouses');
  if (!Array.isArray(list?.items)) throw fail('SEMANTICA_INVALID_RESPONSE');
  const projects = new Map();
  for (const item of list.items) {
    if (typeof item?.id !== 'string' || !warehouseIdPattern.test(item.id) || typeof item.state !== 'string') {
      throw fail('SEMANTICA_INVALID_RESPONSE');
    }
    if (item.state !== 'deleted') projects.set(item.id, item.state);
  }
  // The import/delete operation owns its profile until it finishes.
  const eligible = [...projects].flatMap(([id, state]) => transferring.has(state) ? [] : [id]);
  const results = await settleInBatches(eligible, guard, async warehouseId => {
    const profile = await call('processing', {scope: 'warehouse', warehouseId});
    if (profile?.warehouse_id !== warehouseId || typeof profile.inherit !== 'boolean' || !validRevision(profile.revision)) {
      throw fail('SEMANTICA_INVALID_RESPONSE');
    }
    return {warehouseId, inherit:profile.inherit, revision:profile.revision};
  });
  return {
    unresolved: projects.size - eligible.length + results.filter(result => result.status === 'rejected').length,
    overrides: results.flatMap(result => result.status === 'fulfilled' && !result.value.inherit ? [result.value] : []),
  };
}

function sharedRevision(value) {
  if (!value || value.warehouse_id != null || !validRevision(value.revision)) throw fail('SEMANTICA_INVALID_RESPONSE');
  return value.revision;
}

async function applyInheritance(call, guard, revision, {unresolved, overrides}) {
  let pending = unresolved + overrides.length;
  for (let index = 0; index < overrides.length; index += batchSize) {
    try {
      if (sharedRevision(await call('processing', sharedScope)) !== revision) break;
    } catch {
      guard();
      break;
    }
    const results = await settleInBatches(overrides.slice(index, index + batchSize), guard, async ({warehouseId, revision}) => {
      const saved = await call('save-models', {
        scope: 'warehouse', warehouseId, config: {expected_revision: revision, inherit: true},
      });
      if (saved?.warehouse_id !== warehouseId || saved.inherit !== true) throw fail('SEMANTICA_INVALID_RESPONSE');
    });
    pending -= results.filter(result => result.status === 'fulfilled').length;
  }
  return {pending};
}

// The box already owns the default profile and revision checks. Migrate overrides
// only as part of an explicit save or retry from the personal model settings.
export async function syncProcessingModels(action, input, {call, guard}) {
  if (input.scope !== 'default') throw fail('INVALID_RESOURCE');
  if (action === 'sync-models') {
    if (!validRevision(input.expectedRevision) || input.expectedRevision === 0) throw fail('INVALID_RESOURCE');
    if (sharedRevision(await call('processing', sharedScope)) !== input.expectedRevision) throw fail('MODEL_CONFIG_CONFLICT');
    const projects = await projectProfiles(call, guard);
    return {modelSync: await applyInheritance(call, guard, input.expectedRevision, projects)};
  }

  const {expected_revision, mode, check_id} = input.config ?? {};
  if (input.applyToAll !== true || !validRevision(expected_revision) || expected_revision === Number.MAX_SAFE_INTEGER ||
      !['automatic', 'manual'].includes(mode) || typeof check_id !== 'string' || !check_id || check_id.length > 300) {
    throw fail('INVALID_RESOURCE');
  }
  const projects = await projectProfiles(call, guard);
  const saved = await call('save-models', {...sharedScope, config:{expected_revision, mode, check_id}});
  const revision = sharedRevision(saved);
  if (revision !== expected_revision + 1) throw fail('MODEL_CONFIG_CONFLICT');
  return {...saved, modelSync:await applyInheritance(call, guard, revision, projects)};
}
