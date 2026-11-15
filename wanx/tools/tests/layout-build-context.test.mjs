import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../../", import.meta.url));
const posix = { skip: process.platform === "win32" };

function captureDocker(script, args = [], env = {}) {
  const temporary = mkdtempSync(path.join(os.tmpdir(), "wanx-layout-docker-"));
  try {
    const capture = path.join(temporary, "capture.json");
    writeFileSync(path.join(temporary, "docker"), `#!/usr/bin/env node
import("node:fs").then(({writeFileSync}) => writeFileSync(process.env.DOCKER_CAPTURE, JSON.stringify({args:process.argv.slice(2), cwd:process.cwd(), buildkit:process.env.DOCKER_BUILDKIT})));
`, { mode: 0o755 });
    const result = spawnSync("bash", [path.join(root, script), ...args], {
      cwd: temporary,
      encoding: "utf8",
      env: { ...process.env, ...env, PATH: `${temporary}${path.delimiter}${process.env.PATH}`, DOCKER_CAPTURE: capture },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return JSON.parse(readFileSync(capture, "utf8"));
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

function optionValues(args, option) {
  return args.flatMap((value, index) => value === option ? [args[index + 1]] : []);
}

test("Docker build wrapper uses the workspace context from any working directory", posix, () => {
  const call = captureDocker("octop/docker/docker_build.sh", ["wanx:layout-test", "--no-cache"], { NPM_REGISTRY: "https://registry.example.invalid" });
  assert.equal(call.args[0], "build");
  assert.equal(call.args.at(-1), root.replace(/\/$/, ""));
  assert.equal(call.cwd, root.replace(/\/$/, ""));
  assert.deepEqual(optionValues(call.args, "-f"), [path.join(root, "octop/docker/Dockerfile")]);
  assert.deepEqual(optionValues(call.args, "-t"), ["wanx:layout-test"]);
  assert.ok(call.args.includes("--no-cache"));
  assert.ok(optionValues(call.args, "--build-arg").includes("NPM_REGISTRY=https://registry.example.invalid"));
  assert.equal(call.buildkit, "1");
});

test("portable Docker packaging exposes only its required sibling inputs read-only", posix, () => {
  const call = captureDocker("octop/desktop/portable/package-linux-docker.sh", ["linux-arm64"]);
  assert.equal(call.args[0], "run");
  assert.deepEqual(optionValues(call.args, "-v"), [
    `${path.join(root, "octop")}:/src`,
    `${path.join(root, "apps/builder/backend/wanx_studio")}:/apps/builder/backend/wanx_studio:ro`,
    `${path.join(root, "shared/packages/local-data-gate")}:/shared/packages/local-data-gate:ro`,
    `${path.join(root, "server/bridge")}:/server/bridge:ro`,
  ]);
  assert.deepEqual(optionValues(call.args, "-w"), ["/src"]);
  assert.ok(optionValues(call.args, "-e").includes("GREEN_HOST_PLAT=linux-arm64"));
});

function localCopies() {
  let stage;
  let cwd = "/";
  const copies = [];
  for (const raw of readFileSync(path.join(root, "octop/docker/Dockerfile"), "utf8").split("\n")) {
    const line = raw.trim();
    if (line.startsWith("FROM ")) { stage = line.split(/\s+/).at(-1); cwd = "/"; }
    if (line.startsWith("WORKDIR ")) cwd = path.posix.resolve(cwd, line.slice(8).trim());
    if (!line.startsWith("COPY ") || line.startsWith("COPY --from=")) continue;
    const parts = line.slice(5).trim().split(/\s+/);
    const destination = path.posix.resolve(cwd, parts.pop());
    for (const source of parts) {
      assert.ok(existsSync(path.join(root, source)), `Docker COPY source missing: ${source}`);
      copies.push({ stage, source, destination });
    }
  }
  return copies;
}

test("portable wheel export resolves workspace dependencies without editable installs", posix, () => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), "wanx-portable-export-"));
  try {
    const capture = path.join(temporary, "calls.jsonl");
    writeFileSync(path.join(temporary, "uv"), `#!/usr/bin/env node
import("node:fs").then(({appendFileSync}) => appendFileSync(process.env.UV_CAPTURE, JSON.stringify({args:process.argv.slice(2), cwd:process.cwd()}) + "\\n"));
`, { mode: 0o755 });
    const result = spawnSync("bash", [path.join(root, "octop/desktop/portable/vendor-wheels.sh"), "linux-amd64"], {
      cwd: temporary,
      encoding: "utf8",
      env: { ...process.env, PATH: `${temporary}${path.delimiter}${process.env.PATH}`, UV_CAPTURE: capture, GREEN_ROOT: path.join(temporary, "portable") },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const calls = readFileSync(capture, "utf8").trim().split("\n").map(line => JSON.parse(line));
    const exported = calls.find(call => call.args[0] === "export");
    assert.ok(exported.args.includes("--no-editable"));
    assert.deepEqual(optionValues(exported.args, "--project"), [path.join(root, "octop")]);
    assert.ok(calls.every(call => call.cwd === path.join(root, "octop")), "local requirements must resolve relative to the Octop project");
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("Docker input closure supplies the dashboard archive, build hook and editable Builder backend", () => {
  const copies = localCopies();
  const dependency = JSON.parse(readFileSync(path.join(root, "octop/dashboard/package.json"), "utf8")).dependencies["centaurai-wanx"];
  const archive = path.posix.resolve("/build/dashboard", dependency.slice("file:".length));
  assert.ok(copies.some(copy => copy.stage === "frontend-builder" && copy.source === "vendor/" && archive.startsWith(copy.destination + "/")), "dashboard local archive must be copied into the frontend stage");

  const temporary = mkdtempSync(path.join(os.tmpdir(), "wanx-layout-stage-"));
  try {
    for (const copy of copies.filter(copy => copy.stage === "runtime" && ["octop/pyproject.toml", "octop/_build.py", "apps/builder/backend/wanx_studio", "server/bridge", "shared/packages/local-data-gate"].includes(copy.source))) {
      // Stage only build metadata: never copy local caches or virtual environments.
      const entry = copy.source.startsWith("octop/") ? "" : copy.source.includes("wanx_studio") ? "__init__.py" : "pyproject.toml";
      const source = path.join(root, copy.source, entry);
      const destination = path.join(temporary, copy.destination, entry || path.basename(copy.source));
      mkdirSync(path.dirname(destination), { recursive: true });
      writeFileSync(destination, readFileSync(source));
    }
    const python = spawnSync(process.platform === "win32" ? "python" : "python3", ["-c", `
import pathlib, runpy, sys, tomllib, types
root = pathlib.Path(sys.argv[1]) / "app"
module = types.ModuleType("hatchling.builders.hooks.plugin.interface")
module.BuildHookInterface = object
sys.modules[module.__name__] = module
hook_class = runpy.run_path(str(root / "_build.py"))["StudioDistributionHook"]
hook = hook_class()
hook.root = str(root)
hook.target_name = "wheel"
data = {"force_include": {}}
hook.initialize("standard", data)
assert data["force_include"], "Docker wheel omitted Builder backend"
source, target = next(iter(data["force_include"].items()))
assert target == "wanx_studio" and (pathlib.Path(source) / "__init__.py").is_file()
config = tomllib.loads((root / "pyproject.toml").read_text(encoding="utf-8"))
assert all((root / entry / "wanx_studio").is_dir() for entry in config["tool"]["hatch"]["build"]["targets"]["wheel"]["dev-mode-dirs"] if "builder" in entry)
pending, seen = [root], set()
while pending:
    project = pending.pop().resolve()
    if project in seen:
        continue
    seen.add(project)
    metadata = tomllib.loads((project / "pyproject.toml").read_text(encoding="utf-8"))
    dependencies = {entry.split("==")[0] for entry in metadata["project"]["dependencies"]}
    for name, source in metadata.get("tool", {}).get("uv", {}).get("sources", {}).items():
        if name in dependencies and "path" in source:
            local = (project / source["path"]).resolve()
            assert (local / "pyproject.toml").is_file(), f"Missing runtime dependency: {name} at {local}"
            pending.append(local)
`, temporary], { encoding: "utf8" });
    assert.equal(python.status, 0, python.stderr || python.stdout);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
