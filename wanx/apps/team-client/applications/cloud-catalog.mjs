import { createHash } from 'node:crypto';
import { validApplicationId, marketFailure } from './descriptor.mjs';

// Only successful catalog responses are cached. Downloads and update offers
// always use the authenticated live market and its signed descriptors.
export function validateCloudCatalog(value) {
  if (!value || !Array.isArray(value.items) || value.items.length > 1000 ||
      Buffer.byteLength(JSON.stringify(value)) > 2 * 1024 * 1024 ||
      value.items.some(item => !item || !validApplicationId(item.applicationId) ||
        typeof item.name !== 'string' || !item.name.trim() || item.name.length > 200) ||
      new Set(value.items.map(item => item.applicationId)).size !== value.items.length)
    throw marketFailure('MARKET_INVALID_RESPONSE');
  return { items: value.items.filter(item => item.listed !== false).map(item => ({
    applicationId: item.applicationId, name: item.name,
    ...Object.fromEntries(['description', 'iconUrl', 'createdAt', 'updatedAt'].filter(key => typeof item[key] === 'string').map(key => [key, item[key]])),
    ...(typeof item.listed === 'boolean' ? { listed: item.listed } : {}),
  })) };
}

export function createCloudCatalog({ request, session, getScope = () => null, store, now = Date.now }) {
  let records = null, loading, writes = Promise.resolve(), sequence = 0;
  const accepted = new Map();
  async function load() {
    if (!loading) loading = Promise.resolve().then(() => store?.load()).then(value => {
      records = value?.schemaVersion === 1 && value.entries && typeof value.entries === 'object'
        ? value.entries : {};
    }).catch(() => { records = {}; });
    await loading;
  }
  function cached(key) {
    const entry = records?.[key];
    if (!entry || !Number.isFinite(entry.fetchedAt) || entry.fetchedAt <= 0) return null;
    try { return { value: validateCloudCatalog(entry.value), fetchedAt: entry.fetchedAt }; }
    catch { return null; }
  }
  return {
    async list() {
      const check = session(), scope = getScope(), serial = ++sequence;
      const key = typeof scope === 'string' && scope ? createHash('sha256').update(scope).digest('hex') : null;
      const assertCurrent = () => { check(); if (scope !== getScope()) throw marketFailure('MARKET_SESSION_CHANGED'); };
      assertCurrent();
      try {
        const value = validateCloudCatalog(await request({ path: '/app-api/market/apps', method: 'GET' }));
        assertCurrent();
        const fetchedAt = now();
        if (key) {
          await load(); assertCurrent();
          if (serial > (accepted.get(key) || 0)) {
            accepted.set(key, serial);
            records[key] = { fetchedAt, value };
            const entries = Object.fromEntries(Object.entries(records).sort((a, b) => b[1].fetchedAt - a[1].fetchedAt).slice(0, 20));
            records = entries;
            // A cache write failure cannot turn a valid live catalog into an
            // outage. No plaintext fallback is introduced by this module.
            writes = writes.catch(() => {}).then(async () => { assertCurrent(); await store?.save({ schemaVersion: 1, entries }); });
            await writes.catch(() => {});
            assertCurrent();
          }
        }
        return { ...value, catalogState: { source: 'cloud', offline: false, fetchedAt } };
      } catch (error) {
        assertCurrent();
        const network = error.code === 'ACCOUNT_NETWORK_ERROR' ||
          error.status >= 500 && ['ACCOUNT_REQUEST_FAILED', 'MARKET_DATABASE_UNAVAILABLE', 'MARKET_STORAGE_UNAVAILABLE'].includes(error.code) ||
          ['ECONNREFUSED', 'ECONNRESET', 'ENETUNREACH', 'ETIMEDOUT'].includes(error.code);
        if (!network || !key) throw error;
        await load(); assertCurrent();
        const previous = cached(key);
        if (!previous) throw error;
        return { ...previous.value, catalogState: { source: 'cache', offline: true, fetchedAt: previous.fetchedAt } };
      }
    },
  };
}
