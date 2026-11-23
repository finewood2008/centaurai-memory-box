import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import electron from "electron";

async function runSidebarFixture(t, notesOnly = false) {
  const profile = await mkdtemp(join(tmpdir(), "wanx-sidebar-"));
  t.after(() => rm(profile, { recursive: true, force: true }));
  const fixture = fileURLToPath(new URL("./support/electron-sidebar.mjs", import.meta.url));
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  if (notesOnly) env.WANX_SIDEBAR_NOTES_ONLY = "1";
  try {
    const { stdout } = await promisify(execFile)(electron, [fixture, `--user-data-dir=${profile}`], {
      env,
      timeout: 60_000,
    });
    assert.match(stdout, /WANX_SIDEBAR_UI_PASS/);
  } catch (error) {
    if (error.stderr) t.diagnostic(error.stderr);
    throw error;
  }
}

const options = { skip: process.env.WANX_TEST_ELECTRON !== "1", timeout: 40_000 };
test("The personal window shares the right sidebar without losing notes or conversation state",
  options, t => runSidebarFixture(t));
test("Shared notes can be created, switched and deleted without changing the original",
  options, t => runSidebarFixture(t, true));
