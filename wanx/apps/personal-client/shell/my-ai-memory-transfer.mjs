import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { readMemoryConnection } from "./local-memory-runtime.mjs";

const MAX_BYTES = 100 * 1024 * 1024;
const digest = value => createHash("sha256").update(value).digest("hex");
const object = value => value && typeof value === "object" && !Array.isArray(value);
const invalid = message => Object.assign(new Error(message), { status: 400 });

async function fileBytes(file, limit = MAX_BYTES) {
  if (typeof file !== "string" || !path.isAbsolute(file) || file.startsWith("\\\\")) throw invalid("请选择本机文件。");
  const info = await lstat(file).catch(() => null);
  if (!info?.isFile() || info.isSymbolicLink() || info.size > limit) throw invalid("文件不可读取或超过 100 MB。");
  const bytes = await readFile(file);
  if (bytes.length > limit) throw invalid("文件超过 100 MB。");
  return bytes;
}

async function snapshotDigest(file) {
  const info = await lstat(file).catch(() => null);
  if (!info?.isFile() || info.isSymbolicLink()) throw invalid("本机回滚副本不可读取。");
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

export function inspectMemoryBundle(bundle, reference) {
  if (!object(bundle) || !Number.isInteger(bundle.schemaVersion) || bundle.schemaVersion < 1 ||
      bundle.manifest?.service !== "memmy-memory-service" || !object(bundle.tables))
    throw invalid("请选择 MemoBox 导出的 JSON 记忆包。");
  if (bundle.schemaVersion > reference.schemaVersion) throw invalid("记忆包版本较新，请先更新本机记忆服务。");
  const allowed = new Set(Object.keys(reference.tables));
  const counts = {};
  let rows = 0;
  for (const [name, records] of Object.entries(bundle.tables)) {
    if (!allowed.has(name) || !Array.isArray(records) || !records.every(object)) throw invalid("记忆包的数据表格式不受支持。");
    counts[name] = records.length;
    rows += records.length;
    if (rows > 250_000) throw invalid("记忆包记录过多，请拆分后导入。");
  }
  if (!Object.keys(counts).length) throw invalid("记忆包没有可导入的数据表。");
  return { counts, rows, schemaVersion: bundle.schemaVersion, exportedAt: bundle.exportedAt };
}

export function createMyAiMemoryTransfer({ runtimeFile, directory, chooseImportFile, saveExportFile,
  scope, identity = scope, request = fetch }) {
  let pending;
  let busy = false;
  const root = path.resolve(directory);
  const binding = () => { const value = identity(); return value ? digest(value) : null; };
  const manifestPath = key => path.join(root, key + ".json");

  async function call(route, body, check) {
    check();
    const { base, token } = await readMemoryConnection(runtimeFile);
    check();
    const response = await request(new URL(route, base), {
      method: body === undefined ? "GET" : "POST",
      headers: { "x-memmy-local-token": token, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "error", signal: AbortSignal.timeout(120_000),
    });
    check();
    const value = await response.json();
    if (!response.ok) throw Object.assign(invalid(value?.error?.message || "记忆传输未完成，请检查本机记忆服务。"),
      { rejected: response.status < 500 });
    return value;
  }

  async function saveManifest(key, value) {
    await mkdir(root, { recursive: true, mode: 0o700 });
    const temporary = manifestPath(key) + "." + randomUUID();
    try {
      await writeFile(temporary, JSON.stringify(value), { flag: "wx", mode: 0o600 });
      await rename(temporary, manifestPath(key));
    } finally { await rm(temporary, { force: true }); }
  }

  async function manifest(key) {
    const value = await readFile(manifestPath(key), "utf8").then(JSON.parse).catch(error => {
      if (error.code === "ENOENT") return null;
      throw invalid("本机导入回滚记录不可读取。");
    });
    if (value && (typeof value.path !== "string" || path.dirname(value.path) !== root || !/^[a-f0-9]{64}$/.test(value.digest)))
      throw invalid("本机导入回滚记录无效。");
    return value;
  }

  async function action(method, input = {}, assertScope = () => {}) {
    if (busy) throw invalid("正在处理记忆传输，请稍候。");
    busy = true;
    const bound = scope();
    const key = binding();
    const check = () => {
      assertScope();
      if (!bound || !key || scope() !== bound || binding() !== key) throw invalid("账号或盒子已切换，请重新选择记忆包。");
    };
    try {
      check();
      if (method === "status") {
        const saved = await manifest(key);
        check();
        if (saved?.restoreId) {
          const state = await call("/api/local-data/wanx-storage", undefined, check);
          if (state.result?.id === saved.restoreId) {
            if (state.result.failed) {
              await saveManifest(key, { ...saved, restoreId: undefined });
              return { rollbackAvailable: true, error: "回滚未完成，本机副本已保留。" };
            }
            await saveManifest(key, { ...saved, restoreId: undefined, restored: true });
            return { rollbackAvailable: false, restored: true };
          }
          return { rollbackAvailable: false, restoring: true };
        }
        return { rollbackAvailable: Boolean(saved && !saved.restored), createdAt: saved?.createdAt };
      }
      if (method === "export") {
        const file = await saveExportFile();
        check();
        if (!file) return { canceled: true };
        if (!path.isAbsolute(file) || !file.toLowerCase().endsWith(".json")) throw invalid("请保存为 JSON 文件。");
        const previous = await lstat(file).catch(error => { if (error.code !== "ENOENT") throw error; return null; });
        if (previous && (!previous.isFile() || previous.isSymbolicLink())) throw invalid("保存位置不可用。");
        const before = previous ? digest(await fileBytes(file)) : null;
        const bundle = await call("/api/local-data/bundle", undefined, check);
        inspectMemoryBundle(bundle, bundle);
        const content = JSON.stringify(bundle, null, 2);
        if (Buffer.byteLength(content) > MAX_BYTES) throw invalid("导出包超过 100 MB。");
        const temporary = file + "." + randomUUID();
        try {
          await writeFile(temporary, content, { flag: "wx", mode: 0o600 });
          check();
          const now = await lstat(file).catch(error => { if (error.code !== "ENOENT") throw error; return null; });
          if (Boolean(previous) !== Boolean(now) || (now && (now.isSymbolicLink() || digest(await fileBytes(file)) !== before)))
            throw invalid("保存文件已被其他程序修改，请重新选择。");
          await rename(temporary, file);
        } finally { await rm(temporary, { force: true }); }
        return { exported: true, path: file };
      }
      if (method === "preview") {
        pending = undefined;
        const file = await chooseImportFile();
        check();
        if (!file) return { canceled: true };
        const bytes = await fileBytes(file);
        let bundle;
        try { bundle = JSON.parse(bytes.toString("utf8")); } catch { throw invalid("JSON 文件已损坏。"); }
        const reference = await call("/api/local-data/bundle", undefined, check);
        const preview = inspectMemoryBundle(bundle, reference);
        pending = { id: randomUUID(), file, digest: digest(bytes), scope: bound, key, expires: Date.now() + 15 * 60_000 };
        return { ...preview, previewId: pending.id, name: path.basename(file), conflictStrategy: "skip" };
      }
      if (method === "import") {
        if (!pending || input.previewId !== pending.id || pending.scope !== bound || pending.key !== key || pending.expires < Date.now())
          throw invalid("导入预览已失效，请重新选择记忆包。");
        const selected = pending;
        const bytes = await fileBytes(selected.file);
        if (digest(bytes) !== selected.digest) { pending = undefined; throw invalid("记忆包已变化，请重新预览。"); }
        const bundle = JSON.parse(bytes.toString("utf8"));
        const reference = await call("/api/local-data/bundle", undefined, check);
        inspectMemoryBundle(bundle, reference);
        await mkdir(root, { recursive: true, mode: 0o700 });
        const snapshot = await call("/api/local-data/wanx-storage/snapshot", { directory: root }, check);
        if (!snapshot?.path || path.dirname(snapshot.path) !== root || path.dirname(await realpath(snapshot.path)) !== await realpath(root))
          throw invalid("无法保留导入前副本，导入已停止。");
        const snapshotHash = await snapshotDigest(snapshot.path);
        await saveManifest(key, { path: snapshot.path, digest: snapshotHash, createdAt: new Date().toISOString() });
        check();
        pending = undefined;
        const result = await call("/api/local-data/bundle/import", { bundle, conflictStrategy: "skip" }, check);
        if (result.ok !== true) throw invalid("导入结果未确认；本机回滚副本已保留。");
        return { imported: true, inserted: result.inserted, skipped: result.skipped, rollbackAvailable: true };
      }
      if (method === "rollback") {
        if (input.confirm !== true) throw invalid("请确认恢复导入前的整个本机记忆库。");
        const saved = await manifest(key);
        if (!saved || saved.restored) throw invalid("没有可回滚的导入记录。");
        if (await snapshotDigest(saved.path) !== saved.digest) throw invalid("本机回滚副本已变化，不能恢复。");
        const id = saved.restoreId ?? randomUUID();
        await saveManifest(key, { ...saved, restoreId: id });
        try {
          const result = await call("/api/local-data/wanx-storage", { id, restoreFrom: saved.path }, check);
          if (result.accepted !== true) throw invalid("记忆服务尚未接受回滚。");
        } catch (error) {
          if (error.rejected) {
            await saveManifest(key, { ...saved, restoreId: undefined });
            throw error;
          }
          // An interrupted reply can follow an accepted restart; preserve its ID for status reconciliation.
          if (scope() === bound && binding() === key) throw invalid("回滚结果尚未确认，请刷新状态；本机副本已保留。");
          throw error;
        }
        return { restoring: true, rollbackAvailable: false };
      }
      throw invalid("记忆传输操作无效。");
    } finally { busy = false; }
  }
  return { action };
}
