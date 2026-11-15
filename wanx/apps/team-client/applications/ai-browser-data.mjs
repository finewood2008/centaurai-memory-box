import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import path from "node:path";

// Shared AI Browser 0.1.2 and 1.0.0 use the same thread/learning registries.
// Chromium session files also retain UI state; recognize the audited layout
// without reading, migrating or deleting opaque runtime metadata.
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
const maximumRegistryBytes = 1024 * 1024;
const unknown = () => { throw new Error("AI_BROWSER_DATA_UNKNOWN"); };
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino && a.size === b.size &&
  a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && a.nlink === b.nlink;

const validId = value => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
function validScope(key, length) {
  let value;
  try { value = JSON.parse(key); } catch { return false; }
  return Array.isArray(value) && value.length === length &&
    typeof value[0] === "string" && value[0].length > 0 &&
    Number.isSafeInteger(value[1]) && value[1] > 0 &&
    (length === 2 || validId(value[2]));
}
function validRegistry(value, name) {
  if (!object(value)) return false;
  return Object.entries(value).every(([key, record]) => {
    if (!object(record)) return false;
    if (name === "threads.json") return validScope(key, 3) &&
      Object.keys(record).join() === "thread_id" && validId(record.thread_id);
    return validScope(key, 2) && Object.keys(record).sort().join() === "agentId,goal,name,recordingId" &&
      typeof record.recordingId === "string" && /^learn_[a-f0-9]{32}$/.test(record.recordingId) &&
      validId(record.agentId) && typeof record.name === "string" && record.name.trim().length > 0 && record.name.length <= 80 &&
      typeof record.goal === "string" && record.goal.trim().length > 0 && record.goal.length <= 240;
  });
}

/** Read schema evidence without changing, migrating or deleting any profile. */
export async function inspectAiBrowserData({ manifest, profileDirectories } = {}) {
  if (manifest?.applicationId !== "centaurai.wanx.ai-browser" || manifest.runtime !== "electron" ||
      manifest.launchMode !== "shared" || manifest.entrypoint !== "shell/main.mjs" ||
      ![2, 3].includes(manifest.protocolVersion)) return null;
  if (!Array.isArray(profileDirectories) || !profileDirectories.length ||
      profileDirectories.some(directory => typeof directory !== "string" || !path.isAbsolute(directory))) return { status: "unknown" };
  try {
    const inspectedDirectories = [];
    let dataPresent = false, totalBytes = 0;
    async function directory(filename, expectedPath) {
      const info = await lstat(filename);
      if (!info.isDirectory() || info.isSymbolicLink() || await realpath(filename) !== expectedPath) unknown();
      const entries = await readdir(filename);
      if (entries.length > 1024) unknown();
      inspectedDirectories.push({ filename, info, expectedPath });
      return entries;
    }
    async function registryFile(filename, expectedPath, name) {
      const info = await lstat(filename);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > maximumRegistryBytes ||
          (totalBytes += info.size) > 16 * maximumRegistryBytes || await realpath(filename) !== expectedPath) unknown();
      const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const opened = await handle.stat();
        if (!sameFile(info, opened)) unknown();
        // A bounded read also covers a file growing between stat and read.
        const bytes = Buffer.alloc(maximumRegistryBytes + 1);
        let length = 0;
        while (length < bytes.length) {
          const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length);
          if (!bytesRead) break;
          length += bytesRead;
        }
        if (length !== info.size || !sameFile(info, await handle.stat()) ||
            !sameFile(info, await lstat(filename)) || await realpath(filename) !== expectedPath ||
            !validRegistry(JSON.parse(bytes.subarray(0, length).toString("utf8")), name)) unknown();
        dataPresent = true;
      } finally { await handle.close(); }
    }
    for (const filename of profileDirectories) {
      // Inspect the direct profile parent before checking the child: a dangling
      // .runtime/application-data link must not look like an absent profile.
      const parent = path.dirname(filename);
      let parentInfo;
      try { parentInfo = await lstat(parent); }
      catch (error) { if (error.code === "ENOENT") continue; throw error; }
      if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()) unknown();
      const expectedParent = await realpath(parent);
      inspectedDirectories.push({ filename: parent, info: parentInfo, expectedPath: expectedParent });
      try { await lstat(filename); }
      catch (error) { if (error.code === "ENOENT") continue; throw error; }
      const expectedPath = path.join(expectedParent, path.basename(filename));
      const entries = await directory(filename, expectedPath);
      for (const name of entries) {
        const entry = path.join(filename, name), expectedEntry = path.join(expectedPath, name);
        if (name === "threads.json" || name === "learning.json") {
          await registryFile(entry, expectedEntry, name);
        } else {
          const info = await lstat(entry);
          if (info.isSymbolicLink() || await realpath(entry) !== expectedEntry ||
              !(metadataDirectories.has(name) && info.isDirectory() ||
                metadataFiles.has(name) && info.isFile() && info.nlink === 1)) unknown();
          dataPresent = true;
        }
      }
    }
    // A partially read or replaced tree must not become a successful probe.
    for (const { filename, info, expectedPath } of inspectedDirectories)
      if (!sameFile(info, await lstat(filename)) || await realpath(filename) !== expectedPath) unknown();
    return dataPresent ? { localDataPresent: true, localDataSchemaVersion: "1.0.0" } : { localDataPresent: false };
  } catch { return { status: "unknown" }; }
}
