import test from "node:test";
import assert from "node:assert/strict";
import { createAccount } from "../account/index.mjs";

const credentials = { phone: "13800138000", password: "fixture-password" };
const codes = ["AUTH_CLIENT_REPLACED", "AUTH_CLIENT_RETIRED", "AUTH_CLIENT_REAUTH_REQUIRED"];
const reply = (data, status = 200) => new Response(JSON.stringify({ code: status, data }), { status });
const denied = (code, status = 401) => new Response(JSON.stringify({ code: 401, errorCode: code, msg: "untrusted-server-text" }), { status });
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function fixture(store) {
  let saved = null, handler = async () => reply({}), logins = 0;
  const calls = [], states = [];
  store ||= { load: async () => structuredClone(saved), save: async value => { saved = structuredClone(value); } };
  const account = createAccount({ store, emit: state => states.push(state), fetch: async (url, options) => {
    const path = new URL(url).pathname;
    calls.push(path);
    if (path.endsWith("/login")) {
      logins++;
      const body = JSON.parse(options.body);
      return reply({ accountId: "account-" + body.phone, clientId: body.clientId,
        accessToken: "access-" + logins, refreshToken: "refresh-" + logins, expiresIn: 3600 });
    }
    if (path.endsWith("/auth/logout")) return reply({});
    return handler(path, options);
  } });
  return { account, store, calls, states, handle(fn) { handler = fn; } };
}

for (const code of codes) for (const status of [401, 200]) for (const path of ["/app-api/devices", "/app-api/v1/credits/wallet/v2", "/app-api/devices/pairing"]) {
  test(`${code} HTTP${status} on ${path} stops retries and retains installation identity`, async t => {
    const h = fixture(); t.after(() => h.account.close());
    await h.account.loginPassword(credentials);
    const before = await h.store.load();
    h.handle(async () => denied(code, status));
    await assert.rejects(h.account.request({ path, ...(path.endsWith("pairing") ? { responseMetadata: true } : {}) }), { code });
    assert.equal(h.account.snapshot().phase, "signed_out");
    assert.equal(h.account.snapshot().reason, code);
    assert.equal(h.calls.filter(path => path.endsWith("/refresh")).length, 0);
    const saved = await h.store.load();
    assert.equal(saved.active, null);
    assert.deepEqual(saved.accounts[credentials.phone].identity, before.accounts[credentials.phone].identity);
    const count = h.calls.length;
    await assert.rejects(h.account.request({ path: "/app-api/devices" }), { code: "ACCOUNT_LOGIN_REQUIRED" });
    await assert.rejects(h.account.refresh(), { code: "ACCOUNT_LOGIN_REQUIRED" });
    assert.equal(h.calls.length, count);
    const restored = fixture(h.store); t.after(() => restored.account.close());
    await restored.account.restore();
    assert.equal(restored.account.snapshot().reason, code);
    assert.deepEqual(restored.calls, []);
    await restored.account.loginPassword(credentials);
    assert.equal(restored.account.snapshot().reason, null);
    assert.deepEqual((await h.store.load()).accounts[credentials.phone].identity, before.accounts[credentials.phone].identity);
  });
}

for (const code of codes) test(`${code} from refresh terminates once without discarding the persistent key`, async t => {
  const h = fixture(); t.after(() => h.account.close());
  await h.account.loginPassword(credentials);
  h.handle(async () => denied(code));
  await assert.rejects(h.account.refresh(), { code });
  assert.equal(h.account.snapshot().reason, code);
  assert.equal((await h.store.load()).active, null);
  assert.ok((await h.store.load()).accounts[credentials.phone].identity.privateKey);
  assert.equal(h.states.filter(state => state.reason === code).length, 1);
  await h.account.logout();
  assert.equal(h.account.snapshot().reason, null);
  const restored = fixture(h.store); t.after(() => restored.account.close());
  await restored.account.restore();
  assert.equal(restored.account.snapshot().reason, null);
});

test("concurrent terminal failures publish one sign-out and abort other poll requests", async t => {
  const h = fixture(); t.after(() => h.account.close());
  await h.account.loginPassword(credentials);
  const gate = deferred();
  h.handle(async () => { await gate.promise; return denied(codes[0]); });
  const requests = [1, 2, 3].map(() => h.account.request({ path: "/app-api/devices" }));
  gate.resolve();
  const results = await Promise.allSettled(requests);
  assert.ok(results.every(result => result.status === "rejected"));
  assert.equal(h.states.filter(state => state.reason === codes[0]).length, 1);
  assert.equal(h.calls.filter(path => path.endsWith("/refresh")).length, 0);
});

test("a late terminal response for another account cannot sign out the new account", async t => {
  const h = fixture(); t.after(() => h.account.close());
  await h.account.loginPassword(credentials);
  const gate = deferred();
  h.handle(async () => gate.promise);
  const pending = h.account.request({ path: "/app-api/devices" });
  await h.account.logout();
  await h.account.loginPassword({ ...credentials, phone: "13900139000" });
  gate.resolve(denied(codes[0]));
  await assert.rejects(pending, { code: "ACCOUNT_CANCELLED" });
  assert.equal(h.account.snapshot().phase, "authenticated");
  assert.equal(h.account.snapshot().accountId, "account-13900139000");
  assert.equal(h.account.snapshot().reason, null);
});

test("a generic401 still uses the compatible silent refresh path", async t => {
  const h = fixture(); t.after(() => h.account.close());
  await h.account.loginPassword(credentials);
  let rejected = false;
  h.handle(async path => {
    if (path.endsWith("/refresh")) {
      const saved = await h.store.load();
      return reply({ ...saved.active.session, accessToken: "new-access", refreshToken: "new-refresh", expiresIn: 3600 });
    }
    if (!rejected) { rejected = true; return denied("UNKNOWN_AUTH_REASON"); }
    return reply([]);
  });
  assert.deepEqual(await h.account.request({ path: "/app-api/devices" }), []);
  assert.equal(h.account.snapshot().phase, "authenticated");
  assert.equal(h.calls.filter(path => path.endsWith("/refresh")).length, 1);
});

for (const code of codes) test(`cold restoration preserves ${code} instead of retrying silently`, async t => {
  const first = fixture(); t.after(() => first.account.close());
  await first.account.loginPassword(credentials);
  await first.account.close();
  const restored = fixture(first.store); t.after(() => restored.account.close());
  restored.handle(async () => denied(code));
  await assert.rejects(restored.account.restore(), { code });
  assert.equal(restored.account.snapshot().phase, "signed_out");
  assert.equal(restored.account.snapshot().reason, code);
  assert.equal(restored.states.filter(state => state.reason === code).length, 1);
  assert.equal((await first.store.load()).active, null);
});

test("terminal failure after a compatible refresh retry also stops the session", async t => {
  const h = fixture(); t.after(() => h.account.close());
  await h.account.loginPassword(credentials);
  let reads = 0;
  h.handle(async path => {
    if (path.endsWith("/refresh")) {
      const saved = await h.store.load();
      return reply({ ...saved.active.session, accessToken: "new-access", refreshToken: "new-refresh", expiresIn: 3600 });
    }
    return denied(++reads === 1 ? "UNKNOWN_AUTH_REASON" : codes[0]);
  });
  await assert.rejects(h.account.request({ path: "/app-api/devices" }), { code: codes[0] });
  assert.equal(h.account.snapshot().reason, codes[0]);
  assert.equal(h.calls.filter(path => path.endsWith("/refresh")).length, 1);
});

for (const phone of [credentials.phone, "13900139000"]) test(`login ${phone} drains an in-flight forced sign-out before clearing its durable notice`, async t => {
  const gate = deferred(), writing = deferred();
  let saved = null, blocked = false;
  const store = {
    load: async () => structuredClone(saved),
    save: async value => {
      if (value.signedOutReason && !blocked) { blocked = true; writing.resolve(); await gate.promise; }
      saved = structuredClone(value);
    },
  };
  const h = fixture(store); t.after(() => h.account.close());
  await h.account.loginPassword(credentials);
  h.handle(async () => denied(codes[0]));
  const revoked = h.account.request({ path: "/app-api/devices" }).catch(error => error);
  await writing.promise;
  const login = h.account.loginPassword({ ...credentials, phone });
  await new Promise(resolve => setImmediate(resolve));
  gate.resolve();
  assert.equal((await revoked).code, codes[0]);
  await login;
  assert.equal(h.account.snapshot().accountId, "account-" + phone);
  assert.equal((await store.load()).signedOutReason, null);
});

for (const code of codes) for (const status of [401, 200]) test(`legacy credits tasks ${code} HTTP${status} ends the same session without refresh`, async t => {
  const h = fixture(); t.after(() => h.account.close());
  await h.account.loginPassword(credentials);
  h.handle(async () => denied(code, status));
  await assert.rejects(h.account.creditsRequest({ serviceURL: "https://credits.invalid", path: "/api/credits/tasks" }), { code });
  assert.equal(h.account.snapshot().reason, code);
  assert.equal((await h.store.load()).active, null);
  assert.equal(h.calls.filter(path => path.endsWith("/refresh")).length, 0);
});

test("close drains terminal clearing after an older successful refresh save", async () => {
  const gate = deferred(), writing = deferred(), signedOut = deferred();
  let saved = null;
  const store = { load: async () => structuredClone(saved), save: async value => {
    if (value.active?.session?.accessToken === "rotated-access") { writing.resolve(); await gate.promise; }
    saved = structuredClone(value);
  } };
  const h = fixture(store);
  await h.account.loginPassword(credentials);
  h.handle(async path => path.endsWith("/refresh")
    ? reply({ ...saved.active.session, accessToken: "rotated-access", refreshToken: "rotated-refresh", expiresIn: 3600 })
    : denied(codes[0]));
  const refresh = h.account.refresh().catch(error => error);
  await writing.promise;
  const unsubscribe = h.account.subscribe(state => { if (state.reason === codes[0]) signedOut.resolve(); });
  const terminal = h.account.request({ path: "/app-api/devices" }).catch(error => error);
  await signedOut.promise;
  const closing = h.account.close();
  gate.resolve();
  await Promise.all([refresh, terminal, closing]);
  unsubscribe();
  assert.equal(saved.active, null);
  assert.equal(saved.signedOutReason, codes[0]);
  assert.ok(saved.accounts[credentials.phone].identity.privateKey);
});
