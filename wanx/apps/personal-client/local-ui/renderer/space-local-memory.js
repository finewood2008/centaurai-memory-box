(() => {
  const api = window.wanxClient.localMemoryStorage;
  const backupApi = window.wanxClient.memoryBackup;
  const esc = value => String(value ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char]);
  let storage, error, notice, pending, creating, name, generation = 0;
  let backup, backupError, backupPending, location, confirming;
  let render = () => {};

  const formatDate = value => Number.isFinite(value) ? new Date(value * 1000).toLocaleString() : "";

  async function loadBackup() {
    if (!backupApi) return;
    const current = generation;
    const response = await backupApi({ action: "status" }).catch(() => null);
    if (current !== generation || !response) return;
    if (response.error) {
      if (backupError !== response.error) { backupError = response.error; render(); }
      return;
    }
    if (backup?.context !== response.result?.context) { location = null; confirming = false; }
    if (JSON.stringify(backup) !== JSON.stringify(response.result)) { backup = response.result; render(); }
  }

  async function backupAction(action, folder) {
    if (backupPending) return;
    if (action === "cancel") { location = null; confirming = false; backupError = ""; render(); return; }
    if (action === "confirm") { confirming = true; render(); return; }
    const current = generation;
    const context = backup?.context;
    backupPending = action;
    backupError = "";
    render();
    try {
      const { result, error } = await backupApi({
        action, context, parent: folder ?? location?.parent, id: action === "restore" ? location?.latest?.id : undefined,
      });
      if (current !== generation || context !== backup?.context) return;
      if (error) throw new Error(error);
      if (action === "browse") { location = result; confirming = false; }
      else { location = null; confirming = false; }
      if (action === "restore") void window.wanxLocalMemorySpace?.load();
    } catch (error) {
      if (current === generation) backupError = error.message;
    } finally {
      if (current === generation) { backupPending = null; await loadBackup(); render(); }
    }
  }

  function backupView() {
    if (!backupApi) return "";
    const busy = backupPending || ["backing-up", "restoring"].includes(backup?.phase);
    const button = (label, command, folder) => `<button type="button" class="button small" data-action="local-memory-backup-${command}" ${folder === undefined ? "" : `data-folder="${esc(folder)}"`} ${busy ? "disabled" : ""}>${label}</button>`;
    const progress = backup?.progress;
    const uploadProgress = progress?.total > 0 ? ` ${Math.floor(100 * progress.bytes / progress.total)}%` : "";
    const status = backupPending === "restore" || backup?.phase === "restoring" ? "正在恢复记忆库…" :
      backupPending === "backup" || backupPending === "enable" || backup?.phase === "backing-up" ? `正在备份记忆库…${uploadProgress}` :
      backup?.phase === "newer-backup" ? "盒子上有更新的备份，自动备份已暂停。请先从空间恢复。" :
      backup?.phase === "error" ? "上次操作未完成。自动备份开启时会重试。" :
      backup?.lastBackup ? `最近备份：${formatDate(backup.lastBackup)}` : "";
    return `<section class="settings-panel space-local-memory" aria-label="记忆库备份">
      <div><h3>记忆库备份</h3>
        <p class="muted">把本机记忆自动备份到所选盒子空间。换电脑后，连接同一盒子即可恢复。</p>
        <p class="muted">${!backup?.connected ? "请先连接盒子。" : backup.enabled ? `自动备份已开启 · ${esc(backup.name)}` : "自动备份未开启"}</p>
        ${status ? `<p class="muted" role="status">${esc(status)}</p>` : ""}
        ${backupError ? `<p class="danger-text" role="alert">${esc(backupError)}</p>` : ""}
      </div>
      ${backup?.connected ? `<div class="settings-actions">
        ${button(backup.enabled ? "查看备份位置" : "设置备份或恢复…", "browse", backup.parent ?? "")}
        ${backup.enabled ? button("立即备份", "backup") + button("关闭自动备份", "disable") : ""}
      </div>` : ""}
      ${location && backup?.connected ? `<div class="space-memory-backup-picker">
        <strong>${esc(location.name)}</strong>
        ${location.parent ? button("返回上级", "browse", location.up) : ""}
        <ul>${location.folders.map(folder => `<li>${button(esc(folder.name), "browse", folder.id)}</li>`).join("")}</ul>
        ${location.latest ? `<p class="muted">最近的盒端备份：${esc(formatDate(location.latest.modified))}</p>
          ${confirming ? `<p>恢复会切换当前记忆库，原本机数据库文件会保留。</p>${button("确认恢复并开启自动备份", "restore")}` : button("从此处恢复…", "confirm")}` : ""}
        ${!confirming && location.canEnable && (!backup.enabled || backup.parent !== location.parent) ? button("备份到此处", "enable") : ""}
        ${button("关闭目录选择", "cancel")}
      </div>` : ""}
    </section>`;
  }

  async function action(action, input) {
    if (pending) return;
    const current = generation;
    pending = action;
    error = "";
    notice = "";
    render();
    try {
      const result = await api({ action, ...input });
      if (current !== generation) return;
      if (result.error || !result.storage) throw new Error(result.error || "暂时无法读取本机记忆库。");
      storage = result.storage;
      if (action === "mkdir") {
        creating = false;
        name = "";
        notice = "已新建文件夹。";
      }
      if (action === "reset" || action === "initialize") notice = "已使用默认目录。";
    } catch (cause) {
      if (current === generation) error = cause.message;
    } finally {
      if (current === generation) { pending = null; render(); }
    }
  }

  function view() {
    const disabled = pending ? "disabled" : "";
    const canEdit = storage && !pending;
    return `<section class="settings-panel space-local-memory" aria-label="本机记忆库">
      <div><h3>本机记忆库</h3><p class="muted">记忆数据库的保存位置。选择新位置时，记忆盒子会在所选文件夹下建立专用的「记忆盒子记忆库」目录。</p>
        ${storage ? `<code class="space-local-path">${esc(storage.dataPath)}</code>` : ""}
        ${pending ? `<p class="muted" role="status">${["choose", "reset", "initialize"].includes(pending) ? "正在准备保存位置，迁移时记忆服务会短暂重启…" : "正在处理…"}</p>` : ""}
        ${notice ? `<p class="muted" role="status">${esc(notice)}</p>` : ""}
        ${error ? `<p class="danger-text" role="alert">${esc(error)}</p>` : ""}
      </div>
      <div class="settings-actions">
        ${storage ? `<button class="button small" data-action="local-memory-open" ${disabled}>打开文件夹</button>
          <button class="button small primary" data-action="local-memory-choose" ${disabled}>更换保存位置…</button>
          <button class="button small" data-action="local-memory-create" ${disabled}>新建文件夹</button>
          <button class="text-button" data-action="local-memory-reset" ${disabled}>使用默认目录</button>` :
          `<button class="button small" data-action="local-memory-initialize" ${disabled}>重试</button>`}
      </div>
      ${creating ? `<form class="space-local-folder-form" data-form="local-memory-folder">
        <label for="local-memory-folder">文件夹名称</label>
        <input id="local-memory-folder" name="name" required maxlength="100" value="${esc(name)}" ${disabled} />
        <button type="submit" class="button small primary" ${canEdit ? "" : "disabled"}>新建</button>
        <button type="button" class="button small" data-action="local-memory-cancel" ${disabled}>取消</button>
      </form>` : ""}
    </section>${backupView()}`;
  }

  if (api) window.wanxLocalMemorySpace = {
    view, bind(callback) { render = callback; },
    load() { void action("get"); void loadBackup(); },
    click(command, folder) {
      if (command.startsWith("backup-")) { void backupAction(command.slice(7), folder); return; }
      if (command === "create" || command === "cancel") {
        creating = command === "create";
        name = "";
        error = "";
        notice = "";
        render();
        if (creating) document.getElementById("local-memory-folder")?.focus();
      } else void action(command);
    },
    submit(value) { name = value; return action("mkdir", { name: value }); },
    reset() {
      generation++;
      storage = error = notice = pending = name = "";
      backup = backupError = backupPending = location = null;
      creating = confirming = false;
    },
  };
  if (backupApi) setInterval(() => {
    if (document.querySelector(".space-local-memory")) void loadBackup();
  }, 2_000);
})();
