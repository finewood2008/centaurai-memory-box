import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createAccount } from "../account/index.mjs";
import { createPlatformClient } from "../platform.mjs";
import { createFaqCache, FAQ_CHECK_INTERVAL } from "../account/faq-cache.mjs";
const payload = (version = "faq-1") => ({ version, updatedAt: null, categories: [{ id: 1, name: "分类", items: [{ id: 1, question: "问题", answer: "答案" }] }] });
async function setup(t, fetch, overrides = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "faq-cache-test-"));
  let time = 1000, delay = null, changes = 0;
  const options = { directory, baseURL: "https://consumer.test/prod-api", edition: "personal", fetch,
    now: () => time, setTimer: (_, value) => { delay = value; return 1; }, clearTimer() {}, changed() { changes++; }, ...overrides };
  const service = createFaqCache(options);
  t.after(async () => { await service.close(); await rm(directory, { recursive: true, force: true }); });
  return { service, options, directory, delay: () => delay, changes: () => changes,
    advance: async value => { time += value; await service.checkDue(); } };
}
test("startup checks once; opening cache never fetches; 24h and resume coalesce overdue checks", async t => {
  let calls = 0;
  const h = await setup(t, async () => { calls++; return { data: payload(), etag: 'W/"faq-1"' }; });
  h.service.start(); h.service.start(); await h.service.checkDue();
  for (let i = 0; i < 20; i++) await h.service.read();
  assert.equal(calls, 1); assert.equal(h.delay(), FAQ_CHECK_INTERVAL);
  await h.advance(FAQ_CHECK_INTERVAL - 1); assert.equal(calls, 1);
  await h.advance(1); assert.equal(calls, 2);
  await h.advance(FAQ_CHECK_INTERVAL * 3); assert.equal(calls, 3);
});
test("disk survives restart, startup revalidates ETag, 304 updates check time only", async t => {
  const h = await setup(t, async () => ({ data: payload(), etag: 'W/"faq-1"' }));
  h.service.start(); await h.service.checkDue(); await h.service.close();
  const first = JSON.parse(await readFile(h.service.cacheFile, "utf8")); let sent;
  const next = createFaqCache({ ...h.options, now: () => 5000, fetch: async input => { sent = input; return { notModified: true }; } });
  t.after(() => next.close());
  assert.equal((await next.read()).data.version, "faq-1"); next.start(); await next.checkDue();
  assert.equal(sent.etag, 'W/"faq-1"');
  const saved = JSON.parse(await readFile(next.cacheFile, "utf8"));
  assert.equal(saved.lastCheckedAt, 5000); assert.equal(saved.updatedAt, first.updatedAt);
  assert.equal(saved.data.version, "faq-1");
});
test("new content replaces cache; failure preserves it and backs off 1/5/30/60 minutes", async t => {
  let failure = false, version = "faq-1";
  const h = await setup(t, async () => { if (failure) throw Error("private content must never be logged"); return { data: payload(version), etag: `W/"${version}"` }; });
  h.service.start(); await h.service.checkDue(); version = "faq-2";
  await h.advance(FAQ_CHECK_INTERVAL); assert.equal((await h.service.read()).data.version, version);
  failure = true; await h.advance(FAQ_CHECK_INTERVAL);
  for (const delay of [60_000, 300_000, 1_800_000, 3_600_000]) { assert.equal(h.delay(), delay); await h.advance(delay); }
  assert.equal((await h.service.read()).data.version, "faq-2");
  await h.service.close(); assert.doesNotMatch(await readFile(h.service.logFile, "utf8"), /private content|答案/);
});
test("corrupt cache is discarded; invalid HTTP data cannot replace a valid snapshot", async t => {
  let response = { data: payload(), etag: 'W/"faq-1"' };
  const h = await setup(t, async () => response);
  await h.service.read(); await h.service.close();
  await writeFile(h.service.cacheFile, "{broken");
  const service = createFaqCache(h.options); t.after(() => service.close());
  assert.equal((await service.read()).data, null);
  service.start(); await service.checkDue();
  response = { data: { categories: [] }, etag: 'W/"invalid"' };
  await h.advance(FAQ_CHECK_INTERVAL); await service.checkDue();
  assert.equal((await service.read()).data.version, "faq-1"); assert.equal((await service.read()).errorCode, "FAQ_INVALID_RESPONSE");
});
test("cache scopes isolate service URLs and editions; write failure retains usable memory", async t => {
  const h = await setup(t, async () => ({ data: payload(), etag: 'W/"faq-1"' }));
  for (const change of [{ baseURL: "https://other.test" }, { edition: "team" }]) {
    const other = createFaqCache({ ...h.options, ...change }); t.after(() => other.close());
    assert.notEqual(h.service.cacheFile, other.cacheFile); assert.equal((await other.read()).data, null);
  }
  const blocked = path.join(h.directory, "not-a-directory"); await writeFile(blocked, "x");
  const service = createFaqCache({ ...h.options, directory: blocked }); t.after(() => service.close());
  service.start(); await service.checkDue(); assert.equal((await service.read()).data.version, "faq-1");
});
test("in-flight checks coalesce and shutdown suppresses late updates", async t => {
  let finish, count = 0;
  const h = await setup(t, () => { count++; return new Promise(resolve => { finish = resolve; }); });
  h.service.start(); const pending = h.service.checkDue();
  while (!finish) await new Promise(resolve => setImmediate(resolve));
  h.service.checkDue(); assert.equal(count, 1); await h.service.close(); finish({ data: payload(), etag: 'W/"faq-1"' }); await pending;
  assert.equal(h.changes(), 0); assert.equal((await h.service.read()).data, null);
});

test("actual account transport and platform cache keep all renderer reads off the network", async t => {
  let fetches = 0;
  const account = createAccount({ fetch: async () => { fetches++; return new Response(JSON.stringify({ code: 200, success: true, data: payload() }),
    { headers: { ETag: 'W/"faq-1"' } }); } });
  const h = await setup(t, input => account.faq(input));
  const client = createPlatformClient({ account, faqCache: h.service });
  t.after(() => client.close());
  h.service.start(); await h.service.checkDue();
  for (let i = 0; i < 10; i++) assert.equal((await client.faq({ etag: 'W/"anything"', force: true })).data.version, "faq-1");
  assert.equal(fetches, 1);
});
