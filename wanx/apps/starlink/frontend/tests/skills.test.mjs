import assert from "node:assert/strict";
import { test } from "node:test";
import { skillRequest, skillUrl } from "../src/skills.ts";
test("credential is a header only; redirects and caches are disabled; multipart boundary is browser-owned", async () => {
  const original = globalThis.fetch; const calls = [];
  try {
    globalThis.fetch = async (url, init) => { calls.push({ url, init }); return new Response('{}'); };
    const signal = new AbortController().signal;
    await skillRequest("secret", skillUrl("default"), signal, { method: "POST", body: '{}' });
    const form = new FormData(); form.set("expected_revision", "2");
    await skillRequest("secret", skillUrl("default", "one", "/resources"), signal, { method: "POST", body: form });
    for (const { url, init } of calls) {
      assert.ok(!url.includes("secret")); assert.equal(init.headers.get("X-Skill-Admin-Token"), "secret");
      assert.equal(init.redirect, "error"); assert.equal(init.cache, "no-store");
    }
    assert.equal(calls[0].init.headers.get("Content-Type"), "application/json");
    assert.equal(calls[1].init.headers.get("Content-Type"), null);
    for (const url of ["https://other/api/skills", "//other/api/skills", "/api/settings", "/api/skills/../settings", "/api/skills/%2e%2e/settings", "/api/skills\\evil"]) {
      await assert.rejects(skillRequest("secret", url, signal), /地址无效/);
    }
    assert.equal(calls.length, 2);
  } finally { globalThis.fetch = original; }
});
test("conflicts preserve revision and issues; malformed HTTP errors do not expose raw response", async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({ detail: { code: "SKILL_REVISION_CONFLICT", message: "已变化", current_revision: 9, issues: [{ code: "MISSING", message: "缺失依赖", path: ["metadata"], severity: "error" }] } }), { status: 409 });
    await assert.rejects(skillRequest("secret", "/api/skills", new AbortController().signal), error => error.code === "SKILL_REVISION_CONFLICT" && error.currentRevision === 9 && error.issues[0].code === "MISSING");
    globalThis.fetch = async () => new Response("private-body", { status: 502 });
    await assert.rejects(skillRequest("secret", "/api/skills", new AbortController().signal), /HTTP 502/);
  } finally { globalThis.fetch = original; }
});

test("standalone management omits obsolete credentials", async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async (url, init) => {
      assert.equal(init.headers.has("X-Skill-Admin-Token"), false);
      return new Response('{}');
    };
    await skillRequest("", "/api/skills", new AbortController().signal,
      { headers: { "X-Skill-Admin-Token": "obsolete" } });
  } finally { globalThis.fetch = original; }
});
test("late response after session cancellation is never delivered to the editor", async () => {
  const original = globalThis.fetch; const controller = new AbortController();
  try {
    globalThis.fetch = async () => { controller.abort(); return new Response('{"old":"state"}'); };
    await assert.rejects(skillRequest("secret", "/api/skills", controller.signal), { name: "AbortError" });
  } finally { globalThis.fetch = original; }
});
