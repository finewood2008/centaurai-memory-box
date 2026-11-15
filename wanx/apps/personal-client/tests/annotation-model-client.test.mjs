import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createAnnotationModelClient } from "../shell/annotation-model-client.mjs";

const token = "synthetic-local-token-only";
const baseUrl = "http://127.0.0.1:53129/";
const deferred = () => { let resolve; const promise = new Promise(value => { resolve = value; }); return { promise, resolve }; };
const reply = (body, ok = true) => ({ ok, json: async () => structuredClone(body) });
const unavailable = { code: "SPACE_ANNOTATION_MODEL_UNAVAILABLE" };

async function fixture(t, options = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "memobox-annotation-model-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const runtimeFile = path.join(directory, "runtime.json");
  await writeFile(runtimeFile, JSON.stringify({ baseUrl, localToken: token, ...options.descriptor }));
  let scope = "synthetic-owner-box-session", readinessCalls = 0;
  const requests = [];
  const client = createAnnotationModelClient({
    runtimeFile, getScope: () => scope,
    async ensureReady() { readinessCalls++; await options.ensureReady?.(); },
    async request(url, input) {
      requests.push({ url: url.href, input });
      return options.request ? options.request(url, input) : reply({ available: true, presets: [] });
    },
  });
  return { client, requests, runtimeFile, switch(value = "other-owner-box-session") { scope = value; }, get readinessCalls() { return readinessCalls; } };
}

test("models reads a real descriptor but exposes only the fixed loopback endpoint and public result", async t => {
  const publicResult = { available: true, presets: [{ id: "synthetic-model", name: "Synthetic", provider: "local" }] };
  const f = await fixture(t, { request: async () => reply(publicResult) });
  const result = await f.client.models();
  assert.deepEqual(result, publicResult);
  assert.equal(f.readinessCalls, 1);
  assert.equal(f.requests.length, 1);
  const { url, input } = f.requests[0];
  assert.equal(url, "http://127.0.0.1:53129/api/app/space-annotations/models");
  assert.equal(input.method, "GET");
  assert.equal(input.redirect, "error");
  assert.deepEqual(input.headers, { "x-memmy-local-token": token });
  assert.ok(input.signal instanceof AbortSignal);
  assert.equal(Object.hasOwn(input, "body"), false);
  assert.equal(JSON.stringify(result).includes(token), false);
  assert.equal(Object.hasOwn(result, "base"), false);
  assert.equal(Object.hasOwn(result, "localToken"), false);
});

test("suggest posts JSON with the private descriptor token and a caller cannot choose its route", async t => {
  const result = { tags: ["Synthetic"], description: "Synthetic annotation", model: { id: "synthetic-model" } };
  const f = await fixture(t, { request: async () => reply(result) });
  const input = { modelPresetId: "synthetic-model", file: { name: "fixture.txt", content: "synthetic text", contentMode: "content" }, instructions: "Use short labels" };
  assert.deepEqual(await f.client.suggest(input), result);
  assert.equal(f.requests[0].url, "http://127.0.0.1:53129/api/app/space-annotations/suggest");
  assert.equal(f.requests[0].input.method, "POST");
  assert.deepEqual(f.requests[0].input.headers, { "x-memmy-local-token": token, "content-type": "application/json" });
  assert.deepEqual(JSON.parse(f.requests[0].input.body), input);
  assert.equal(JSON.stringify(result).includes(token), false);
});

test("a missing scope prevents even runtime startup", async t => {
  const f = await fixture(t); f.switch(null);
  await assert.rejects(f.client.models(), { code: "SPACE_CONTEXT_CHANGED" });
  assert.equal(f.readinessCalls, 0);
  assert.equal(f.requests.length, 0);
});

test("a scope change while ensuring readiness prevents descriptor use or model requests", async t => {
  const started = deferred(), release = deferred();
  const f = await fixture(t, { ensureReady: async () => { started.resolve(); await release.promise; } });
  const pending = f.client.models(); await started.promise;
  f.switch(); release.resolve();
  await assert.rejects(pending, { code: "SPACE_CONTEXT_CHANGED" });
  assert.equal(f.requests.length, 0);
});

test("a scope change during real descriptor I/O cannot send the old token", async t => {
  // readFile performs several asynchronous reads for this real descriptor;
  // the immediate runs while descriptor I/O is pending, without mocking fs.
  const f = await fixture(t, { descriptor: { syntheticPadding: "x".repeat(2 * 1024 * 1024) } });
  const pending = f.client.models();
  setImmediate(() => f.switch());
  await assert.rejects(pending, { code: "SPACE_CONTEXT_CHANGED" });
  assert.equal(f.requests.length, 0);
});

test("a scope change during fetch withholds the reply before reading its body", async t => {
  const started = deferred(), release = deferred(); let bodyReads = 0;
  const f = await fixture(t, { request: async () => { started.resolve(); await release.promise; return { ok: true, async json() { bodyReads++; return { available: true }; } }; } });
  const pending = f.client.models(); await started.promise;
  f.switch(); release.resolve();
  await assert.rejects(pending, { code: "SPACE_CONTEXT_CHANGED" });
  assert.equal(bodyReads, 0);
});

test("a scope change during JSON parsing withholds otherwise successful model content", async t => {
  const started = deferred(), release = deferred();
  const f = await fixture(t, { request: async () => ({ ok: true, async json() { started.resolve(); await release.promise; return { tags: ["old-account"] }; } }) });
  const pending = f.client.suggest({ file: { name: "synthetic.txt" } }); await started.promise;
  f.switch(); release.resolve();
  await assert.rejects(pending, { code: "SPACE_CONTEXT_CHANGED" });
});

test("known backend annotation and context errors retain their public codes", async t => {
  for (const code of ["SPACE_ANNOTATION_MODEL_UNAVAILABLE", "SPACE_ANNOTATION_MODEL_TIMEOUT", "SPACE_ANNOTATION_INVALID_MODEL_OUTPUT", "SPACE_CONTEXT_CHANGED"]) {
    const f = await fixture(t, { request: async () => reply({ error: { code } }, false) });
    await assert.rejects(f.client.models(), { code, message: code });
  }
});

test("raw transport and backend error strings never disclose descriptor tokens", async t => {
  for (const request of [
    async () => { throw new Error(`Failed request; credential=${token}`); },
    async () => reply({ error: { code: `UPSTREAM_WITH_TOKEN_${token}` }, detail: token }, false),
    async () => ({ ok: true, json: async () => { throw new Error(`Invalid JSON; private=${token}`); } }),
  ]) {
    const f = await fixture(t, { request });
    await assert.rejects(f.client.models(), error => {
      assert.equal(error.code, unavailable.code); assert.equal(error.message, unavailable.code);
      assert.equal(String(error.stack).includes(token), false); return true;
    });
  }
});

test("invalid successful JSON shapes are unavailable rather than a null success", async t => {
  for (const body of [null, [], {}, "text", 42]) {
    const f = await fixture(t, { request: async () => reply(body) });
    await assert.rejects(f.client.models(), unavailable);
  }
});

test("runtime startup and missing descriptors use the same safe unavailable error", async t => {
  const f = await fixture(t, { ensureReady: async () => { throw new Error(`startup ${token}`); } });
  await assert.rejects(f.client.models(), unavailable);
  const missing = await fixture(t); await rm(missing.runtimeFile);
  await assert.rejects(missing.client.models(), unavailable);
  assert.equal(missing.requests.length, 0);
});

test("nonloopback or credential-bearing descriptors never cause a request", async t => {
  for (const descriptor of [
    { baseUrl: "https://example.invalid/" }, { baseUrl: "http://192.0.2.1:53129/" },
    { baseUrl: "http://localhost:53129/" }, { baseUrl: "http://127.0.0.1:53129/private/" },
    { baseUrl: "http://user:password@127.0.0.1:53129/" }, { baseUrl: "http://127.0.0.1:53129/?key=synthetic" },
    { localToken: "" },
  ]) {
    const f = await fixture(t, { descriptor });
    await assert.rejects(f.client.models(), unavailable);
    assert.equal(f.requests.length, 0);
  }
});

test("pre-canceled calls never start the runtime or send a request", async t => {
  const f = await fixture(t), controller = new AbortController(); controller.abort();
  await assert.rejects(f.client.models({ signal: controller.signal }), { code: "SPACE_ANNOTATION_CANCELED" });
  assert.equal(f.readinessCalls, 0); assert.equal(f.requests.length, 0);
});

test("caller cancellation reaches an in-flight fetch and returns a safe cancellation code", async t => {
  const started = deferred(); let observed;
  const f = await fixture(t, { request: async (_url, input) => { observed = input.signal; started.resolve(); return new Promise((_resolve, reject) => input.signal.addEventListener("abort", () => reject(new Error(`aborted ${token}`)), { once: true })); } });
  const controller = new AbortController(), pending = f.client.models({ signal: controller.signal });
  await started.promise; controller.abort();
  await assert.rejects(pending, { code: "SPACE_ANNOTATION_CANCELED", message: "SPACE_ANNOTATION_CANCELED" });
  assert.equal(observed.aborted, true);
});

test("cancellation during JSON parsing withholds the late successful body", async t => {
  const started = deferred(), release = deferred();
  const f = await fixture(t, { request: async () => ({ ok: true, async json() { started.resolve(); await release.promise; return { available: true }; } }) });
  const controller = new AbortController(), pending = f.client.models({ signal: controller.signal });
  await started.promise; controller.abort(); release.resolve();
  await assert.rejects(pending, { code: "SPACE_ANNOTATION_CANCELED" });
});
