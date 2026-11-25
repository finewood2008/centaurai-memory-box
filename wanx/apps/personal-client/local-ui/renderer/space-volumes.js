(() => {
  window.createSpaceVolumes = ({render, esc, icon, fileIcon, size}) => {
    let drives = [], selected = null, path = "", offset = 0, listing, preview, error;
    let scope = null, timer, generation = 0, requestId = 0;

    async function request(op, input = {}) {
      const reply = await window.wanxClient.action("space-volumes", {op, ...input});
      if (!reply.ok) throw Error(reply.code);
      return reply.value;
    }
    function leave() {
      requestId++;
      selected = null;
      path = "";
      offset = 0;
      listing = preview = error = null;
    }
    function watch(nextScope) {
      if (scope === nextScope) return;
      scope = nextScope;
      const epoch = ++generation;
      clearTimeout(timer);
      drives = [];
      leave();
      if (!scope) return;
      async function poll() {
        let next;
        try { next = await request("volumes"); }
        catch { next = []; }
        if (epoch !== generation) return;
        if (Array.isArray(next) && JSON.stringify(next) !== JSON.stringify(drives)) {
          drives = next;
          if (selected && !drives.some(v => v.id === selected.id)) leave();
          render();
        }
        timer = setTimeout(poll, 4000);
      }
      void poll();
    }
    async function open(folder, page = 0, file = "") {
      const id = ++requestId;
      path = folder;
      offset = page;
      preview = file ? {name: file} : null;
      if (!file) listing = null;
      error = null;
      render();
      try {
        const result = await request(file ? "preview" : "folder", {
          volume: selected.id, path: file ? [folder, file].filter(Boolean).join("/") : folder, offset: page,
        });
        if (requestId !== id) return;
        if (file) preview = {name: file, result};
        else listing = result;
      } catch {
        if (requestId !== id) return;
        error = "读取失败，请检查硬盘连接后重试。";
      }
      render();
    }
    function button(label, op, value = "") {
      return `<button class="text-button" data-action="space-volume-${op}" data-value="${esc(value)}">${esc(label)}</button>`;
    }
    function sidebar() {
      return drives.map(v => `<button class="space-nav ${selected?.id === v.id ? "active" : ""}" data-action="space-volume-select" data-value="${esc(v.id)}" title="外接硬盘 · ${esc(v.name)}">${icon("drive")}<span>${esc(v.name)}</span></button>`).join("");
    }
    function view() {
      let parts = [];
      const crumbs = [button(selected.name, "folder"), ...path.split("/").filter(Boolean).map(p => {
        parts.push(p);
        return button(p, "folder", parts.join("/"));
      })];
      let content;
      if (error) content = `<p role="alert">${esc(error)} ${button("重试", "retry")}</p>`;
      else if (preview) {
        const data = preview.result;
        const body = !data ? "正在读取…" : data.image ? `<img style="max-width:100%;max-height:60vh" alt="${esc(preview.name)}" src="data:image/jpeg;base64,${esc(data.image)}">` :
          data.text !== undefined ? `<pre class="space-text-preview">${esc(data.text)}</pre>${data.truncated ? "仅显示开头部分" : ""}` : `文件大小 ${size(data.size)} · 此类型暂不支持预览`;
        content = `<section class="space-files"><h3>${esc(preview.name)}</h3>${preview.result?.text !== undefined && /\.(txt|md|csv|json|log|ya?ml)$/i.test(preview.name) ? button("在线编辑", "edit") : ""}${body}</section>`;
      } else if (!listing) content = '<p role="status">正在读取文件…</p>';
      else {
        const rows = listing.items.map(item => `<button class="space-file-row" data-action="space-volume-${item.folder ? "child" : "file"}" data-value="${esc(item.name)}"><span class="space-file-name">${fileIcon({name:item.name, kind:item.folder ? "folder" : "file"})}<strong>${esc(item.name)}</strong></span><span class="space-file-detail">${item.folder ? "文件夹" : size(item.size)}</span></button>`).join("");
        content = `<section class="space-files"><div class="space-file-list">${rows || '<p>此文件夹为空</p>'}</div></section><footer class="space-statusbar">${listing.total} 个项目 ${offset > 0 ? button("上一页","page",offset-listing.pageSize) : ""} ${offset+listing.pageSize < listing.total ? button("下一页","page",offset+listing.pageSize) : ""}</footer>`;
      }
      return `<div class="space-toolbar"><strong>${esc(selected.name)}</strong><span>外接硬盘</span>${button(preview ? "返回文件夹" : "刷新", "folder", path)}</div><div class="space-pathbar"><div class="space-breadcrumbs">${crumbs.join(" › ")}</div></div>${content}`;
    }
    function action(op, value) {
      if (op === "select") {
        const drive = drives.find(v => v.id === value);
        if (!drive) return;
        selected = drive;
        return open("");
      }
      if (!selected) return;
      if (op === "folder") return open(value);
      if (op === "child") return open([path, value].filter(Boolean).join("/"));
      if (op === "file") return open(path, offset, value);
      if (op === "page") return open(path, Number(value));
      if (op === "retry") return open(path, offset, preview?.name);
    }
    function editTarget() {
      if (!selected || !preview) return null;
      return {volume:selected.id, path:[path, preview.name].filter(Boolean).join("/"), name:preview.name};
    }
    function saved(target, text) {
      const current = editTarget();
      if (current?.volume === target.volume && current.path === target.path) {
        preview.result = {text:text.slice(0,65536), truncated:text.length > 65536};
      }
    }
    return { watch, leave, sidebar, view, action, editTarget, request, saved, active: () => Boolean(selected) };
  };
})();
