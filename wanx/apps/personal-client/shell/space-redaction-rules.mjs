import { createHash } from "node:crypto";
import { defaultRedactionRules, normalizeRedactionRules } from "./space-redaction.mjs";

const fail = code => Object.assign(new Error(code), { code });
const digest = value => createHash("sha256").update(value).digest("hex");
const isRecord = value => value !== null && typeof value === "object" && !Array.isArray(value);

export function createSpaceRedactionRules({ store, currentOwner }) {
  let writes = Promise.resolve();
  const ownerToken = () => {
    const owner = currentOwner();
    return owner ? digest(owner) : null;
  };
  const checkOwner = owner => {
    if (ownerToken() !== owner) throw fail("SPACE_CONTEXT_CHANGED");
  };
  async function load() {
    try {
      const saved = await store.load();
      if (saved === null) return { version: 1, owners: {}, uploads: {} };
      if (saved?.version === 1 && isRecord(saved.owners) && (saved.uploads === undefined || isRecord(saved.uploads)))
        return { ...saved, uploads: saved.uploads ?? {} };
    } catch {}
    throw fail("SPACE_REDACTION_RULES_UNAVAILABLE");
  }
  function read(owners, owner) {
    if (!Object.hasOwn(owners, owner)) return { owner, revision: 0, ...defaultRedactionRules() };
    const record = owners[owner];
    if (Number.isSafeInteger(record?.revision) && record.revision > 0) {
      try { return { owner, revision: record.revision, ...normalizeRedactionRules(record) }; }
      catch {}
    }
    throw fail("SPACE_REDACTION_RULES_UNAVAILABLE");
  }
  async function get(input) {
    const owner = ownerToken();
    if (!owner) throw fail("ACCOUNT_LOGIN_REQUIRED");
    if (input?.owner !== undefined && input.owner !== owner) throw fail("SPACE_CONTEXT_CHANGED");
    await writes;
    checkOwner(owner);
    const { owners } = await load();
    checkOwner(owner);
    return read(owners, owner);
  }
  function update(owner, mutate) {
    const pending = writes.then(async () => {
      checkOwner(owner);
      const data = await load();
      checkOwner(owner);
      const result = mutate(data);
      try { await store.save(data); }
      catch { throw fail("SPACE_REDACTION_RULES_UNAVAILABLE"); }
      checkOwner(owner);
      return result;
    });
    writes = pending.catch(() => {});
    return pending;
  }
  async function save(input) {
    const owner = ownerToken();
    if (!owner) throw fail("ACCOUNT_LOGIN_REQUIRED");
    if (input?.owner !== owner) throw fail("SPACE_CONTEXT_CHANGED");
    if (!Number.isSafeInteger(input.revision) || input.revision < 0) throw fail("SPACE_REDACTION_RULES_INVALID");
    const rules = normalizeRedactionRules(input);
    return update(owner, data => {
      const { revision } = read(data.owners, owner);
      if (input.revision !== revision) throw fail("SPACE_REDACTION_RULES_CONFLICT");
      const record = { revision: revision + 1, ...rules };
      data.owners[owner] = record;
      return { owner, ...record };
    });
  }
  // A pending upload contains only masked bytes. Persist its id so an interrupted
  // attempt can discard the unfinished copy after the same space reconnects.
  const uploadKey = (owner, scope, spaceId) => digest(JSON.stringify([owner, scope, spaceId]));
  async function pendingUpload(owner, scope, spaceId) {
    await writes;
    checkOwner(owner);
    const { uploads } = await load();
    checkOwner(owner);
    const value = uploads[uploadKey(owner, scope, spaceId)];
    if (value === undefined) return null;
    if (typeof value === "string" && /^[a-f0-9]{32}$/.test(value)) return value;
    throw fail("SPACE_REDACTION_RULES_UNAVAILABLE");
  }
  function recordUpload(owner, scope, spaceId, uploadId) {
    return update(owner, ({ uploads }) => {
      const key = uploadKey(owner, scope, spaceId);
      if (uploadId) uploads[key] = uploadId;
      else delete uploads[key];
    });
  }
  return { get, save, pendingUpload, recordUpload, close: () => writes };
}
