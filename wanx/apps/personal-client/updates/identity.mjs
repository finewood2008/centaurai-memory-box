import { createHash } from "node:crypto";
import childProcess from "node:child_process";
import { readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { testPackageIdentity } from "./test-build.mjs";
import { validClientEdition } from "./edition.mjs";

async function windowsProductType(osVersion, execFile) {
  const build = /^10\.0\.([0-9]+)(?:\.[0-9]+)?$/.exec(osVersion)?.[1];
  if (!build || !Number.isSafeInteger(Number(build))) return 0;
  const powershell = path.win32.join(process.env.SystemRoot || "C:\\Windows",
    "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const script = "$ErrorActionPreference = 'Stop'; Get-CimInstance -ClassName Win32_OperatingSystem | Select-Object ProductType, BuildNumber | ConvertTo-Json -Compress";
  try {
    const result = await new Promise((resolve, reject) => {
      execFile(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
        { windowsHide: true, timeout: 5000, maxBuffer: 16 * 1024 }, (error, stdout, stderr) => {
          if (error || stderr?.trim()) reject(error || new Error("Windows system probe failed"));
          else {
            try { resolve(JSON.parse(stdout)); } catch (error) { reject(error); }
          }
        });
    });
    return [1, 2, 3].includes(result?.ProductType) && typeof result.BuildNumber === "string" &&
      /^[0-9]+$/.test(result.BuildNumber) && Number(result.BuildNumber) === Number(build) ? result.ProductType : 0;
  } catch { return 0; }
}

export async function readClientIdentity({ app, platform = process.platform, arch = process.arch, versions = process.versions,
  osRelease = os.release, getSystemVersion = () => process.getSystemVersion?.(), execFile = childProcess.execFile }) {
  const root = app.getAppPath();
  const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  if (!validClientEdition(pkg.wanxEdition)) throw new Error("UPDATE_CLIENT_EDITION_INVALID");
  const edition = pkg.wanxEdition;
  const build = pkg.wanxBuild || {};
  const testIdentity = app.isPackaged ? testPackageIdentity(pkg) : null;
  let buildId = build.buildId || "unknown";
  if (!app.isPackaged) {
    const hash = createHash("sha256").update(JSON.stringify(pkg));
    async function visit(directory) {
      for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) await visit(file);
        else if (entry.isFile()) hash.update(path.relative(root, file)).update(await readFile(file));
      }
    }
    for (const directory of ["shell", "updates", "applications", "local-ui", "account", "app-host", "network", "octop"]) await visit(path.join(root, directory));
    for (const file of ["client.mjs", "platform.mjs"]) hash.update(await readFile(path.join(root, file)));
    buildId = `source-${hash.digest("hex").slice(0, 16)}`;
  }
  const osVersion = osRelease();
  const facts = {};
  if (platform === "darwin") {
    let productVersion;
    try { productVersion = getSystemVersion(); } catch { /* Keep an explicit failed-probe fact. */ }
    facts.osProductVersion = typeof productVersion === "string" && productVersion.length > 0 &&
      productVersion.length <= 128 && !/[\x00-\x1f\x7f]/.test(productVersion) ? productVersion : "unknown";
  } else if (platform === "win32") facts.windowsProductType = await windowsProductType(osVersion, execFile);
  return Object.freeze({
    productVersion: app.getVersion(),
    ...(pkg.wanxInternalVersion && { internalVersion: pkg.wanxInternalVersion }),
    buildId, edition, channel: build.channel || (edition === "team" ? "stable-studio" : "stable"),
    distributionClass: app.isPackaged ? build.distributionClass || "unverified" : "development",
    platform, osVersion, ...facts, arch, electronVersion: versions.electron || null,
    nodeVersion: versions.node, hostProtocol: 1, securityEpoch: build.securityEpoch || 0,
    sourceCommit: build.sourceCommit || null, packaged: Boolean(app.isPackaged),
    installationScope: build.installationScope || null,
    ...(testIdentity ? { applicationId: testIdentity.applicationId, testRunId: testIdentity.testRunId } : {}),
  });
}

// Paths are used only for local recovery; snapshots never disclose them.
export async function installationIdentity(app) {
  return createHash("sha256").update(await realpath(app.getPath("exe"))).digest("hex");
}
