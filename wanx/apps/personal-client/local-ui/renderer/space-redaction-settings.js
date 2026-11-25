(() => {
  const MAX_RULES = 30;
  const ERROR_MESSAGES = Object.freeze({
    ACCOUNT_LOGIN_REQUIRED: "请先登录或解锁本地身份。",
    SPACE_CONTEXT_CHANGED: "当前身份已切换，请重新打开脱敏设置。",
    SPACE_REDACTION_RULES_CONFLICT: "规则已更新。请重新读取规则后再编辑，当前未保存的修改会被清除。",
    SPACE_REDACTION_RULES_INVALID: "请检查规则名称、匹配文字和重复项。",
    SPACE_REDACTION_RULES_UNAVAILABLE: "暂时无法读取或保存脱敏规则，请重试。",
  });

  window.createSpaceRedactionSettings = ({ request, escapeHTML }) => {
    const newState = scope => ({ scope, open: false, pending: false, rules: null, error: "", saved: false, conflict: false });
    let state = newState(null);
    let host = null;

    function editor() {
      if (!state.rules) return state.pending ? '<p class="muted" role="status">正在读取规则…</p>' : "";
      const { builtins, customRules } = state.rules;
      return `<form class="space-redaction-editor" autocomplete="off">
        <fieldset ${state.pending || state.conflict ? "disabled" : ""}>
          <legend>内置规则</legend>
          <div class="space-redaction-builtins">${builtins.map((rule, index) => `<label><input type="checkbox" data-redaction-field="builtin" data-index="${index}" ${rule.enabled ? "checked" : ""} /> ${escapeHTML(rule.label)}</label>`).join("")}</div>
        </fieldset>
        <fieldset ${state.pending || state.conflict ? "disabled" : ""}>
          <legend>自定义规则</legend>
          <p class="muted">精确匹配输入文字，区分大小写。命中内容统一替换为 <code>****</code>。</p>
          ${customRules.map((rule, index) => `<div class="space-redaction-rule">
            <label>规则名称<input id="space-redaction-name-${index}" type="text" data-redaction-field="name" data-index="${index}" maxlength="60" value="${escapeHTML(rule.name)}" required /></label>
            <label>匹配文字<input type="text" data-redaction-field="value" data-index="${index}" maxlength="200" value="${escapeHTML(rule.value)}" spellcheck="false" required /></label>
            <button type="button" class="button small" data-redaction-action="remove" data-index="${index}" aria-label="删除第 ${index + 1} 条规则">删除</button>
          </div>`).join("")}
          <button type="button" id="space-redaction-add" class="button small" data-redaction-action="add" ${customRules.length >= MAX_RULES ? "disabled" : ""}>添加规则</button>
          ${customRules.length >= MAX_RULES ? '<p class="muted">已达到 30 条规则上限。</p>' : ""}
        </fieldset>
        <div class="settings-actions">
          <button type="submit" id="space-redaction-save" class="button primary small" ${state.pending || state.conflict ? "disabled" : ""}>${state.pending ? "正在保存…" : "保存规则"}</button>
        </div>
      </form>`;
    }

    function render(focusId) {
      if (!host) return;
      host.innerHTML = `<section class="space-redaction-settings" aria-labelledby="space-redaction-heading">
        <div class="settings-panel space-redaction-heading">
          <div><h3 id="space-redaction-heading">空间脱敏规则 ${window.memoGuideShell?'<button type="button" class="guide-term" data-guide-term="space-redaction" aria-label="让 CentaurAI 解释空间脱敏规则">✨</button>':''}</h3><p class="muted">在空间的文件菜单选择「脱敏」时使用。规则保存在本客户端。</p></div>
          <button type="button" id="space-redaction-toggle" class="button small" data-redaction-action="toggle" aria-expanded="${state.open}" ${!state.scope || state.pending ? "disabled" : ""}>${state.open ? "收起" : "管理规则"}</button>
        </div>
        ${!state.scope ? `<p class="muted space-redaction-unavailable">请先登录或选择盒子的本地身份。</p>` : ""}
        ${state.open ? `<div class="space-redaction-content" aria-busy="${state.pending}">
          <p class="muted">支持 UTF-8 的 TXT、MD、LOG、CSV、TSV、JSON，以及可提取正文的 PDF、DOCX、XLSX、PPTX。表格、JSON、Office 和 PDF 生成 TXT 副本。扫描件需先转为可复制文字。</p>
          ${state.error ? `<p class="notice error" role="alert">${escapeHTML(state.error)}</p>` : ""}
          ${state.saved ? '<p class="notice success" role="status">空间脱敏规则已保存。</p>' : ""}
          ${editor()}
          ${(state.error && !state.rules || state.conflict) ? '<button type="button" id="space-redaction-reload" class="button small" data-redaction-action="load">重新读取规则</button>' : ""}
        </div>` : ""}
      </section>`;
      if (focusId) host.querySelector?.(`#${focusId}`)?.focus?.({ preventScroll: true });
    }

    async function run(action, input) {
      const active = state;
      const saving = action === "space.save-redaction-rules";
      active.pending = true;
      active.error = "";
      active.saved = false;
      active.conflict = false;
      render();
      try {
        const result = await request(action, input);
        if (state !== active) return;
        active.rules = {
          owner: result.owner, revision: result.revision,
          builtins: result.builtins.map(rule => ({ ...rule })), customRules: result.customRules.map(rule => ({ ...rule })),
        };
        active.saved = saving;
      } catch (error) {
        if (state !== active) return;
        active.conflict = error.code === "SPACE_REDACTION_RULES_CONFLICT";
        active.error = ERROR_MESSAGES[error.code] || "暂时无法读取或保存脱敏规则，请重试。";
      } finally {
        if (state === active) {
          active.pending = false;
          render(!active.rules || active.conflict ? "space-redaction-reload" : saving ? "space-redaction-save" : "space-redaction-toggle");
        }
      }
    }

    function click(event) {
      const button = event.target.closest?.("[data-redaction-action]");
      if (!button) return;
      event.stopPropagation();
      if (!state.scope || state.pending || button.disabled) return;
      const action = button.dataset.redactionAction;
      if (action === "toggle") {
        if (state.open) {
          state = newState(state.scope);
          render("space-redaction-toggle");
        } else {
          state.open = true;
          void run("space.redaction-rules");
        }
        return;
      }
      if (!state.open) return;
      if (action === "load") {
        state.rules = null;
        void run("space.redaction-rules");
        return;
      }
      if (!state.rules || state.conflict) return;
      const rules = state.rules.customRules;
      state.saved = false;
      state.error = "";
      if (action === "add" && rules.length < MAX_RULES) {
        rules.push({ name: "", value: "" });
        render(`space-redaction-name-${rules.length - 1}`);
      }
      const index = Number(button.dataset.index);
      if (action === "remove" && Number.isInteger(index) && rules[index]) {
        rules.splice(index, 1);
        render(rules[index] ? `space-redaction-name-${index}` : "space-redaction-add");
      }
    }

    function input(event) {
      const field = event.target.dataset?.redactionField;
      if (!field || !state.rules || state.pending || state.conflict) return;
      const index = Number(event.target.dataset.index);
      if (field === "builtin" && state.rules.builtins[index]) state.rules.builtins[index].enabled = event.target.checked;
      const rule = state.rules.customRules[index];
      if (rule && (field === "name" || field === "value")) rule[field] = event.target.value;
      if (state.saved) {
        state.saved = false;
        host.querySelector?.(".space-redaction-content .notice.success")?.remove();
      }
    }

    function submit(event) {
      event.preventDefault();
      event.stopPropagation();
      if (!state.rules || state.pending || state.conflict) return;
      const { owner, revision, builtins, customRules } = state.rules;
      const rules = customRules.map(({ name, value }) => ({ name: name.trim(), value }));
      if (rules.some(({ name, value }) => !name || !value.trim())) {
        state.error = "请填写每条自定义规则的名称和匹配文字。";
        render("space-redaction-save");
        return;
      }
      void run("space.save-redaction-rules", {
        owner, revision, builtins: builtins.map(({ id, enabled }) => ({ id, enabled })), customRules: rules,
      });
    }

    return {
      sync(scope) {
        if (state.scope === scope) return;
        state = newState(scope);
        render();
      },
      mount(next) {
        if ((next || null) === host) return;
        host?.removeEventListener("click", click);
        host?.removeEventListener("input", input);
        host?.removeEventListener("submit", submit);
        host = next || null;
        host?.addEventListener("click", click);
        host?.addEventListener("input", input);
        host?.addEventListener("submit", submit);
        render();
      },
    };
  };
})();
