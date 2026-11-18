import { networkSourceDigest } from "./netbird-status-build.mjs";
import path from "node:path";
import { access, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const name = `wanx-netbird-${process.platform}-${process.arch}${
  process.platform === "win32" ? ".exe" : ""
}`;
try {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const stamp = JSON.parse(await readFile(path.join(root, "native/bin", `${name}.sources.json`), "utf8"));
  if (stamp.sourceDigest !== await networkSourceDigest(root)) throw new Error("Embedded network sources changed");
  await access(path.join(root, "native/bin", name));
} catch {
  // Development only: packaged clients contain a prebuilt native engine.
  console.log("Building WANX's embedded network engine for current sources…");
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL("./build-network.mjs", import.meta.url))],
    { stdio: "inherit" },
  );
  await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0
        ? resolve()
        : reject(new Error("Embedded network build failed")),
    );
  });
}
