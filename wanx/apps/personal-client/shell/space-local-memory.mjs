import { randomUUID } from "node:crypto";
import { lstat, mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const STORAGE_API = "/api/local-data/wanx-storage";
const failure = message => new Error(message);

export function createLocalMemorySpace({ defaultDirectory, scope, request, chooseDirectory, openDirectory, protectDirectory }) {
  let operation;
  let attemptedDefaultScope;
  let defaultRetryAt = 0;
  const assertScope = owner => {
    if (!owner || owner !== scope()) throw failure("云账号或本机身份已切换，请重新打开「空间」。");
  };

  async function storage(owner) {
    assertScope(owner);
    const result = await request(STORAGE_API);
    assertScope(owner);
    if (typeof result?.dataPath !== "string" || !path.isAbsolute(result.dataPath) ||
      typeof result.configured !== "boolean") throw failure("无法读取本机记忆库位置。");
    return result;
  }

  async function prepare(directory, owner) {
    const canonical = await realpath(directory);
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || canonical.startsWith("\\\\") ||
      canonical === path.parse(canonical).root)
      throw failure("请选择本机磁盘上的普通文件夹。");
    const details = await storage(owner);
    const actual = await realpath(details.dataPath).catch(() => details.dataPath);
    // Restrict permissions only on a dedicated child for the memory files.
    if (canonical === actual && details.configured) return actual;
    return prepareMemoryDirectory(path.join(canonical, "万象记忆库"), owner);
  }

  async function prepareMemoryDirectory(directory, owner) {
    assertScope(owner);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const info = await lstat(directory);
    const actual = await realpath(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || actual.startsWith("\\\\"))
      throw failure("请选择本机磁盘上的普通文件夹。");
    assertScope(owner);
    await protectDirectory?.(actual);
    assertScope(owner);
    return actual;
  }

  async function move(directory, owner) {
    assertScope(owner);
    const id = randomUUID();
    const result = await request(STORAGE_API, { id, directory });
    assertScope(owner);
    if (!result?.accepted) return storage(owner);
    const deadline = Date.now() + 120_000;
    do {
      const state = await storage(owner).catch(error => {
        assertScope(owner);
        return null;
      });
      if (state?.result?.id === id) {
        if (state.result.failed) throw failure("迁移未完成，记忆库仍使用原来的目录。");
        return state;
      }
      await delay(350);
      assertScope(owner);
    } while (Date.now() < deadline);
    throw failure("仍在等待本机记忆服务确认，请稍后刷新保存位置。");
  }

  function run(action, input) {
    const owner = scope();
    assertScope(owner);
    if (action === "get") {
      return operation?.owner === owner ? operation.promise.catch(() => storage(owner)) : storage(owner);
    }
    if (operation) {
      if (action === "initialize" && operation.owner === owner) return operation.promise;
      throw failure("正在处理本机记忆库，请稍后重试。");
    }
    const promise = (async () => {
      const current = await storage(owner);
      switch (action) {
        case "initialize":
          if (current.configured) return current;
          return move(await prepareMemoryDirectory(defaultDirectory, owner), owner);
        case "reset":
          return move(await prepareMemoryDirectory(defaultDirectory, owner), owner);
        case "choose": {
          const chosen = await chooseDirectory(current.dataPath);
          assertScope(owner);
          return chosen ? move(await prepare(chosen, owner), owner) : current;
        }
        case "mkdir": {
          const name = typeof input?.name === "string" ? input.name.trim() : "";
          if (!name || name.length > 100 || /^[.]/.test(name) || /[<>:"/\\|?*\u0000-\u001f]|[.]$/.test(name) ||
            /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(name))
            throw failure("请输入有效的文件夹名称。");
          const directory = await realpath(current.dataPath);
          assertScope(owner);
          await mkdir(path.join(directory, name));
          return current;
        }
        case "open":
          assertScope(owner);
          await openDirectory(current.dataPath);
          return current;
        default:
          throw failure("无效的本机目录操作。");
      }
    })();
    operation = { owner, promise };
    void promise.finally(() => { if (operation?.promise === promise) operation = undefined; }).catch(() => {});
    return promise;
  }

  return {
    run,
    initialize() {
      const owner = scope();
      if (!owner) { attemptedDefaultScope = undefined; defaultRetryAt = 0; return; }
      if (owner === attemptedDefaultScope || Date.now() < defaultRetryAt) return;
      attemptedDefaultScope = owner;
      void Promise.resolve().then(() => run("initialize")).catch(() => {
        if (attemptedDefaultScope === owner) { attemptedDefaultScope = undefined; defaultRetryAt = Date.now() + 15_000; }
      });
    },
    close: () => operation?.promise.catch(() => {}) ?? Promise.resolve(),
  };
}
