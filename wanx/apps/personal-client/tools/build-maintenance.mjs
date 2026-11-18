import { brandMemoboxTree } from "../../builder/tools/memobox-branding.mjs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const output = fileURLToPath(new URL("../build/app/local-ui/maintenance/", import.meta.url));
const result = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "build:maintenance", "--", "--outDir", output], {
  cwd: fileURLToPath(new URL("../../../octop/dashboard/", import.meta.url)),
  stdio: "inherit",
  shell: process.platform === "win32",
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;

if (result.status === 0) await brandMemoboxTree(output);
