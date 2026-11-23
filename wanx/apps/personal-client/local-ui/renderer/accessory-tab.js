window.createAccessoriesPreview = function createAccessoriesPreview(request) {
  let host = null;
  let project = null;
  let frame = 0;
  let version = 0;
  let lastBounds = "";
  let status = "loading";

  function paint() {
    if (!host) return;
    const feedback = host.querySelector("[data-accessories-feedback]");
    feedback.hidden = status === "ready";
    feedback.querySelector("[role='status']").textContent = status === "error"
      ? "暂时无法打开配件工作台。"
      : "正在打开配件工作台…";
    feedback.querySelector("[data-action='accessories-preview-retry']").hidden = status !== "error";
  }

  async function sync() {
    frame = 0;
    if (!host?.isConnected) return;
    const rect = host.getBoundingClientRect();
    const left = Math.max(0, Math.ceil(rect.left));
    const top = Math.max(0, Math.ceil(rect.top));
    const right = Math.min(window.innerWidth, Math.floor(rect.right));
    const bottom = Math.min(window.innerHeight, Math.floor(rect.bottom));
    if (right <= left || bottom <= top) return;
    const bounds = { x: left, y: top, width: right - left, height: bottom - top };
    const key = JSON.stringify([bounds, project]);
    if (key === lastBounds) return;
    lastBounds = key;
    const current = ++version;
    try {
      const target = project;
      const response = await request({ visible: true, bounds, ...(target && {project:target}) });
      if (target && target === project && response?.value?.status === "ready") project = null;
      if (current !== version) return;
      status = response?.ok && response.value?.status === "ready" ? "ready" : "error";
    } catch {
      if (current !== version) return;
      status = "error";
    }
    paint();
  }

  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(sync);
  };
  const observer = new ResizeObserver(schedule);

  return {
    openProject(target) { project = target; lastBounds = ""; schedule(); },
    mount(next) {
      if (next === host) return;
      observer.disconnect();
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      host = next;
      if (host) {
        paint();
        observer.observe(host);
        schedule();
      } else {
        ++version;
        if (lastBounds) void request({ visible: false }).catch(() => {});
        lastBounds = "";
        status = "loading";
      }
    },
    retry() {
      if (!host) return;
      lastBounds = "";
      status = "loading";
      paint();
      schedule();
    },
  };
};
