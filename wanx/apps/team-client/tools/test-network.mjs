import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createStatusBuild } from "../../personal-client/tools/netbird-status-build.mjs";
const native = fileURLToPath(new URL("../native/", import.meta.url));
const statusBuild = await createStatusBuild(native);
try {
  const code = await new Promise((resolve, reject) => {
    const child = spawn("go", ["test", `-modfile=${statusBuild.modfile}`, ...process.argv.slice(2), "./..."], { cwd: native, stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", code => resolve(code ?? 1));
  });
  process.exitCode = code;
} finally { await statusBuild.close(); }
