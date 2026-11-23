import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, writeFile, rm, readdir, cp, chmod, mkdir, rename } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
const execute = promisify(execFile);

// NetBird 0.80's embed.Status synchronously probes remote services before
// reading its thread-safe local recorder. Keep those probes single-flight in
// the background; the recorder continues to receive live control/peer events.
// Stage the patched SDK only for this build: never mutate the module cache or
// vendor a second source tree. Go 1.26 disallows overlays inside GOMODCACHE.
export function patchStatusSource(source) {
  const signature = "func (c *Client) Status() (peer.FullStatus, error) {";
  const start = source.indexOf(signature);
  const end = source.indexOf("\n}", start) + 2;
  const original = `func (c *Client) Status() (peer.FullStatus, error) {
 c.mu.Lock()
 connect := c.connect
 c.mu.Unlock()
 if connect != nil {
  engine := connect.Engine()
  if engine != nil {
   _ = engine.RunHealthProbes(context.Background(), false)
  }
 }
 return c.recorder.GetFullStatus(), nil
}`;
  const normalize = value => value.replace(/\s+/g, "");
  if (start < 0 || end < start || normalize(source.slice(start, end)) !== normalize(original) ||
      !/\bmu\s+sync\.Mutex\b/.test(source))
    throw new Error("Unsupported NetBird embed.Status source; review the pinned SDK overlay");
  const replacement = `func (c *Client) Status() (peer.FullStatus, error) {
 c.mu.Lock()
 connect := c.connect
 if connect != nil && !c.statusProbeRunning {
  c.statusProbeRunning = true
  go func() {
   defer func() { c.mu.Lock(); c.statusProbeRunning = false; c.mu.Unlock() }()
   if engine := connect.Engine(); engine != nil {
    // RunHealthProbes also observes the engine lifetime context, so Stop
    // cancels an in-flight probe. Only the health probe moves off this read.
    _ = engine.RunHealthProbes(context.Background(), false)
   }
  }()
 }
 c.mu.Unlock()
 return c.recorder.GetFullStatus(), nil
}`;
  return (source.slice(0, start) + replacement + source.slice(end))
    .replace(/(\bmu\s+sync\.Mutex\b)/, "$1\n statusProbeRunning bool");
}

export async function createStatusBuild(nativeDirectory) {
  const { stdout } = await execute("go", ["list", "-mod=readonly", "-m", "-f", "{{.Dir}}", "github.com/netbirdio/netbird"], { cwd: nativeDirectory });
  const original = stdout.trim();
  const patched = patchStatusSource(await readFile(path.join(original, "client/embed/embed.go"), "utf8"));
  // A content-addressed build directory avoids absolute/random replacement
  // paths in Go's module build information and is safe for concurrent builds.
  const build = path.resolve(nativeDirectory, "../build/native-network");
  await mkdir(build, { recursive: true });
  const digest = createHash("sha256").update(patched).update(await readFile(path.join(original, "go.mod"))).digest("hex");
  const sdk = path.join(build, `sdk-${digest}`);
  const replacement = path.join(sdk, "client/embed/embed.go");
  if (await readFile(replacement, "utf8").catch(() => null) !== patched) {
    const stage = await mkdtemp(path.join(build, "staging-"));
    try {
      await cp(original, stage, { recursive: true });
      // Module-cache directory permissions are read-only too; the private
      // build copy must remain removable without changing the original.
      async function writableDirectories(directory) {
        await chmod(directory, 0o755);
        for (const entry of await readdir(directory, { withFileTypes: true }))
          if (entry.isDirectory()) await writableDirectories(path.join(directory, entry.name));
      }
      await writableDirectories(stage);
      await chmod(path.join(stage, "client/embed/embed.go"), 0o644);
      await writeFile(path.join(stage, "client/embed/embed.go"), patched);
      try { await rename(stage, sdk); }
      catch (error) { if (!["EEXIST", "ENOTEMPTY"].includes(error.code)) throw error; }
    } finally { await rm(stage, { recursive: true, force: true }); }
    if (await readFile(replacement, "utf8") !== patched) throw new Error("Invalid staged NetBird SDK");
  }
  const temporary = await mkdtemp(path.join(build, "invocation-"));
  try {
    const modfile = path.join(temporary, "native.mod");
    const relative = path.relative(nativeDirectory, sdk).split(path.sep).join("/");
    await writeFile(modfile, `${await readFile(path.join(nativeDirectory, "go.mod"), "utf8")}\nreplace github.com/netbirdio/netbird => ${JSON.stringify(relative)}\n`);
    await writeFile(path.join(temporary, "native.sum"), await readFile(path.join(nativeDirectory, "go.sum")));
    return { modfile, close: () => rm(temporary, { recursive: true, force: true }) };
  } catch (error) { await rm(temporary, { recursive: true, force: true }); throw error; }
}

// Development launch must rebuild an existing engine when native sources or
// the SDK overlay change. Generated binaries and notices are not hash inputs.
export async function networkSourceDigest(root) {
  const hash = createHash("sha256");
  async function tree(directory) {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a,b)=>a.name.localeCompare(b.name))) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await tree(file);
      else if (entry.name.endsWith(".go")) { hash.update(path.relative(root,file)); hash.update(await readFile(file)); }
    }
  }
  await tree(path.join(root, "native/cmd"));
  for (const file of ["native/go.mod", "native/go.sum", "tools/build-network.mjs"]) hash.update(await readFile(path.join(root, file)));
  hash.update(await readFile(fileURLToPath(import.meta.url)));
  return hash.digest("hex");
}
