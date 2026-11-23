import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createZhijunMemmyRead } from "../shell/zhijun-memmy.mjs";

test("Zhijun reads just the chosen local Memmy source on each confirmed request", async t => {
  const root = await mkdtemp(join(tmpdir(), "zhijun-memmy-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtimeFile = join(root, "runtime.json");
  await writeFile(runtimeFile, JSON.stringify({ baseUrl: "http://127.0.0.1:12345/", localToken: "fixture" }));
  const calls = [];
  let choices = 0;
  let changed = false;
  const check = () => { if (changed) throw Error("scope changed"); };
  const read = createZhijunMemmyRead({
    runtimeFile,
    async confirm() {
      choices++;
      return choices !== 1;
    },
    async request(url, options) {
      assert.equal(url.pathname, "/api/v1/panel/browse");
      assert.equal(options.redirect, "error");
      calls.push(JSON.parse(options.body));
      return new Response(JSON.stringify({ viewId: "fixture", items: [{ title: "Example", sourceText: "Only approved evidence" }] }));
    },
  });
  const signal = new AbortController().signal;
  const input = { query: "Example", source: "claude_code" };
  assert.equal((await read(input, check, signal)).canceled, true);
  assert.deepEqual(calls, []);
  assert.deepEqual((await read(input, check, signal)).items.map(item => item.source), ["Claude Code"]);
  assert.deepEqual(calls[0], { op: "create", filter: { sourceAgent: "claude_code", q: "Example", status: "active" } });
  assert.deepEqual(calls[1], { op: "release", viewId: "fixture" });

  changed = true;
  await assert.rejects(read(input, check, signal), /scope changed/);
  changed = false;
  await assert.rejects(read({ ...input, source: "all" }, check, signal), { code: "ASSISTANT_INVALID_INPUT" });
  const canceled = new AbortController();
  canceled.abort();
  await assert.rejects(read(input, check, canceled.signal), { name: "AbortError" });
  assert.equal(calls.length, 2);
});
