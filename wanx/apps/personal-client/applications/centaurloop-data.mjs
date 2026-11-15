import { lstat, readdir, realpath } from "node:fs/promises";
import path from "node:path";

// Audited CentaurLoop 0.10.4 and 1.0.0 have identical shell/renderer code.
// Tasks live on the box via Host APIs; the local profile contains only
// Chromium runtime state. Preserve these bytes, including session storage.
const metadataDirectories = new Set([
  "Cache", "Code Cache", "GPUCache", "DawnGraphiteCache", "DawnWebGPUCache",
  "Local Storage", "Session Storage", "Shared Dictionary", "blob_storage", "Network",
]);
const metadataFiles = new Set([
  ".data-schema.json",
  "Preferences", "Local State", "Network Persistent State", "TransportSecurity",
  "SharedStorage", "SharedStorage-wal", "SharedStorage-shm",
  "Trust Tokens", "Trust Tokens-journal", "Cookies", "Cookies-journal",
  "DIPS", "DIPS-journal", "DIPS-wal", "DIPS-shm",
]);
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino && a.size === b.size &&
  a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && a.nlink === b.nlink;
const unknown = () => { throw new Error("CENTAURLOOP_DATA_UNKNOWN"); };

/** Recognize the audited metadata-only layout without reading or deleting data. */
export async function inspectCentaurloopData({ manifest, profileDirectories } = {}) {
  if (manifest?.applicationId !== "centaurai.wanx.centaurloop" || manifest.runtime !== "electron" ||
      manifest.launchMode !== "shared" || manifest.entrypoint !== "shell/main.cjs" ||
      manifest.protocolVersion !== 3 || !["0.10.4", "1.0.0"].includes(manifest.version)) return null;
  if (!Array.isArray(profileDirectories) || !profileDirectories.length ||
      profileDirectories.some(directory => typeof directory !== "string" || !path.isAbsolute(directory))) return { status: "unknown" };
  try {
    let dataPresent = false;
    const inspected = [];
    for (const filename of profileDirectories) {
      const parent = path.dirname(filename);
      let parentInfo;
      try { parentInfo = await lstat(parent); }
      catch (error) { if (error.code === "ENOENT") continue; throw error; }
      if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()) unknown();
      const expectedParent = await realpath(parent);
      inspected.push({ filename: parent, info: parentInfo, expectedPath: expectedParent });
      let info;
      try { info = await lstat(filename); }
      catch (error) { if (error.code === "ENOENT") continue; throw error; }
      const expectedPath = path.join(expectedParent, path.basename(filename));
      if (!info.isDirectory() || info.isSymbolicLink() || await realpath(filename) !== expectedPath) unknown();
      inspected.push({ filename, info, expectedPath });
      const entries = await readdir(filename);
      if (entries.length > 1024) unknown();
      for (const name of entries) {
        const entry = path.join(filename, name), expectedEntry = path.join(expectedPath, name);
        const entryInfo = await lstat(entry);
        if (entryInfo.isSymbolicLink() || await realpath(entry) !== expectedEntry ||
            !(metadataDirectories.has(name) && entryInfo.isDirectory() ||
              metadataFiles.has(name) && entryInfo.isFile() && entryInfo.nlink === 1)) unknown();
        inspected.push({ filename: entry, info: entryInfo, expectedPath: expectedEntry });
        dataPresent = true;
      }
    }
    for (const { filename, info, expectedPath } of inspected)
      if (!sameFile(info, await lstat(filename)) || await realpath(filename) !== expectedPath) unknown();
    return dataPresent ? { localDataPresent: true, localDataSchemaVersion: "1.0.0" } : { localDataPresent: false };
  } catch { return { status: "unknown" }; }
}
