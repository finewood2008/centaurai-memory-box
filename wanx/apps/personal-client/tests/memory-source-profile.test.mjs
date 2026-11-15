import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { memoryLibraries, readMemoryLibrary, memoryLibraryRuntime, saveMemoryLibrary } from "../shell/memory-source-profile.mjs";

test("all historical source selections expose one local mixed collection mode without discarding their storage", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "memobox-unified-profile-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.deepEqual(memoryLibraries, [{ id: "legacy", name: "本机记忆库" }]);
  for (const id of ["codex-desktop", "codex-cli", "legacy"]) {
    await writeFile(path.join(root, "memory-library"), id);
    const library = await readMemoryLibrary(root);
    assert.equal(library.id, "legacy");
    const original = { MEMMY_HOME: "/synthetic/current-store", MEMMY_ISOLATED_CODEX_PROFILE: "codex-desktop" };
    const runtime = memoryLibraryRuntime(library, root, original);
    assert.equal(runtime.env.MEMMY_ISOLATED_CODEX_PROFILE, undefined);
    assert.equal(runtime.env.MEMMY_UNIFY_AGENT_SOURCES, "1");
    assert.equal(original.MEMMY_ISOLATED_CODEX_PROFILE, "codex-desktop");
    assert.equal(runtime.env.MEMMY_HOME, id === "legacy" ? original.MEMMY_HOME : path.join(root, "memory-libraries", id, "memory"));
  }
  await assert.rejects(saveMemoryLibrary(root, "codex-cli"), /不按智能体分库/);
});

test("a mixed selection keeps its existing API layout even when memory home was historically pinned", () => {
  const userData = "/synthetic/profile";
  const home = path.join(userData, "memory-libraries/codex-desktop/memory");
  const runtime = memoryLibraryRuntime({ id: "legacy", name: "本机记忆库" }, userData, { MEMMY_HOME: home, MEMMY_ISOLATED_CODEX_PROFILE: "codex-desktop" });
  assert.equal(runtime.root, undefined);
  assert.equal(runtime.env.MEMMY_HOME, home);
  assert.equal(runtime.env.MEMMY_MEMORY_HOME, path.join(home, "memory-service"));
  assert.equal(runtime.env.MEMMY_ISOLATED_CODEX_PROFILE, undefined);
});
