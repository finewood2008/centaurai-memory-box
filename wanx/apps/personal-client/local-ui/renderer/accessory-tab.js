window.createAccessoriesPreview = function createAccessoriesPreview(request) {
  let host, scope, frame, catalogHost, status, version = 0;
  let items = [];

  function feedback(state) {
    status = state;
    const panel = host.querySelector("[data-accessories-feedback]");
    panel.hidden = state === "ready";
    panel.querySelector("[role=status]").textContent = state === "error"
      ? "暂时无法打开配件工作台。" : "正在打开配件工作台…";
    panel.querySelector("button").hidden = state !== "error";
  }

  async function open() {
    const ticket = ++version;
    frame?.remove();
    frame = catalogHost = undefined;
    items = [];
    feedback("loading");
    try {
      const result = await request({visible:true});
      if (version !== ticket) return;
      if (!result?.ok || !/^[a-f0-9]{32}\.local$/.test(result.value?.catalogHost)) throw Error();
      catalogHost = result.value.catalogHost;
      frame = document.createElement("iframe");
      frame.title = "配件目录";
      frame.setAttribute("sandbox", "allow-scripts allow-same-origin");
      frame.src = "wanx-accessories://" + catalogHost + "/accessories";
      frame.hidden = true;
      frame.addEventListener("load", () => {
        if (ticket === version && status === "loading") {
          frame.contentWindow.postMessage({type:"catalog-check"}, "wanx-accessories://" + catalogHost);
          setTimeout(() => {
            if (ticket === version && status === "loading") feedback("error");
          }, 2500);
        }
      });
      host.append(frame);
    } catch {
      if (ticket === version) feedback("error");
    }
  }

  async function openItem(key, owner) {
    if (!owner || owner !== catalogHost) return false;
    const reply = await request({guideOpen:key, catalogHost:owner});
    return reply?.ok && reply.value?.status === "ready";
  }

  window.addEventListener?.("message", event => {
    if (!frame || event.source !== frame.contentWindow || event.origin !== "wanx-accessories://" + catalogHost) return;
    const message = event.data;
    if (message?.type === "catalog-items" && Array.isArray(message.items)) {
      items = message.items.filter(item => ["disk","clip","storage"].includes(item?.key)
        && typeof item.title === "string" && typeof item.status === "string");
      feedback("ready");
      frame.hidden = false;
    } else if (message?.type === "catalog-open" && items.some(item => item.key === message.key)) {
      void openItem(message.key, catalogHost);
    } else if (message?.type === "catalog-background") window.memoGuideShell?.dismissOnBackground();
    else if (message?.type === "catalog-guide") document.querySelector("#academy-edge-handle")?.click();
  });

  return {
    mount(next, nextScope) {
      if (host === next && (!next || scope === nextScope)) return;
      ++version;
      frame?.remove();
      if (host) void request({visible:false}).catch(() => {});
      frame = catalogHost = undefined;
      items = [];
      host = next;
      scope = nextScope;
      if (host) void open();
    },
    retry() { if (host) void open(); },
    guideRecords(query) {
      const owner = catalogHost;
      return items.filter(i => i.title.includes(query)).map(i => ({...i, source:"配件目录", open:() => openItem(i.key, owner)}));
    },
    guideFacts() {
      return {工作台:({ready:"已打开配件目录", loading:"加载中", error:"加载失败"})[status],
        配件状态:items.map(i => i.title + "：" + i.status).join("，")};
    },
  };
};
