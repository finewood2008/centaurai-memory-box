import { randomUUID } from "node:crypto";
import { constants, copyFileSync } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
import { MemoryDb } from "../storage/db.js";
import { SCHEMA_VERSION } from "../storage/schema.js";
import { MemoryServiceError } from "../utils/error.js";

const SETTINGS = "wanx-storage.json";

export interface WanxStorageMove {
  id: string;
  directory: string;
  candidatePath?: string;
}

interface WanxStorageSelection {
  databasePath: string;
  recoveryPath?: string;
}

export interface WanxStorageResult {
  id: string;
  failed: boolean;
}

function databaseSourceProfile(database: MemoryDb): string | undefined {
  const found = database.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='wanx_memory_source'").get();
  if (!found) return undefined;
  const row = database.db.prepare("SELECT profile FROM wanx_memory_source WHERE id=1").get() as { profile: string } | undefined;
  return row?.profile;
}

export function bindWanxSourceProfile(database: MemoryDb, profile: string | undefined, fresh: boolean): void {
  const actual = databaseSourceProfile(database);
  if (actual === profile) return;
  if (!fresh || !profile || actual) throw new Error("The memory database belongs to a different source profile");
  database.db.transaction(() => {
    database.db.exec("CREATE TABLE wanx_memory_source (id INTEGER PRIMARY KEY CHECK(id=1), profile TEXT NOT NULL)");
    database.db.prepare("INSERT INTO wanx_memory_source (id, profile) VALUES (1, ?)").run(profile);
  })();
}

// Called before constructing the service, while the server/database lease is
// exclusive. On APFS a verified COW clone avoids another full-size allocation.
async function copyWanxUpgradeSnapshot(database: MemoryDb, directory: string): Promise<string> {
  const checkpoint = database.db.pragma("wal_checkpoint(TRUNCATE)") as { busy: number }[];
  if (checkpoint[0]?.busy !== 0) return copyWanxDatabase(database, directory);
  const target = join(directory, `memory-${randomUUID()}.sqlite`);
  try {
    copyFileSync(database.path, target, constants.COPYFILE_FICLONE_FORCE | constants.COPYFILE_EXCL);
  } catch (error) {
    await rm(target, { force: true }).catch(() => {});
    const code = (error as NodeJS.ErrnoException).code;
    if (["ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EXDEV", "EINVAL"].includes(code ?? "")) return copyWanxDatabase(database, directory);
    throw error;
  }
  await chmod(target, 0o600);
  const snapshot = new MemoryDb({ path: target, readonly: true });
  try {
    if (snapshot.db.pragma("quick_check", { simple: true }) !== "ok" || snapshot.schemaVersion().version !== SCHEMA_VERSION) {
      throw new Error("The pre-upgrade memory snapshot did not pass verification");
    }
  } finally { snapshot.close(); }
  const completed = await open(target, "r+");
  try { await completed.sync(); } finally { await completed.close(); }
  return target;
}

/** Upgrade one existing local store; retain a verified pre-upgrade snapshot. */
export async function unifyWanxSourceProfile(database: MemoryDb, directory: string): Promise<string | undefined> {
  const actual = databaseSourceProfile(database);
  if (!actual) return undefined;
  if (!["codex-desktop", "codex-cli"].includes(actual)) throw new Error("Unknown memory source profile");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const previous = await copyWanxUpgradeSnapshot(database, directory);
  database.db.transaction(() => {
    database.db.prepare("DELETE FROM wanx_memory_source WHERE id=1").run();
  })();
  return previous;
}

export function readWanxStorageSelection(serviceHome: string): Promise<WanxStorageSelection | undefined> {
  return readFile(join(serviceHome, SETTINGS), "utf8").then(content => {
    const { databasePath, recoveryPath } = JSON.parse(content);
    if (typeof databasePath !== "string" || !isAbsolute(databasePath)) {
      throw new Error("Invalid local memory storage configuration");
    }
    return { databasePath, recoveryPath: typeof recoveryPath === "string" && isAbsolute(recoveryPath) ? recoveryPath : undefined };
  }).catch(error => {
    if (error.code !== "ENOENT") throw error;
    return undefined;
  });
}

export async function checkWanxStorageDirectory(directory: unknown): Promise<string> {
  if (typeof directory !== "string" || directory.length > 4096 || !isAbsolute(directory)
    || directory.startsWith("\\\\")) {
    throw new MemoryServiceError("invalid_argument", "请选择本机磁盘上的文件夹。");
  }
  const info = await lstat(directory).catch(() => null);
  if (!info?.isDirectory() || info.isSymbolicLink()) {
    throw new MemoryServiceError("invalid_argument", "此文件夹已不可用，请重新选择。");
  }
  const actual = await realpath(directory);
  if (actual.startsWith("\\\\")) throw new MemoryServiceError("invalid_argument", "请选择本机磁盘上的文件夹。");
  return actual;
}

/** Creates a consistent SQLite snapshot, including committed WAL pages. */
export async function copyWanxDatabase(database: MemoryDb, directory: string, allowOlderSchema = false): Promise<string> {
  const target = join(directory, `memory-${randomUUID()}.sqlite`);
  const file = await open(target, "wx", 0o600);
  await file.close();
  try {
    // SQLite's backup API includes committed WAL pages and preserves row IDs.
    // Open the snapshot with the same extensions as the running database.
    await database.db.backup(target);
    await chmod(target, 0o600);
    const snapshot = new MemoryDb({ path: target, readonly: true });
    try {
      const version = snapshot.schemaVersion().version;
      if (snapshot.db.pragma("quick_check", { simple: true }) !== "ok"
        || version < 1 || version > SCHEMA_VERSION || (!allowOlderSchema && version !== SCHEMA_VERSION)) {
        throw new Error("The memory database copy did not pass verification");
      }
    } finally {
      snapshot.close();
    }
    const completed = await open(target, "r+");
    try { await completed.sync(); } finally { await completed.close(); }
    return target;
  } catch (error) {
    await rm(target, { force: true }).catch(() => {});
    throw error;
  }
}

export async function prepareWanxRestore(source: unknown, directory: string, profile?: string, allowUnified = false): Promise<string> {
  if (typeof source !== "string" || !isAbsolute(source) || source.length > 4096) {
    throw new MemoryServiceError("invalid_argument", "备份文件路径无效。");
  }
  const info = await lstat(source).catch(() => null);
  if (!info?.isFile() || info.isSymbolicLink() || info.nlink !== 1 || (await realpath(source)).startsWith("\\\\")) {
    throw new MemoryServiceError("invalid_argument", "备份文件不可用。");
  }
  try {
    const backup = new MemoryDb({ path: source, readonly: true });
    try {
      const actual = databaseSourceProfile(backup);
      const upgrade = allowUnified && profile === undefined && actual !== undefined
        && ["codex-desktop", "codex-cli"].includes(actual);
      if (actual !== profile && !upgrade) throw new Error("Source profile mismatch");
      const candidate = await copyWanxDatabase(backup, directory, true);
      if (upgrade) {
        const writable = new MemoryDb({ path: candidate });
        try { writable.db.prepare("DELETE FROM wanx_memory_source WHERE id=1").run(); }
        finally { writable.close(); }
      }
      return candidate;
    }
    finally { backup.close(); }
  } catch {
    throw new MemoryServiceError("invalid_argument", "无法读取备份，文件已损坏或记忆库版本不兼容。");
  }
}

export async function commitWanxStoragePath(serviceHome: string, selection: WanxStorageSelection): Promise<void> {
  const target = join(serviceHome, SETTINGS);
  const temporary = join(serviceHome, `.${basename(target)}-${randomUUID()}`);
  try {
    await writeFile(temporary, JSON.stringify(selection), { mode: 0o600, flag: "wx", flush: true });
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}
