import { getWarehouseOntologyProfile, WAREHOUSE_ONTOLOGY_NAME } from '../shared/warehouse-ontology-profiles.mjs';
import { identityKey, validCreationScope } from '../shared/onboarding-contract.mjs';

export const quickCreationKey = identity => 'starlink.quick-creation.v1.' + identityKey(identity);
const fail = code => Object.assign(new Error(code), { code });

function validate(record) {
  if (!record?.input || typeof record.input.operationId !== 'string' ||
      !/^[a-zA-Z0-9_-]{1,128}$/.test(record.input.operationId) ||
      typeof record.input.name !== 'string' || typeof record.input.description !== 'string' ||
      (record.input.warehouseScope !== undefined && !validCreationScope(record.input.warehouseScope)) ||
      (record.warehouse && !record.warehouse.id) ||
      (record.ontology && (!getWarehouseOntologyProfile(record.ontology.id) || typeof record.ontology.name !== 'string' ||
        !Array.isArray(record.ontology.schema?.entity_types) || !Array.isArray(record.ontology.schema?.relation_types))) ||
      (record.ontologyDraftId !== undefined && !/^[A-Za-z0-9_-]{1,128}$/.test(record.ontologyDraftId)) ||
      (record.baseOntologyId != null && !/^[A-Za-z0-9_-]{1,128}$/.test(record.baseOntologyId))) throw fail('MODELING_LOCAL_RECORD_INVALID');
  return record;
}

export function readQuickCreation(storage, identity, legacyQuick) {
  try {
    const raw = storage.getItem(quickCreationKey(identity));
    if (raw) return validate(JSON.parse(raw));
    const legacy = legacyQuick?.();
    if (!legacy) return null;
    return validate({ input: legacy.input, ...(legacy.id ? { warehouse:{id:legacy.id} } : {}), legacy: true });
  } catch { throw fail('MODELING_LOCAL_RECORD_INVALID'); }
}

export async function quickCreateWarehouse({ storage, identity, call, enter, name, description, warehouseScope, profileId, installOntology, legacyQuick, isCurrent=()=>true }) {
  const key = quickCreationKey(identity);
  let record = readQuickCreation(storage, identity, legacyQuick);
  const clear = () => {
    if (!isCurrent()) throw fail('HOST_SESSION_EXPIRED');
    if (record.legacy) legacyQuick(record.input.operationId);
    storage.removeItem(key);
  };
  const save = () => {
    if (!isCurrent()) throw fail('HOST_SESSION_EXPIRED');
    try { storage.setItem(key, JSON.stringify(record)); }
    catch { throw fail('MODELING_LOCAL_SAVE_FAILED'); }
  };
  if (!record) {
    const profile = profileId === undefined ? null : getWarehouseOntologyProfile(profileId);
    if (profileId !== undefined && !profile) throw fail('MODELING_INVALID_REQUEST');
    record = validate({
      input: { name, description, ...(warehouseScope && {warehouseScope}), operationId: crypto.randomUUID() },
      ...(profile && { ontology: {
        id: profile.id, name: profileId === 'general' ? WAREHOUSE_ONTOLOGY_NAME : profile.label, schema: profile.schema,
      } }),
    });
    save();
  }
  if (!record.warehouse) {
    let reply;
    try { reply = await call('create-warehouse', record.input); }
    catch (error) {
      if (['WAREHOUSE_NAME_CONFLICT', 'WAREHOUSE_INVALID_NAME', 'MODELING_INVALID_REQUEST', 'SEMANTICA_INVALID_REQUEST'].includes(error.code) &&
          [400, 409, 413, 422].includes(error.status)) clear();
      throw error;
    }
    const warehouse = reply?.warehouse || reply;
    if (!warehouse?.id) throw fail('SEMANTICA_INVALID_RESPONSE');
    record.warehouse = warehouse;
    save();
  }
  if (record.ontology) {
    if (!installOntology) throw fail('SEMANTICA_INVALID_RESPONSE');
    await installOntology(record, save);
  }
  try { await enter(record.warehouse, { view: 'conversation', quick: true }); }
  catch (error) {
    if (error.code === 'HOST_SESSION_EXPIRED') throw error;
    throw fail('MODELING_WAREHOUSE_ENTRY_FAILED');
  }
  clear();
}
