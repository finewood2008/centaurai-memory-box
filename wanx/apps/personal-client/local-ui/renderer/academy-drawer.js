(() => {
  "use strict";

  const panelMarkup = `
    <header class="academy-toolbar">
      <div id="academy-tabs" class="academy-tabs" role="tablist" aria-label="万象小助理板块">
        <button id="academy-tab-assistant" role="tab" aria-selected="true" aria-controls="academy-assistant" type="button">小助理</button>
        <button id="academy-tab-academy" role="tab" aria-selected="false" aria-controls="academy-resources" tabindex="-1" type="button">半人马AI学院</button>
      </div>
      <button id="academy-close" class="academy-icon-button" type="button" aria-label="收起万象小助理" title="收起万象小助理">×</button>
    </header>
    <section id="academy-assistant" role="tabpanel" aria-labelledby="academy-tab-assistant">
      <section id="academy-dialogue" aria-label="万象对话">
        <div id="academy-dialogue-host"></div>
      </section>
    </section>

    <section id="academy-resources" class="content-panel" role="tabpanel" aria-labelledby="academy-tab-academy" tabindex="0" hidden>
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

  window.createAcademyDrawer = ({ root, request, onSuggestion, onOpenChange, onTabChange, onVisibilityRequest }) => {
    if (!root) return;
    const app = document.getElementById("app");
    const drawer = document.createElement("aside");
    drawer.id = "academy-drawer";
    drawer.setAttribute("aria-label", "万象小助理");
    drawer.hidden = true;
    drawer.innerHTML = panelMarkup;
    const handle = document.createElement("button");
    handle.id = "academy-edge-handle";
    handle.type = "button";
    handle.hidden = true;
    handle.setAttribute("aria-controls", drawer.id);
    handle.setAttribute("aria-expanded", "false");
    handle.innerHTML = '<img src="./assets/centaurai-mark.png" width="20" height="20" alt="" aria-hidden="true" />';
    root.append(drawer, handle);

    const $ = id => drawer.querySelector("#academy-" + id);
    const courseStatus = $("course-status");
    const mentorStatus = $("mentor-status");
    const helpToggle = document.createElement("button");
    helpToggle.id = "academy-help-toggle";
    helpToggle.type = "button";
    helpToggle.textContent = "万象帮助";
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
        <button id="academy-close-page-help" type="button" aria-label="关闭万象帮助" title="关闭万象帮助">×</button>
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
    const tabs = $("tabs");
    if (!request) $("tab-academy").remove();
    const buttons = [...tabs.querySelectorAll('[role="tab"]')];
    const tabSection = tab => tab.id.slice("academy-tab-".length);
    const availableNow = () => available && !blocked;
    const visible = () => availableNow() && opened;
    const currentTab = () => $("tab-" + section);

    function selectPanel(nextSection) {
      if (nextSection === section) return;
      section = nextSection;
      for (const tab of buttons) {
        const selected = tabSection(tab) === section;
        tab.setAttribute("aria-selected", String(selected));
        tab.tabIndex = selected ? 0 : -1;
        drawer.querySelector("#" + tab.getAttribute("aria-controls")).hidden = !selected;
      }
      onTabChange?.(section);
    }

    for (const tab of buttons) tab.addEventListener("click", () => selectPanel(tabSection(tab)));
    tabs.addEventListener("keydown", event => {
      const index = buttons.indexOf(event.target);
      if (index < 0 || event.altKey || event.ctrlKey || event.metaKey) return;
      let next;
      if (event.key === "ArrowLeft") next = buttons[(index + buttons.length - 1) % buttons.length];
      else if (event.key === "ArrowRight") next = buttons[(index + 1) % buttons.length];
      else if (event.key === "Home") next = buttons[0];
      else if (event.key === "End") next = buttons.at(-1);
      if (!next) return;
      event.preventDefault();
      selectPanel(tabSection(next));
      next.focus();
    });

    function paintVisibility(wasVisible) {
      const shown = visible();
      drawer.hidden = !shown;
      handle.hidden = !availableNow();
      document.body.classList.toggle("academy-drawer-open", shown);
      handle.setAttribute("aria-expanded", String(shown));
      const label = shown ? "收起万象小助理" : "打开万象小助理";
      handle.setAttribute("aria-label", label);
      handle.title = label;
      if (shown !== wasVisible) onOpenChange?.(shown);
    }

    function open(next) {
      if (!available || (opened && !next)) return;
      const nextSection = request && next === "academy" ? "academy" : "assistant";
      if (opened && section === nextSection) return;
      const wasVisible = visible();
      selectPanel(nextSection);
      opened = true;
      paintVisibility(wasVisible);
      if (visible()) currentTab().focus({ preventScroll: true });
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
    handle.addEventListener("pointerdown", event => {
      if (!event.isPrimary || event.button !== 0) return;
      suppressClick = false;
      gesture = { id: event.pointerId, x: event.clientX, y: event.clientY };
      if (event.isTrusted) handle.setPointerCapture(event.pointerId);
    });
    handle.addEventListener("pointerup", event => {
      if (gesture?.id !== event.pointerId) return;
      const dx = event.clientX - gesture.x;
      const dy = event.clientY - gesture.y;
      gesture = undefined;
      if (Math.max(Math.abs(dx), Math.abs(dy)) < 14) return;
      suppressClick = true;
      if (Math.abs(dx) >= 40 && Math.abs(dx) > Math.abs(dy) && (opened ? dx > 0 : dx < 0)) toggle();
    });
    handle.addEventListener("pointercancel", () => { gesture = undefined; });
    handle.addEventListener("click", event => {
      if (suppressClick && event.detail) { suppressClick = false; return; }
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
      mountPageHelp(anchor, actions) {
        if (anchor && pageHelpControl.nextElementSibling !== anchor) anchor.before(pageHelpControl);
        if (actions && helpToggle.parentElement !== actions) actions.append(helpToggle);
      },
      isDialogueVisible: () => visible() && section === "assistant",
    };
  };
})();
