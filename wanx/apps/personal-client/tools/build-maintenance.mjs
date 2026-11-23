import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { npmCommand } from "../../../tools/npm-command.mjs";

const output = fileURLToPath(new URL("../build/app/local-ui/maintenance/", import.meta.url));
const windows = process.platform === "win32";
const args = ["run", "build:maintenance", "--", "--outDir", output];
if (windows && process.env.npm_lifecycle_event === "prestart") {
  // The local Electron renderer can run Rollup's modern output directly.
  // Skip the concurrent final esbuild transforms during desktop startup.
  args.push("--target", "esnext", "--minify", "false");
}
const result = spawnSync(...npmCommand(args), {
  cwd: fileURLToPath(new URL("../../../octop/dashboard/", import.meta.url)),
  stdio: "inherit",
  // Vite can send multiple large chunks to esbuild at once during rendering.
  env: windows ? {
    ...process.env,
    GOMAXPROCS: process.env.GOMAXPROCS || "2",
    GOMEMLIMIT: process.env.GOMEMLIMIT || "256MiB",
  } : process.env,
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;

if (result.status === 0) {
  const { brandMemoboxTree } = await import("../../builder/tools/memobox-branding.mjs");
  await brandMemoboxTree(output);
}
