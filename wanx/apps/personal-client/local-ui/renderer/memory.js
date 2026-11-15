(() => {
  const origin = "wanx-memory://local";
  const settingsSections = new Set(["models", "budget"]);
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
    if (section === "my-ai" || settingsSections.has(section)) url.searchParams.set("section", section);
    url.hash = new URLSearchParams({ session: connection.token }).toString();
    const frame = document.createElement("iframe");
    frame.title = section === "my-ai" ? "我的 AI" : url.search ? "记忆配置" : "记忆工作台";
    frame.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms");
    frame.src = url.href;
    target.replaceChildren(frame);
  }

  window.addEventListener?.("message", event => {
    if (event.origin !== origin || !host?.isConnected || event.source !== host.querySelector("iframe")?.contentWindow) return;
    if (event.data?.type === "wanx-memory-settings" && settingsSections.has(event.data.section))
      window.dispatchEvent(new CustomEvent("wanx:memory-settings", { detail: event.data.section }));
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
