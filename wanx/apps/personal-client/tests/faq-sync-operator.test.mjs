import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
const script = new URL("../../../tools/verify-faq-sync.mjs", import.meta.url).href;
const base = "https://consumer.test/prod-api";
async function run(t, version, edition = "personal") {
  const directory = await mkdtemp(path.join(os.tmpdir(), "faq-operator-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "cache.json");
  await writeFile(file, JSON.stringify({ schema: 1,
    scope: createHash("sha256").update(`personal:${new URL(base).href}`).digest("hex").slice(0, 24),
    data: { version }, lastCheckedAt: 1000, updatedAt: 1000 }));
  const args = ["node", "verify", "--url", base + "/app-api/faq", "--cache-file", file, "--edition", edition];
  const code = `process.argv=${JSON.stringify(args)};
    globalThis.fetch=async(url,options)=>{
      if(url.pathname!=='/prod-api/app-api/faq'||options.redirect!=='error')throw Error('unexpected request');
      return new Response(JSON.stringify({code:200,data:{version:'faq-latest',answer:'must-not-be-printed'}}),{headers:{ETag:'W/"faq-latest"'}});
    }; await import(${JSON.stringify(script)});`;
  return spawnSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8", windowsHide: true });
}
test("operator confirms matching cache without printing FAQ text", async t => {
  const result = await run(t, "faq-latest"); assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).matches, true); assert.doesNotMatch(result.stdout, /must-not-be-printed/);
});
test("operator reports stale cache with failure exit status", async t => {
  const result = await run(t, "faq-old"); assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stdout).matches, false);
});
test("operator rejects comparing the wrong client edition", async t => {
  const result = await run(t, "faq-latest", "team"); assert.notEqual(result.status, 0);
  assert.match(result.stderr, /FAQ_CACHE_SCOPE_MISMATCH/);
});
