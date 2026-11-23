import path from "node:path";

export function nativeBinaryDirectory({ appPath, resourcesPath, packaged }) {
  const application = path.resolve(appPath);
  // Branded Electron may open installed resources while reporting isPackaged=false.
  if (packaged || ["app", "app.asar"].some(name => application === path.resolve(resourcesPath, name))) {
    return path.join(resourcesPath, "network");
  }
  const parent = path.dirname(application);
  // Reassembling build/app clears its contents, including any copied helpers.
  const root = path.basename(application) === "app" && path.basename(parent) === "build"
    ? path.dirname(parent)
    : application;
  return path.join(root, "native", "bin");
}

export function nativeBinaryPaths({ platform = process.platform, arch = process.arch, ...layout }) {
  const directory = nativeBinaryDirectory(layout);
  const suffix = platform === "win32" ? ".exe" : "";
  return {
    engine: path.join(directory, `wanx-netbird-${platform}-${arch}${suffix}`),
    discovery: path.join(directory, `wanx-discovery-${platform}-${platform === "win32" ? "x64" : arch}${suffix}`),
  };
}
