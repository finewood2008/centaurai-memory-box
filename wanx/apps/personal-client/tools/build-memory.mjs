import { existsSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const client = fileURLToPath(new URL("../", import.meta.url));
const source = process.env.WANX_MEMORY_BOX_ROOT?.trim();
const output = path.join(client, "local-ui", "memory");
if (!source) {
  if (!existsSync(path.join(output, "wanx-memory.html"))) {
    console.log("Set WANX_MEMORY_BOX_ROOT to the private memory box checkout to build the memory workspace.");
  }
} else {
  const root = path.resolve(source);
  const renderer = path.join(root, "App", "frontend", "desktop");
  const vite = path.join(root, "node_modules", "vite", "bin", "vite.js");
  if (!existsSync(path.join(renderer, "wanx-memory.html")) || !existsSync(vite)) {
    throw new Error("The private memory box checkout is missing the WanX entry or its frontend dependencies.");
  }
  execFileSync(process.execPath, [vite, "build", "--mode", "wanx-memory", "--outDir", output, "--emptyOutDir"], {
    cwd: renderer,
    stdio: "inherit",
  });
  writeFileSync(path.join(output, ".wanx-source"), root + "\n");
}
