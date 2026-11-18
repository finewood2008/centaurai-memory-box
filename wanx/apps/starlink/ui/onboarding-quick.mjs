import { identityKey } from '../shared/onboarding-contract.mjs';

export const quickCreationKey = identity => 'starlink.quick-creation.v1.' + identityKey(identity);
const fail = code => Object.assign(new Error(code), { code });

function validate(record) {
  if (!record?.input || typeof record.input.operationId !== 'string' ||
      !/^[a-zA-Z0-9_-]{1,128}$/.test(record.input.operationId) ||
      typeof record.input.name !== 'string' || typeof record.input.description !== 'string' ||
      (record.warehouse && !record.warehouse.id)) throw fail('MODELING_LOCAL_RECORD_INVALID');
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

export async function quickCreateWarehouse({ storage, identity, call, enter, name, description, legacyQuick, isCurrent=()=>true }) {
  const key = quickCreationKey(identity);
  let record = readQuickCreation(storage, identity, legacyQuick);
  const clear = () => {
    if (!isCurrent()) throw fail('HOST_SESSION_EXPIRED');
    if (record.legacy) legacyQuick(record.input.operationId);
    storage.removeItem(key);
  };
  const save = () => {
    try { storage.setItem(key, JSON.stringify(record)); }
    catch { throw fail('MODELING_LOCAL_SAVE_FAILED'); }
  };
  if (!record) {
    record = { input: { name, description, operationId: crypto.randomUUID() } };
    save();
  }
  if (!record.warehouse) {
    let reply;
    try { reply = await call('create-warehouse', record.input); }
    catch (error) {
      if (['WAREHOUSE_NAME_CONFLICT', 'MODELING_INVALID_REQUEST', 'SEMANTICA_INVALID_REQUEST'].includes(error.code) &&
          [400, 409, 413, 422].includes(error.status)) clear();
      throw error;
    }
    const warehouse = reply?.warehouse || reply;
    if (!warehouse?.id) throw fail('SEMANTICA_INVALID_RESPONSE');
    record.warehouse = warehouse;
    save();
  }
  try { await enter(record.warehouse, { view: 'conversation', quick: true }); }
  catch (error) {
    if (error.code === 'HOST_SESSION_EXPIRED') throw error;
    throw fail('MODELING_WAREHOUSE_ENTRY_FAILED');
  }
  clear();
}
