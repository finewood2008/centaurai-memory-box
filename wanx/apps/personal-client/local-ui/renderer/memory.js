(() => {
  const origin = "wanx-memory://local";
  let host, generation = 0;

  async function open() {
    const target = host;
    const section = target.dataset.memorySection;
    const request = ++generation;
    target.replaceChildren();
    const status = document.createElement("p");
    status.className = "notice";
    status.setAttribute("role", "status");
    status.textContent = section === "my-ai" ? "正在打开我的 AI…" : "正在打开记忆…";
    target.append(status);
    let connection;
    try { connection = await window.wanxClient.openMemory(); } catch { /* Offer retry below. */ }
    if (request !== generation || !target.isConnected) return;
    if (!connection?.available || !/^[a-f0-9]{64}$/.test(connection.token)) {
      status.textContent = "记忆组件暂不可用。";
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "button";
      retry.textContent = "重试";
      retry.addEventListener("click", open);
      target.append(retry);
      return;
    }
    const url = new URL(`${origin}/wanx-memory.html`);
    if (section === "my-ai") url.searchParams.set("section", section);
    const source = target.dataset.memoryAgent;
    if (!section && target.dataset.memoryPage === "backup") {
      url.searchParams.set("memoryPage", "backup");
    } else if (!section && source) {
      url.searchParams.set("memoryPage", "memories");
      url.searchParams.set("memoryAgent", source);
    }
    url.hash = new URLSearchParams({ session: connection.token }).toString();
    const frame = document.createElement("iframe");
    frame.title = section === "my-ai" ? "我的 AI" : "智能体记忆";
    frame.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms");
    frame.src = url.href;
    target.replaceChildren(frame);
  }

  window.addEventListener?.("message", event => {
    if (event.origin !== origin || !host?.isConnected || event.source !== host.querySelector("iframe")?.contentWindow) return;
    if (event.data?.type === "wanx-accessory-project" && !host.dataset.memorySection &&
        ["disk","clip"].includes(event.data.kind) && /^m-\d{8}-\d{6}-[a-f0-9]{6}$/.test(event.data.id))
      window.dispatchEvent(new CustomEvent("wanx:accessory-project", {detail:{kind:event.data.kind, id:event.data.id}}));
    if (event.data?.type === "wanx-view-agent-memory" && host.dataset.memorySection === "my-ai" &&
        typeof event.data.source === "string" && /^[a-z0-9_]{1,40}$/.test(event.data.source))
      window.dispatchEvent(new CustomEvent("wanx:view-agent-memory", { detail: event.data.source }));
    if (event.data?.type === "wanx-my-ai-destination" && host.dataset.memorySection === "my-ai" &&
        (event.data.destination === "backup" || event.data.destination === "boxes"))
      window.dispatchEvent(new CustomEvent("wanx:my-ai-destination", { detail: event.data.destination }));
    if (event.data?.type === "wanx-local-memory-space" && host.dataset.memorySection === "my-ai")
      window.dispatchEvent(new CustomEvent("wanx:local-memory-space"));
  });

  window.wanxMemory = {
    reset() {
      host?.replaceChildren();
      host = undefined;
      generation++;
    },
    mount(target) {
      if (target === host) return;
      host = target;
      if (host) void open();
      else generation++;
    },
  };
})();
