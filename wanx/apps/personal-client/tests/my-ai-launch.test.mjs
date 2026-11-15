import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createMyAiLauncher } from "../shell/my-ai-launch.mjs";
import { runLaunchReview } from "../shell/my-ai-launch-review.mjs";

async function fixture(t, options = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "my-ai-launch-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const opened = [];
  let scope = "owner/box/session";
  const launcher = createMyAiLauncher({ directory: path.join(root, "pending"), executable: process.execPath, platform: "darwin",
    openFile: async file => { opened.push(file); return ""; }, getScope: () => scope, ...options });
  t.after(() => launcher.close());
  const prompt = "--yolo $(touch should-not-exist) `echo secret` \"quoted\"\n你好\u001b]52;clipboard";
  const prepare = () => launcher.prepare({ agent: "Gemini CLI", executable: process.execPath, cwd: root, args: ["--", prompt], prompt, resources: "Test folder" });
  return { root, opened, launcher, prompt, prepare, switchScope(value) { scope = value; } };
}

const successfulChild = (...args) => {
  const child = new EventEmitter();
  process.nextTick(() => child.emit("exit", 0));
  return child;
};

test("launcher stages a private literal payload and does not start any CLI before terminal confirmation", async t => {
  const h = await fixture(t);
  assert.deepEqual(await h.prepare(), { opened: true, prepared: true, delivery: "terminal-confirm" });
  const file = h.opened[0].replace(/\.command$/, ".json");
  const task = JSON.parse(await readFile(file, "utf8"));
  assert.equal(task.prompt, h.prompt);
  assert.deepEqual(task.args, ["--", h.prompt]);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal((await stat(h.opened[0])).mode & 0o777, 0o700);
  const script = await readFile(h.opened[0], "utf8");
  assert.doesNotMatch(script, /yolo|should-not-exist|clipboard/);
  assert.match(script, /ELECTRON_RUN_AS_NODE=1/);
  let release;
  const answer = new Promise(resolve => { release = resolve; });
  const spawned = [], output = [];
  const run = runLaunchReview(file, {
    question: async () => answer, output: { write: value => { output.push(value); } },
    spawnChild(...args) { spawned.push(args); return successfulChild(); },
  });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(spawned.length, 0);
  release("");
  assert.deepEqual(await run, { started: true, exitCode: 0 });
  assert.deepEqual(spawned[0][1], ["--", h.prompt]);
  assert.equal(spawned[0][2].shell, false);
  assert.equal(spawned[0][2].env.ELECTRON_RUN_AS_NODE, undefined);
  assert.doesNotMatch(output.join(""), /\u001b/);
  await assert.rejects(readFile(file), { code: "ENOENT" });
});

test("cancel, expiration, and changing the signed-in scope all prevent CLI execution", async t => {
  const canceled = await fixture(t);
  await canceled.prepare();
  const file = canceled.opened[0].replace(/\.command$/, ".json");
  assert.deepEqual(await runLaunchReview(file, { question: async () => "cancel", output: { write() {} }, spawnChild: () => assert.fail("must not spawn") }), { started: false, canceled: true });

  let now = Date.now();
  const expired = await fixture(t, { now: () => now, lifetime: 100 });
  await expired.prepare();
  now += 101;
  await assert.rejects(runLaunchReview(expired.opened[0].replace(/\.command$/, ".json"), {
    now: () => now, question: async () => "", output: { write() {} }, spawnChild: () => assert.fail("must not spawn"),
  }), /过期/);

  const switched = await fixture(t);
  await switched.prepare();
  switched.switchScope("different-owner/box/session");
  await assert.rejects(runLaunchReview(switched.opened[0].replace(/\.command$/, ".json"), {
    question: async () => "", output: { write() {} }, spawnChild: () => assert.fail("must not spawn"),
  }), /授权已撤销/);
});

test("closed launcher withdraws pending payloads and invalid workspaces never produce a terminal task", async t => {
  const h = await fixture(t);
  await h.prepare();
  await h.launcher.close();
  await assert.rejects(readFile(h.opened[0]), { code: "ENOENT" });
  await assert.rejects(h.prepare(), /连接/);
  const invalid = await fixture(t);
  await assert.rejects(invalid.launcher.prepare({ executable: process.execPath, cwd: "relative", args: [], prompt: "test" }), /无效/);
  assert.equal(invalid.opened.length, 0);
});
