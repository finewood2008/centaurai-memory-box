import test from "node:test";
import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { clientBuildSource } from "../tools/package-client-source.mjs";

const clientRoot = fileURLToPath(new URL("../", import.meta.url));
const manifest = JSON.parse(await readFile(path.join(clientRoot, "package.json"), "utf8"));
const outputNames = ["device-setup.bundle.js", "wallet.bundle.js"];

async function fixture(directory, alwaysStrict) {
  const parent = path.dirname(directory);
  await mkdir(path.join(directory, "local-ui/renderer"), { recursive: true });
  await mkdir(path.join(directory, "tools"), { recursive: true });
  await writeFile(path.join(parent, "tsconfig.json"), JSON.stringify({ compilerOptions: { alwaysStrict } }));
  await writeFile(path.join(directory, "package.json"), JSON.stringify({
    name: "renderer-source-fixture", version: "1.0.0", private: true, type: "module",
    scripts: { "build:studio": 'node -e "void 0"', "build:renderer": manifest.scripts["build:renderer"] },
  }));
  await writeFile(path.join(directory, ".gitignore"), "/node_modules\n");
  await writeFile(path.join(directory, "local-ui/renderer/device-setup-entry.ts"),
    'const message: string = "renderer fixture"; globalThis.rendererFixture = message;\n');
  await writeFile(path.join(directory, "local-ui/renderer/wallet-entry.mjs"),
    'import QRCode from "qrcode"; globalThis.rendererFixtureQR = QRCode.toString;\n');
  await symlink(path.join(clientRoot, "node_modules"), path.join(directory, "node_modules"),
    process.platform === "win32" ? "junction" : "dir");
  try {
    await copyFile(path.join(clientRoot, "tools/renderer-tsconfig.json"), path.join(directory, "tools/renderer-tsconfig.json"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    // Before the fix the real build command does not reference this configuration.
  }
  return directory;
}

function build(directory) {
  execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "build:renderer"], {
    cwd: directory, encoding: "utf8", stdio: "pipe", timeout: 30_000,
    shell: process.platform === "win32",
  });
}

async function outputs(directory) {
  return Promise.all(outputNames.map(name => readFile(path.join(directory, "local-ui/renderer", name), "utf8")));
}

test("renderer rebuilds stay identical across checkout paths and ambient TypeScript settings", async t => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "wanx-renderer-source-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const first = await fixture(path.join(temporary, "first", "client"), true);
  const second = await fixture(path.join(temporary, "second", "nested", "client"), false);
  build(first);
  build(second);
  const firstOutput = await outputs(first);
  const secondOutput = await outputs(second);
  for (const [index, name] of outputNames.entries()) {
    assert.equal(firstOutput[index], secondOutput[index], `${name} must not depend on checkout depth or a parent tsconfig`);
    assert.ok(!firstOutput[index].includes(clientRoot), `${name} must not expose the build checkout`);
    assert.ok(!firstOutput[index].includes(temporary), `${name} must not expose a temporary build root`);
    assert.ok(!/^  \/\/ (?:\.\.\/)+/m.test(firstOutput[index]), `${name} module paths must stay inside the logical client root`);
  }
});

test("renderer rebuild keeps committed source clean while real entry edits still block formal packaging", async t => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "wanx-renderer-gate-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const directory = await fixture(path.join(temporary, "client"), true);
  build(directory);
  const git = args => execFileSync("git", args, { cwd: directory, encoding: "utf8" }).trim();
  git(["init", "-q"]);
  git(["add", "."]);
  git(["-c", "user.name=Renderer Fixture", "-c", "user.email=renderer@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "fixture"]);
  const committed = clientBuildSource(directory);
  await writeFile(path.join(temporary, "tsconfig.json"), JSON.stringify({ compilerOptions: { alwaysStrict: false } }));
  build(directory);
  assert.deepEqual(clientBuildSource(directory), committed,
    "a renderer rebuild must not turn an otherwise committed release source dirty");
  await writeFile(path.join(directory, "local-ui/renderer/wallet-entry.mjs"),
    'globalThis.rendererFixtureQR = "real source modification";\n');
  assert.throws(() => clientBuildSource(directory), /CLIENT_SOURCE_TREE_DIRTY/);
});

test("generated artwork metadata stays outside source proof while canonical metadata remains protected", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "wanx-renderer-metadata-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const client = path.join(directory, "apps/personal-client");
  const records = ["material-v1/manifest.json", "section-icons-v2/prompts.json"].map(name => ({
    canonical: path.join(directory, "apps/builder/integration/personal-client/assets", name),
    generated: path.join(client, "local-ui/renderer/assets", name),
  }));
  await copyFile(path.join(clientRoot, "../../.gitignore"), path.join(directory, ".gitignore"));
  for (const record of records) for (const file of [record.canonical, record.generated]) {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "{}\n");
  }
  const git = args => execFileSync("git", args, { cwd: directory, encoding: "utf8" }).trim();
  git(["init", "-q"]);
  git(["add", "."]);
  git(["-c", "user.name=Renderer Fixture", "-c", "user.email=renderer@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "fixture"]);
  const committed = clientBuildSource(client);
  for (const record of records) {
    assert.ok(git(["ls-files", "--", path.relative(directory, record.canonical)]));
    assert.equal(git(["ls-files", "--", path.relative(directory, record.generated)]), "");
    await writeFile(record.generated, '{"copied":true}\n');
    assert.deepEqual(clientBuildSource(client), committed);
    await writeFile(record.canonical, '{"sourceChanged":true}\n');
    assert.throws(() => clientBuildSource(client), /CLIENT_SOURCE_TREE_DIRTY/);
    await writeFile(record.canonical, "{}\n");
  }
  await writeFile(path.join(client, "local-ui/renderer/assets/material-v1/unreviewed.json"), "{}\n");
  assert.throws(() => clientBuildSource(client), /CLIENT_SOURCE_TREE_DIRTY/);
});
