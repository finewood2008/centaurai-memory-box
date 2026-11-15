import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// Exercise the shell entry without compiling native binaries, signing, or notarizing.
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "wanx package entry "));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bash = spawnSync("bash", ["-c", 'printf "%s" "$BASH"'], { encoding: "utf8" });
  assert.ifError(bash.error);
  assert.equal(bash.status, 0, bash.stderr);
  for (const [directory, edition] of [["personal-client", "personal"], ["team-client", "team"]]) {
    await mkdir(path.join(root, "apps", directory, "tools"), { recursive: true });
    await writeFile(path.join(root, "apps", directory, "tools/package-client.mjs"), `
      console.log(JSON.stringify({ edition: ${JSON.stringify(edition)}, args: process.argv.slice(2), cwd: process.cwd() }));
      if (process.env.FAIL_EDITION === ${JSON.stringify(edition)}) process.exit(23);
    `);
  }
  const entry = path.join(root, "package-client.sh");
  const legacy = path.join(root, "apps/personal-client/package-client.sh");
  await copyFile(new URL("../../../package-client.sh", import.meta.url), entry);
  await copyFile(new URL("../package-client.sh", import.meta.url), legacy);
  const run = (args, env = {}, { original = false, cwd = os.tmpdir() } = {}) => {
    const result = spawnSync(bash.stdout, [original ? legacy : entry, ...args], {
      cwd, encoding: "utf8", env: { ...process.env, WANX_NOTARY_PROFILE: "", ...env },
    });
    assert.ifError(result.error);
    const records = result.stdout.split("\n").filter(line => line.startsWith("{")).map(line => JSON.parse(line));
    return { ...result, records, calls: records.map(({ edition, args }) => ({ edition, args })) };
  };
  run.root = root;
  run.bash = bash.stdout;
  return run;
}

const options = { skip: process.platform === "win32" ? "macOS Bash packaging entry" : false };
const buildArgs = ["--version", "1.0.1", "--arch", "arm64", "--local"];

test("workspace root invocation packages personal and preserves argument boundaries", options, async t => {
  const run = await fixture(t);
  const args = [...buildArgs, "--trust-file", "keys/update trust.json"];
  const result = run(args);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.calls, [{ edition: "personal", args }]);
});

test("workspace and original apps entries preserve external cwd and relative paths with spaces", options, async t => {
  const run = await fixture(t);
  const caller = await realpath(await mkdtemp(path.join(os.tmpdir(), "wanx package caller ")));
  t.after(() => rm(caller, { recursive: true, force: true }));
  const args = [...buildArgs, "--trust-file", "keys/update trust.json", "--out", "client packages"];
  for (const original of [false, true]) {
    const result = run(["--edition=all", ...args], {}, { original, cwd: caller });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.calls, ["personal", "team"].map(edition => ({
      edition, args: [...args.slice(0, -1), `client packages/${edition}`],
    })));
    assert.ok(result.records.every(record => record.cwd === caller));
  }
});

test("edition selects the client without forwarding the selector to its packager", options, async t => {
  const run = await fixture(t);
  for (const selector of [["--edition", "personal"], ["--edition", "team"], ["--edition=team"]]) {
    const edition = selector.at(-1).endsWith("team") ? "team" : "personal";
    const args = [...buildArgs, "--channel", edition === "team" ? "beta-studio" : "beta"];
    const result = run([...args, ...selector]);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.calls, [{ edition, args }]);
  }
});

test("all builds both clients sequentially using their own default channels and output roots", options, async t => {
  const run = await fixture(t);
  const result = run(["--edition", "all", ...buildArgs]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.calls, [
    { edition: "personal", args: buildArgs }, { edition: "team", args: buildArgs },
  ]);
});

test("all splits an explicit output directory while a single edition keeps it", options, async t => {
  const run = await fixture(t);
  for (const out of [["--out", "release/client packages"], ["--out=release/client packages"]]) {
    const result = run(["--edition=all", ...buildArgs, ...out]);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.calls, [
      { edition: "personal", args: [...buildArgs, ...(out.length === 1 ? ["--out=release/client packages/personal"] : ["--out", "release/client packages/personal"])] },
      { edition: "team", args: [...buildArgs, ...(out.length === 1 ? ["--out=release/client packages/team"] : ["--out", "release/client packages/team"])] },
    ]);
  }
  const result = run(["--edition=team", ...buildArgs, "--out", "release/client packages"]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.calls, [{ edition: "team", args: [...buildArgs, "--out", "release/client packages"] }]);
});

test("output options keep their position before -- and preserve inline values starting with hyphens", options, async t => {
  const run = await fixture(t);
  for (const args of [[...buildArgs, "--out", "release", "--"], [...buildArgs, "--out=--release"]]) {
    const result = run(args);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.calls, [{ edition: "personal", args }]);
  }
  const result = run(["--edition=all", ...buildArgs, "--out=--release", "--"]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.calls, [
    { edition: "personal", args: [...buildArgs, "--out=--release/personal", "--"] },
    { edition: "team", args: [...buildArgs, "--out=--release/team", "--"] },
  ]);
});

test("invalid selectors and conflicting all channels fail before starting a build", options, async t => {
  const run = await fixture(t);
  for (const args of [
    ["--edition"], ["--edition="], ["--edition", "enterprise"],
    ["--edition=all", "--channel", "stable"], ["--edition=all", "--channel=stable-studio"],
    ["--edition=all", "--out"], ["--edition=all", "--out="],
  ]) {
    const result = run(args);
    assert.notEqual(result.status, 0, JSON.stringify(args));
    assert.deepEqual(result.calls, []);
    assert.ok(result.stderr.trim());
  }
});

test("all stops on failure and propagates either client exit status", options, async t => {
  const run = await fixture(t);
  for (const edition of ["personal", "team"]) {
    const result = run(["--edition=all", ...buildArgs], { FAIL_EDITION: edition });
    assert.equal(result.status, 23, result.stderr);
    assert.deepEqual(result.calls.map(call => call.edition), edition === "personal" ? ["personal"] : ["personal", "team"]);
  }
});

test("help documents edition selection without invoking a packager", options, async t => {
  const run = await fixture(t);
  const result = run(["--edition=all", "--help"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /--edition personal\|team\|all/);
  assert.match(result.stdout, /--formal/);
  assert.deepEqual(result.calls, []);
});

test("workspace and original apps help work without Node or installed dependencies", options, async t => {
  const run = await fixture(t);
  const bin = path.join(run.root, "utilities without node");
  await mkdir(bin);
  await symlink(run.bash, path.join(bin, "bash"));
  for (const utility of ["dirname", "cat"]) {
    const resolved = spawnSync(run.bash, ["-c", 'command -v "$1"', "fixture", utility], { encoding: "utf8" });
    assert.equal(resolved.status, 0, resolved.stderr);
    await symlink(resolved.stdout.trim(), path.join(bin, utility));
  }
  const env = { PATH: bin };
  assert.equal(spawnSync(run.bash, ["-c", "command -v node"], { env }).status, 1);
  for (const original of [false, true]) {
    const result = run(["--help"], env, { original });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.calls, []);
    assert.match(result.stdout, /\.\/package-client\.sh/);
    for (const option of ["--arch", "--out", "--channel", "--security-epoch", "--test", "--test-run-id", "--test-feed-url", "--test-ca"])
      assert.ok(result.stdout.includes(option), `help must document ${option}`);
  }
});

test("formal mode supplies notarization and trust defaults to both editions before the argument terminator", options, async t => {
  const run = await fixture(t);
  const args = ["--version", "1.0.1", "--arch", "arm64", "--out", "release packages", "--"];
  const defaults = ["--notary-profile", "WANX-NOTARY", "--trust-file", path.join(os.homedir(), ".config/wanx-release/wanx-client-trust.json")];
  const result = run(["--formal", "--edition=all", ...args]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.calls, ["personal", "team"].map(edition => ({
    edition, args: [...defaults, ...args.slice(0, -2), `release packages/${edition}`, "--"],
  })));
});

test("formal mode honors explicit and environment notarization settings", options, async t => {
  const run = await fixture(t);
  for (const overrides of [
    ["--notary-profile", "Company Profile", "--trust-file", "keys/production trust.json"],
    ["--notary-profile=Company Profile", "--trust-file=keys/production trust.json"],
  ]) {
    const args = ["--version", "1.0.1", ...overrides];
    const result = run([...args, "--formal"], { WANX_NOTARY_PROFILE: "Environment Profile" });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.calls, [{ edition: "personal", args }]);
  }
  const result = run(["--formal", "--trust-file", "production.json"], { WANX_NOTARY_PROFILE: "Environment Profile" });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.calls, [{ edition: "personal", args: ["--notary-profile", "Environment Profile", "--trust-file", "production.json"] }]);
});

test("formal mode rejects local and test modes and empty overrides before building", options, async t => {
  const run = await fixture(t);
  for (const args of [["--formal", "--local"], ["--local", "--formal"], ["--formal", "--test"],
    ["--formal", "--notary-profile="], ["--formal", "--trust-file="]]) {
    const result = run(args);
    assert.notEqual(result.status, 0, JSON.stringify(args));
    assert.deepEqual(result.calls, []);
  }
});

test("formal mode propagates packager failure without retrying a local build", options, async t => {
  const run = await fixture(t);
  const result = run(["--formal", "--edition=all"], { FAIL_EDITION: "personal" });
  assert.equal(result.status, 23, result.stderr);
  assert.equal(result.calls.length, 1);
  assert.ok(!result.calls[0].args.includes("--local"));
});
