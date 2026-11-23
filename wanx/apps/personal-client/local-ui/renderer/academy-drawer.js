(() => {
  "use strict";

  const panelMarkup = `
    <header class="academy-toolbar">
      <div class="academy-title-group">
        <h2 id="academy-title" tabindex="-1">知君</h2>
        <span class="academy-title-caption" lang="en">memory agent</span>
      </div>
      <div class="academy-tools">
        <button id="academy-note-tool" class="academy-tool" aria-expanded="false" aria-controls="academy-note" type="button">
          <svg class="academy-note-tool-icon" viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.5 3.5h11a1 1 0 0 1 1 1v6.9l-4.1 5.1H4.5a1 1 0 0 1-1-1v-11a1 1 0 0 1 1-1Z"/><path d="M11.7 16.4v-4.1a1 1 0 0 1 1-1h3.7M7 7h6M7 10h3"/></svg>
          <svg class="academy-return-icon" viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m8 5-5 5 5 5M3 10h13"/></svg>
          <span>便签</span>
        </button>
        <button id="academy-resource-tool" class="academy-tool" aria-expanded="false" aria-controls="academy-resources" type="button">学院</button>
        <button id="academy-close" class="academy-icon-button" type="button" aria-label="收起知君侧栏" title="收起知君侧栏">×</button>
      </div>
    </header>
    <section id="academy-assistant" aria-label="知君对话">
      <section id="academy-dialogue" aria-label="与知君对话">
        <div id="academy-dialogue-host"></div>
      </section>
    </section>

    <section id="academy-note" aria-label="便签" hidden></section>

    <section id="academy-resources" class="content-panel" aria-label="半人马AI学院" tabindex="0" hidden>
      <section class="resource-card">
        <h2>学院课程</h2>
        <p>前往学院官网查看公开课程与开课安排。</p>
        <div class="resource-links">
          <button id="academy-course-browser" class="secondary" type="button">学院课程官网 <span aria-hidden="true">↗</span></button>
        </div>
        <p id="academy-course-status" class="resource-status" role="status"></p>
      </section>

      <section class="resource-card">
        <h2>向学院导师请教</h2>
        <p>遇到需要人工协助的问题，可以通过企业微信联系学院导师。</p>
        <figure class="mentor-qr">
          <img id="academy-mentor-qr" src="../academy-copilot/qr-wecom-kf.png" width="176" height="176" alt="半人马AI学院官方企业微信咨询二维码">
          <figcaption>用微信扫一扫，开始咨询</figcaption>
        </figure>
        <div class="resource-links">
          <button id="academy-teacher" class="teacher" type="button">
            <span>联系学院导师</span><span class="channel">企业微信 <span aria-hidden="true">↗</span></span>
          </button>
        </div>
      </section>
      <p id="academy-mentor-status" class="resource-status" role="status"></p>
    </section>
  `;

  function readPageHelp(state) {
    const context = state?.context;
    const workshop = context?.module === "workshop";
    const text = (value, limit) => typeof value === "string"
      ? value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, limit) : "";
    const label = text(context?.label, 60);
    const examples = Array.isArray(context?.examples)
      ? [...new Set(context.examples.map(value => text(value, 120)).filter(Boolean))].slice(0, 4) : [];
    const fallbackExample = text(context?.example, 120);
    if (!examples.length && fallbackExample) examples.push(fallbackExample);
    return {
      label: workshop && label ? `工坊 · ${label}` : label,
      hint: text(context?.hint, 256),
      errorHint: workshop && typeof context.errorCode === "string" && /^[A-Z][A-Z0-9_]{1,79}$/.test(context.errorCode)
        ? text(context.errorHint, 160) : "",
      examples,
    };
  }

  function formatPageHelp(state) {
    const { label, hint, errorHint } = readPageHelp(state);
    if (!label) return "";
    const lines = [`当前页面：${label}`];
    if (hint) lines.push(`操作提示：${hint}`);
    if (errorHint) lines.push(`工坊提示：${errorHint}`);
    lines.push("请在相关时参考当前页面，优先回答用户实际问题。");
    return lines.join("\n");
  }

  window.createAcademyDrawer = ({ root, request, onSuggestion, onOpenChange, onTabChange, onSectionRequest, onVisibilityRequest }) => {
    if (!root) return;
    const app = document.getElementById("app");
    const drawer = document.createElement("aside");
    drawer.id = "academy-drawer";
    drawer.setAttribute("aria-label", "知君侧栏");
    drawer.inert = true;
    drawer.innerHTML = panelMarkup;
    const handle = document.createElement("button");
    handle.id = "academy-edge-handle";
    handle.type = "button";
    handle.hidden = true;
    handle.setAttribute("aria-controls", drawer.id);
    handle.setAttribute("aria-expanded", "false");
    handle.innerHTML = '<span class="academy-edge-mark"><img src="./assets/centaurai-mark.png" width="17" height="17" alt="" draggable="false" /></span>';
    root.append(drawer, handle);

    const $ = id => drawer.querySelector("#academy-" + id);
    const courseStatus = $("course-status");
    const mentorStatus = $("mentor-status");
    const helpToggle = document.createElement("button");
    helpToggle.id = "academy-help-toggle";
    helpToggle.type = "button";
    helpToggle.textContent = "记忆盒子帮助";
    helpToggle.title = "开启后，发送时参考当前页面";
    helpToggle.setAttribute("aria-controls", "academy-page-help");

    const pageHelpControl = document.createElement("div");
    pageHelpControl.id = "academy-page-help-control";
    pageHelpControl.innerHTML = `
      <section id="academy-page-help" aria-label="当前页面帮助" hidden>
        <div class="academy-page-context">
          <span>当前页面</span>
          <strong id="academy-stage"></strong>
        </div>
        <details id="academy-page-hints" hidden>
          <summary>操作提示</summary>
          <p id="academy-hint"></p>
          <p id="academy-error-hint" hidden></p>
        </details>
        <button id="academy-close-page-help" type="button" aria-label="关闭记忆盒子帮助" title="关闭记忆盒子帮助">×</button>
        <div id="academy-question-list" hidden>
          <p id="academy-question-heading">常用问题</p>
          <ul id="academy-examples" aria-labelledby="academy-question-heading"></ul>
        </div>
      </section>
    `;
    const pageHelp = pageHelpControl.querySelector("#academy-page-help");
    const stage = pageHelp.querySelector("#academy-stage");
    const hints = pageHelp.querySelector("#academy-page-hints");
    const hint = pageHelp.querySelector("#academy-hint");
    const errorHint = pageHelp.querySelector("#academy-error-hint");
    const questions = pageHelp.querySelector("#academy-question-list");
    const examples = pageHelp.querySelector("#academy-examples");
    let pageHelpEnabled = true;

    function paintPageHelp() {
      helpToggle.setAttribute("aria-pressed", String(pageHelpEnabled));
      pageHelp.hidden = !pageHelpEnabled || !stage.textContent;
    }
    paintPageHelp();

    function sync(state) {
      const page = readPageHelp(state);
      if (stage.textContent !== page.label) hints.open = false;
      stage.textContent = page.label;
      hint.textContent = page.hint;
      errorHint.textContent = page.errorHint;
      hint.hidden = !hint.textContent;
      errorHint.hidden = !errorHint.textContent;
      hints.hidden = hint.hidden && errorHint.hidden;
      const currentExamples = [...examples.querySelectorAll("button")];
      if (currentExamples.length !== page.examples.length ||
          currentExamples.some((button, index) => button.textContent !== page.examples[index])) {
        const items = page.examples.map(question => {
          const item = document.createElement("li");
          const button = document.createElement("button");
          button.type = "button";
          button.title = "填入对话草稿";
          button.setAttribute("aria-description", "填入对话草稿");
          button.textContent = question;
          item.append(button);
          return item;
        });
        examples.replaceChildren(...items);
      }
      questions.hidden = !page.examples.length;
      paintPageHelp();
    }

    helpToggle.addEventListener("click", () => {
      pageHelpEnabled = !pageHelpEnabled;
      paintPageHelp();
    });
    pageHelp.querySelector("#academy-close-page-help").addEventListener("click", () => {
      pageHelpEnabled = false;
      paintPageHelp();
      helpToggle.focus({ preventScroll: true });
    });
    examples.addEventListener("click", event => {
      const button = event.target.closest("button");
      if (!button || pageHelp.hidden) return;
      onSuggestion?.(button.textContent);
    });

    async function openResource(event, name, error) {
      const button = event.currentTarget;
      const status = name === "teacher" ? mentorStatus : courseStatus;
      button.disabled = true;
      status.textContent = "";
      try {
        const result = await request(name);
        if (!result?.ok) status.textContent = error;
      } catch {
        status.textContent = error;
      } finally {
        button.disabled = false;
      }
    }

    let opened = false;
    let available = false;
    let blocked = false;
    let section = "assistant";
    const noteTool = $("note-tool");
    const resourceTool = $("resource-tool");
    if (!request) resourceTool.remove();
    const availableNow = () => available && !blocked;
    const visible = () => availableNow() && opened;

    function selectPanel(nextSection) {
      if (nextSection === section) return;
      section = nextSection;
      const notesOpen = section === "note";
      const resourcesOpen = section === "academy";
      $("assistant").hidden = section !== "assistant";
      $("note").hidden = !notesOpen;
      $("resources").hidden = !resourcesOpen;
      noteTool.setAttribute("aria-expanded", String(notesOpen));
      noteTool.querySelector("span").textContent = notesOpen ? "返回对话" : "便签";
      resourceTool.setAttribute("aria-expanded", String(resourcesOpen));
      resourceTool.textContent = resourcesOpen ? "返回对话" : "学院";
      onTabChange?.(section);
    }

    function requestSection(next) {
      if (onSectionRequest) onSectionRequest(next);
      else open(next);
    }

    noteTool.addEventListener("click", () => requestSection(section === "note" ? "assistant" : "note"));
    if (request) resourceTool.addEventListener("click", () => requestSection(section === "academy" ? "assistant" : "academy"));

    function paintVisibility(wasVisible) {
      const shown = visible();
      if (!availableNow() || shown !== wasVisible) resetPull();
      drawer.inert = !shown;
      handle.hidden = !availableNow();
      document.body.classList.toggle("academy-drawer-open", shown);
      handle.setAttribute("aria-expanded", String(shown));
      const label = shown ? "收起知君侧栏" : "打开知君侧栏";
      handle.setAttribute("aria-label", label);
      handle.title = shown ? "向右拖动或点击，收起知君侧栏" : "向左拖动或点击，打开知君侧栏";
      if (shown !== wasVisible) onOpenChange?.(shown);
    }

    function open(next) {
      if (!available || (opened && !next)) return;
      const nextSection = next === "note" || (next === "academy" && request) ? next : "assistant";
      if (opened && section === nextSection) return;
      const wasVisible = visible();
      selectPanel(nextSection);
      opened = true;
      paintVisibility(wasVisible);
      if (visible()) (section === "note" ? noteTool : section === "academy" ? resourceTool : $("title"))
        .focus({ preventScroll: true });
    }

    function close({ restoreFocus = true } = {}) {
      if (!opened) return;
      const wasVisible = visible();
      opened = false;
      paintVisibility(wasVisible);
      if (wasVisible && restoreFocus) handle.focus({ preventScroll: true });
    }

    const requestVisibility = (show) => {
      if (onVisibilityRequest) return onVisibilityRequest(show);
      if (show ?? !opened) open();
      else close();
    };
    const toggle = () => requestVisibility();

    let gesture;
    let suppressClick = false;

    function resetPull() {
      gesture = undefined;
      root.classList.remove("is-pulling");
      root.style.removeProperty("--academy-reveal");
    }

    function finishPull(target, velocity) {
      const distance = target - gesture.position;
      if (Math.abs(distance) > 1) {
        const duration = parseFloat(getComputedStyle(root).getPropertyValue("--academy-slide-duration"));
        // Sample a critically damped spring so the release picks up at the pointer's speed.
        const damping = 8.4;
        const slope = Math.max(-3, Math.min(damping, velocity * duration / distance));
        const points = Array.from({ length: 23 }, (_, i) => {
          const time = (i + 1) / 24;
          return (1 + Math.exp(-damping * time) * (-1 + (slope - damping) * time)).toFixed(4);
        });
        root.style.setProperty("--academy-release-curve", `linear(0, ${points.join(", ")}, 1)`);
      }
      resetPull();
    }

    function trackPull(event) {
      if (gesture?.id !== event.pointerId) return;
      const dx = event.clientX - gesture.x;
      const dy = event.clientY - gesture.y;
      if (!gesture.axis && Math.max(Math.abs(dx), Math.abs(dy)) >= 8) {
        gesture.axis = Math.abs(dx) > Math.abs(dy) ? "horizontal" : "vertical";
        suppressClick = true;
      }
      if (gesture.axis !== "horizontal") return;
      const pull = gesture.closing ? dx : -dx;
      const reveal = Math.max(0, Math.min(gesture.width, gesture.reveal - dx));
      if (reveal !== gesture.position) {
        const elapsed = Math.max(8, event.timeStamp - gesture.lastMove);
        gesture.velocity = (reveal - gesture.position) / elapsed;
        gesture.position = reveal;
        gesture.lastMove = event.timeStamp;
      }
      root.classList.add("is-pulling");
      root.style.setProperty("--academy-reveal", `${reveal}px`);
      return pull;
    }

    handle.addEventListener("pointerdown", event => {
      if (!event.isPrimary || event.button !== 0) return;
      suppressClick = false;
      root.style.removeProperty("--academy-release-curve");
      const reveal = root.getBoundingClientRect().right - handle.getBoundingClientRect().right;
      gesture = {
        id: event.pointerId, x: event.clientX, y: event.clientY, closing: visible(),
        width: drawer.offsetWidth,
        reveal, position: reveal, lastMove: event.timeStamp, velocity: 0,
      };
      if (event.isTrusted) handle.setPointerCapture(event.pointerId);
    });
    document.addEventListener("pointermove", event => {
      if (gesture?.id !== event.pointerId) return;
      if (event.buttons & 1) trackPull(event);
      else resetPull();
    });
    document.addEventListener("pointerup", event => {
      if (gesture?.id !== event.pointerId) return;
      const pull = trackPull(event);
      const closing = gesture.closing;
      if (gesture.axis === "horizontal") {
        const expanded = pull >= 48 ? !closing : closing;
        const velocity = event.timeStamp - gesture.lastMove <= 48 ? gesture.velocity : 0;
        finishPull(expanded ? gesture.width : 0, velocity);
        if (expanded !== closing) requestVisibility(expanded);
      } else resetPull();
    });
    const cancelPull = event => {
      if (gesture?.id === event.pointerId) resetPull();
    };
    document.addEventListener("pointercancel", cancelPull);
    window.addEventListener("blur", resetPull);
    handle.addEventListener("transitionend", event => {
      if (event.propertyName === "transform") root.style.removeProperty("--academy-release-curve");
    });
    handle.addEventListener("click", event => {
      if (suppressClick && event.detail) { suppressClick = false; return; }
      root.style.removeProperty("--academy-release-curve");
      toggle();
    });
    $("close").addEventListener("click", () => requestVisibility(false));

    document.addEventListener("keydown", event => {
      if (!availableNow() || event.defaultPrevented || event.isComposing || document.querySelector("dialog[open]")) return;
      if (event.key === "Escape" && visible()) {
        event.preventDefault();
        requestVisibility(false);
      } else if (!event.repeat && (event.ctrlKey || event.metaKey) && event.shiftKey && !event.altKey && event.key.toLowerCase() === "k") {
        event.preventDefault();
        toggle();
      }
    });

    let topbar;
    const measure = () => {
      // Page banners belong to the content; both sidebars span below global navigation.
      const bottom = topbar?.getBoundingClientRect().bottom || 0;
      document.body.style.setProperty("--wanx-sidebar-top", `${Math.max(0, bottom)}px`);
    };
    const headerSize = new ResizeObserver(measure);
    const observeHeader = () => {
      const nextTopbar = app?.querySelector(".topbar");
      if (nextTopbar === topbar) return;
      headerSize.disconnect();
      topbar = nextTopbar;
      if (topbar) headerSize.observe(topbar);
      measure();
    };
    if (app) new MutationObserver(observeHeader).observe(app, { childList: true });
    observeHeader();

    $("teacher").addEventListener("click", event => openResource(event, "teacher", "暂时无法打开企业微信，请稍后重试。"));
    $("course-browser").addEventListener("click", event => openResource(event, "course-browser", "暂时无法打开学院课程官网，请稍后重试。"));

    return {
      setAvailable(value) {
        if (available === value) return;
        const wasVisible = visible();
        available = value;
        if (!available) opened = false;
        paintVisibility(wasVisible);
      },
      setBlocked(value) {
        if (blocked === value) return;
        const wasVisible = visible();
        blocked = value;
        paintVisibility(wasVisible);
      },
      isAvailable: availableNow,
      isOpen: () => opened,
      open, close, toggle,
      sync, formatPageHelp,
      isPageHelpEnabled: () => pageHelpEnabled,
      dialogueHost: () => $("dialogue-host"),
      noteHost: () => $("note"),
      mountPageHelp(anchor, actions) {
        if (anchor && pageHelpControl.nextElementSibling !== anchor) anchor.before(pageHelpControl);
        if (actions && helpToggle.parentElement !== actions) actions.append(helpToggle);
      },
      isDialogueVisible: () => visible() && section === "assistant",
      isNoteVisible: () => visible() && section === "note",
    };
  };
})();
