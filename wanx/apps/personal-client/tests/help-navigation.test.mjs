import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
import { createPlatformClient } from "../platform.mjs";

const index = new URL("../build/app/local-ui/renderer/index.html", import.meta.url);
const html = await readFile(index, "utf8");
const source = (await Promise.all([...html.matchAll(/<script src="([^"]+)"><\/script>/g)]
  .map(match => match[1]).filter(src => src !== "./device-setup.bundle.js")
  .map(src => readFile(new URL(src, index), "utf8")))).join("\n");
const data = { product: "memobox", version: "faq-v1", updatedAt: null, categories: [{ id: 1, name: "测试分类", items: [{ id: 1, question: "测试问题", answer: "来自 API 的测试答案" }] }] };
const signedOut = () => ({ route: "auth", phase: "signed_out", account: { phase: "signed_out" }, devices: [], applications: [] });
const signedIn = () => ({ route: "applications", phase: "idle", account: { phase: "authenticated", accountId: "test-account" }, devices: [], applications: [], network: { enabled: false } });
const flush = () => new Promise(resolve => setImmediate(resolve));

async function harness(initial) {
  let current = initial, listener;
  const events = new Map(), calls = [];
  const app = { innerHTML: "", querySelector: () => null, addEventListener(name, callback, capture) {
    const rows = events.get(name) || []; rows.push({ callback, capture: Boolean(capture) }); events.set(name, rows);
  } };
  const window = { addEventListener() {}, wanxClient: {
    getLocalState: async () => current, onLocalState: fn => { listener = fn; },
    action: async (name, input) => {
      calls.push({ name, input });
      return { ok: true, value: name === "help.faq" ? calls.filter(row => row.name === name).length === 1 ? { data, etag: 'W/"faq-v1"' } : { notModified: true } : name === "market.list" ? { items: [] } : undefined, state: current };
    },
  } };
  vm.runInNewContext(source, { window, document: {
    body: { dataset: {}, classList: { toggle() {} }, append() {} }, createElement: () => ({ dataset: {}, setAttribute() {} }),
    addEventListener() {}, querySelector: selector => selector === "#app" ? app : null,
  }, Date, TextEncoder, setTimeout, clearTimeout, setInterval: () => null, clearInterval() {} });
  await flush();
  return { app, calls, async click(action) {
    let stopped = false;
    const node = { dataset: { action }, hasAttribute: () => false };
    const event = { target: { closest: selector => selector === "[data-action]" ? node : null }, preventDefault() {}, stopImmediatePropagation() { stopped = true; } };
    for (const row of [...(events.get("click") || [])].sort((a, b) => Number(b.capture) - Number(a.capture))) {
      await row.callback(event); if (stopped) break;
    }
    await flush();
  }, update(value) { current = value; listener(current); } };
}

test("platform exposes public FAQ without initializing a session or a transport", async () => {
  let calls = 0;
  const client = createPlatformClient({ account: {
    snapshot: () => ({ phase: "signed_out" }), getIdentity: () => null, subscribe: () => () => {}, close() {},
    faq: async input => { calls++; return input; },
  }, createTransport: () => assert.fail("public FAQ must not start network engine") });
  const input = { etag: 'W/"faq-v1"' };
  assert.deepEqual(await client.faq(input), input); assert.equal(calls, 1);
  await client.close();
});

test("signed-out and reset-password pages can open FAQ; state broadcasts cannot evict it", async () => {
  const h = await harness(signedOut());
  assert.match(h.app.innerHTML, /data-action="show-help"/);
  await h.click("auth-reset");
  assert.match(h.app.innerHTML, /data-mode="reset"/);
  await h.click("show-help");
  assert.match(h.app.innerHTML, /来自 API 的测试答案/);
  assert.doesNotMatch(h.app.innerHTML, /data-form="auth"/);
  h.update(signedOut());
  assert.match(h.app.innerHTML, /来自 API 的测试答案/);
  await h.click("help-back");
  assert.match(h.app.innerHTML, /data-mode="reset"/);
  await h.click("show-help");
  assert.equal(h.calls.filter(row => row.name === "help.faq")[1].input.etag, 'W/"faq-v1"');
  assert.match(h.app.innerHTML, /来自 API 的测试答案/);
});

test("settings expose FAQ without a box; forced update keeps FAQ accessible but still blocks business", async () => {
  const h = await harness(signedIn());
  await h.click("show-settings");
  assert.match(h.app.innerHTML, /aria-label="常见问题"/);
  const next = signedIn(); next.upgrades = { client: { requirement: { required: true, minVersion: "9.0.0" } } };
  h.update(next);
  await h.click("show-help");
  assert.match(h.app.innerHTML, /来自 API 的测试答案/);
  h.update(next); assert.match(h.app.innerHTML, /来自 API 的测试答案/);
  await h.click("show-applications");
  assert.doesNotMatch(h.app.innerHTML, /来自 API 的测试答案/);
  assert.match(h.app.innerHTML, /需要更新/);
});
