// Persist the exact request before sending it: a lost receipt must not create another warehouse.
export function createWarehouseJournal(getStorage) {
  const key = scope => 'wanx.quick-warehouse:' + scope;
  const storage = () => {
    const value = typeof getStorage === 'function' ? getStorage() : getStorage;
    if (!value) throw Error('WAREHOUSE_RECOVERY_UNAVAILABLE');
    return value;
  };
  return {
    read(scope) {
      try {
        if (!scope) throw Error();
        const value = JSON.parse(storage().getItem(key(scope)) || 'null');
        if (value !== null && (!value.input || typeof value.input.name !== 'string' ||
          typeof value.input.description !== 'string' ||
          !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value.input.operationId) ||
          (value.id !== undefined && (typeof value.id !== 'string' || !value.id)))) throw Error();
        return value;
      }
      catch { throw Error('WAREHOUSE_RECOVERY_UNAVAILABLE'); }
    },
    write(scope, value) {
      try {
        const text = JSON.stringify(value);
        if (!scope) throw Error();
        storage().setItem(key(scope), text);
      } catch { throw Error('WAREHOUSE_RECOVERY_UNAVAILABLE'); }
    },
    clear(scope) {
      try { storage().removeItem(key(scope)); }
      catch { throw Error('WAREHOUSE_RECOVERY_UNAVAILABLE'); }
    },
  };
}

// Session IDs and generations invalidate in-flight UI work, but must not hide an
// unresolved create when the same data owner reconnects.
export function warehouseRecoveryScope(state, edition) {
  const device = state.activeDeviceId || state.connection?.deviceId;
  const owner = state.dataOwnerId || (!state.dataIdentity?.profileId && state.account?.accountId);
  if (!owner || !device) return null;
  return JSON.stringify([edition, owner, device, state.dataIdentity?.clientId || state.account?.clientId || null]);
}

export function warehouseInput(name, description) {
  name = String(name || '');
  description = String(description || '');
  if (/[\u0000-\u001f\u007f-\u009f]/.test(name)) throw Error('WAREHOUSE_NAME_INVALID');
  name = name.trim();
  if (!name || [...name].length > 60) throw Error('WAREHOUSE_NAME_INVALID');
  if ([...description].length > 500) throw Error('WAREHOUSE_DESCRIPTION_INVALID');
  return {name, description};
}

export function ontologySummary(value) {
  if (!value || value.status !== 'published') return '当前服务未提供已生效的知识结构，请刷新核对。';
  const label = value.template_id === 'personal_general' ? '通用知识结构已生效' : '知识结构已生效';
  return [label, value.name, value.version_number != null ? `仓内版本 ${value.version_number}` : '',
    value.template_version != null ? `模板版本 ${value.template_version}` : '',
    Number.isInteger(value.entity_type_count) ? `${value.entity_type_count} 类实体` : '',
    Number.isInteger(value.relation_type_count) ? `${value.relation_type_count} 类关系` : ''].filter(Boolean).join(' · ');
}
