(() => {
  const commandPattern = /^(?:请帮我|请|帮我)?(记住|更正|纠正|忘记|找回)[：:，,\s]+(.+)$/su;

  function button(label, action) {
    const element = document.createElement("button");
    element.type = "button";
    element.textContent = label;
    element.dataset.memoryAction = action;
    return element;
  }

  window.createZhijunMemory = ({ root, call, ready, canWrite, onWriteBlocked, origin, openThread }) => {
    const modal = document.createElement("dialog");
    modal.className = "ai-history-dialog zhijun-memory";
    modal.setAttribute("aria-labelledby", "zhijun-memory-title");
    modal.innerHTML = `
      <header><h3 id="zhijun-memory-title">知君记忆</h3><button type="button" data-memory-action="close" aria-label="关闭">×</button></header>
      <form data-memory-search><input name="query" aria-label="记忆关键词" placeholder="按人名或事情查找" maxlength="300">
      <button>查找</button><button type="button" data-memory-action="new">记一条</button></form>
      <div class="zhijun-memory-toolbar"><button type="button" data-memory-action="external">查本机 AI 记忆</button></div>
      <form data-memory-external hidden>
        <label>来源 <select name="source"><option value="codex">Codex</option><option value="claude_code">Claude Code</option></select></label>
        <input name="query" aria-label="本机 AI 记忆关键词" maxlength="300" placeholder="输入要找的内容" required>
        <button>授权并查询</button><button type="button" data-memory-action="cancel-external">取消</button>
      </form>
      <form data-memory-edit hidden>
        <label>想让我记住什么？<textarea name="text" maxlength="3000" rows="4" placeholder="比如，下次和妈妈去杭州，多留一点喝茶的时间。" required></textarea></label>
        <div class="zhijun-memory-edit-actions"><button type="button" data-memory-action="cancel-edit">取消</button><button type="submit" data-memory-submit>记住</button></div>
      </form>
      <div data-memory-confirm hidden><p></p><button type="button" data-memory-action="forget-confirm">确认忘记</button>
      <button type="button" data-memory-action="cancel-edit">取消</button></div>
      <p data-memory-status role="status" aria-live="polite"></p>
      <div data-memory-results></div>
      <button type="button" data-memory-action="more" hidden>更多记忆</button>`;
    root.append(modal);
    const $ = selector => modal.querySelector(selector);
    const search = $("[data-memory-search]");
    const external = $("[data-memory-external]");
    const editor = $("[data-memory-edit]");
    const confirmation = $("[data-memory-confirm]");
    const content = $("[data-memory-results]");
    const status = $("[data-memory-status]");
    const more = $("[data-memory-action=more]");
    const pageSize = 20;
    let epoch = 0;
    let working = false;
    let offset = 0;
    let editing = null;
    let request = null;
    let intent = null;
    let commandSource = null;
    let composeOnly = false;

    function setComposeMode(value) {
      composeOnly = value;
      modal.classList.toggle("zhijun-memory-compose", value);
      $("#zhijun-memory-title").textContent = value ? "记一件事" : "知君记忆";
    }

    function setWorking(value) {
      working = value;
      for (const element of modal.querySelectorAll("input, select, textarea, button"))
        if (!["close", "cancel-external"].includes(element.dataset.memoryAction)) element.disabled = value;
    }

    function hideEditor() {
      editor.hidden = confirmation.hidden = true;
      editing = request = null;
      content.querySelector("[data-memory-id] button")?.focus();
    }

    function reset() {
      epoch++;
      setWorking(false);
      hideEditor();
      external.hidden = true;
      setComposeMode(false);
      intent = commandSource = null;
      content.replaceChildren();
      status.textContent = "";
      search.reset();
      external.reset();
      more.hidden = true;
      if (modal.open) modal.close();
    }

    function show() {
      $("[data-memory-action=new]").hidden = !canWrite();
      if (!modal.open) modal.showModal();
      if (!ready()) status.textContent = "连接盒子后就可以使用知君记忆。";
      return ready();
    }

    function card(item) {
      const article = document.createElement("article");
      article.dataset.memoryId = item.id || "";
      const body = document.createElement("p");
      body.textContent = item.text;
      const date = new Date(item.createdAt);
      const meta = document.createElement("small");
      meta.textContent = [item.source ? `来自 Memmy · ${item.source}` : "知君记忆 · 本人保存",
        Number.isNaN(date.getTime()) ? "" : date.toLocaleString("zh-CN")].filter(Boolean).join(" · ");
      if (item.title) {
        const title = document.createElement("strong");
        title.textContent = item.title;
        article.append(title);
      }
      article.append(body, meta);
      const actions = document.createElement("div");
      if (item.id) {
        if (item.threadId) {
          const source = button("查看原对话", "source");
          source.addEventListener("click", async () => {
            modal.close();
            try { await openThread(item.threadId, item.messageId); }
            catch { if (ready()) { modal.showModal(); status.textContent = "原对话暂时无法打开。"; } }
          });
          actions.append(source);
        }
        if (canWrite() && intent !== "forget") {
          const edit = button("更正", "correct");
          edit.addEventListener("click", () => editEntry(item));
          actions.append(edit);
        }
        if (canWrite() && intent !== "correct") {
          const forget = button("忘记", "forget");
          forget.addEventListener("click", () => proposeForget(item));
          actions.append(forget);
        }
      }
      article.append(actions);
      return article;
    }

    async function query({ append = false } = {}) {
      if (!show() || working) return;
      setComposeMode(false);
      const ticket = ++epoch;
      if (!append) {
        offset = 0;
        content.replaceChildren();
        more.hidden = true;
      }
      setWorking(true);
      status.textContent = "正在查找…";
      try {
        const value = await call("sidebar-memory", {
          action: "search", query: search.elements.query.value.trim(), limit: pageSize, offset,
        });
        if (ticket !== epoch) return;
        for (const item of value.items) content.append(card(item));
        offset += value.items.length;
        more.hidden = !value.hasMore;
        status.textContent = offset ? (
          intent === "correct" ? "选择要更正的条目。" : intent === "forget" ? "选择要忘记的条目。" : ""
        ) : "我没找到已保存的记忆。";
      } catch { if (ticket === epoch) status.textContent = "暂时无法读取知君记忆，请检查盒子连接后再试。"; }
      finally { if (ticket === epoch) setWorking(false); }
    }

    function editEntry(item = null, text = "", source = origin()) {
      if (!canWrite()) { onWriteBlocked(); return; }
      if (!show() || working) return;
      confirmation.hidden = true;
      editor.hidden = false;
      editing = { action: item ? "correct" : "remember", id: item?.id, source: commandSource || source };
      request = null;
      editor.elements.text.value = item?.text || text;
      $("[data-memory-submit]").textContent = item ? "保存更正" : "记住";
      if (item && commandSource?.prompt) status.textContent = `本次更正：${commandSource.prompt}`;
      editor.elements.text.focus();
    }

    function proposeForget(item) {
      if (!canWrite()) { onWriteBlocked(); return; }
      if (working) return;
      editor.hidden = true;
      confirmation.hidden = false;
      editing = { action: "forget", id: item.id, source: {} };
      request = null;
      confirmation.querySelector("p").textContent =
        `忘记「${item.text}」？知君之后不会将这条内容作为长期记忆使用。原聊天和 Memmy 源记录仍保留。`;
      $("[data-memory-action=forget-confirm]").focus();
    }

    async function save() {
      if (!editing || !ready() || working) return;
      if (!canWrite()) { onWriteBlocked(); return; }
      const text = editing.action === "forget" ? "" : editor.elements.text.value.trim();
      if (editing.action !== "forget" && !text) return;
      const fields = { action: editing.action, id: editing.id, text,
        threadId: editing.source?.threadId, messageId: editing.source?.messageId };
      const signature = JSON.stringify(fields);
      if (request?.signature !== signature) request = { signature, id: crypto.randomUUID() };
      const ticket = ++epoch;
      setWorking(true);
      status.textContent = "等待盒子确认…";
      try {
        const value = await call("sidebar-memory", { ...fields, requestId: request.id });
        if (ticket !== epoch) return;
        const message = editing.action === "forget" ? "已从知君长期记忆移除。"
          : editing.action === "correct" ? "已更正。" : "已记住。";
        hideEditor();
        setWorking(false);
        intent = commandSource = null;
        if (composeOnly && value.item) {
          status.textContent = message;
          $("[data-memory-action=close]").focus();
          return;
        }
        if (value.item) {
          content.replaceChildren(card(value.item));
          more.hidden = true;
          status.textContent = message;
        } else {
          search.elements.query.value = "";
          const refreshed = query();
          const refreshEpoch = epoch;
          await refreshed;
          if (refreshEpoch === epoch) status.textContent = message;
        }
      } catch (error) {
        if (ticket !== epoch) return;
        status.textContent = error.code === "ZHIJUN_ADVANCED_REQUIRED"
          ? "请在当前会话选择高级模式后再试。"
          : error.code === "ZHIJUN_MODE_UNCONFIRMED"
            ? "盒端尚未确认高级模式，输入已保留。"
          : error.code === "ZHIJUN_MEMORY_CHANGED"
          ? "这条记忆已在其他设备更新，请重新查找后再操作。"
          : error.code === "ZHIJUN_MEMORY_NOT_FOUND" && editing.action === "remember"
            ? "当前盒端暂无法保存知君记忆，输入已保留。"
          : "盒子尚未确认结果。可以保留内容并重试。";
      } finally { if (ticket === epoch) setWorking(false); }
    }

    async function searchExternal() {
      if (!ready() || working || !external.reportValidity()) return;
      const ticket = ++epoch;
      setWorking(true);
      content.replaceChildren();
      more.hidden = true;
      status.textContent = "等待本次查询授权…";
      try {
        const value = await call("sidebar-memmy", {
          query: external.elements.query.value.trim(), source: external.elements.source.value,
        });
        if (ticket !== epoch) return;
        content.replaceChildren(...value.items.map(card));
        status.textContent = value.canceled ? "本次查询已取消。" : value.items.length
          ? "本机 AI 记忆 · 本次授权的查询结果" : "在授权来源里没有找到相关记忆。";
      } catch { if (ticket === epoch) status.textContent = "本机记忆服务暂不可用，或本次查询已结束。"; }
      finally { if (ticket === epoch) setWorking(false); }
    }

    function cancelExternal() {
      epoch++;
      void call("sidebar-memory-cancel").catch(() => {});
      external.hidden = true;
      content.replaceChildren();
      status.textContent = "";
      setWorking(false);
    }

    search.addEventListener("submit", event => {
      event.preventDefault();
      if (!working) { hideEditor(); void query(); }
    });
    editor.addEventListener("submit", event => { event.preventDefault(); void save(); });
    external.addEventListener("submit", event => { event.preventDefault(); void searchExternal(); });
    modal.addEventListener("close", () => {
      if (!modal.open && !external.hidden) cancelExternal();
    });
    modal.addEventListener("cancel", event => { if (working && external.hidden) event.preventDefault(); });
    modal.addEventListener("click", event => {
      const action = event.target.closest("button")?.dataset.memoryAction;
      if (action === "close" && (!working || !external.hidden)) modal.close();
      if (action === "new") editEntry();
      if (action === "cancel-edit") {
        hideEditor();
        if (composeOnly) modal.close();
      }
      if (action === "forget-confirm") void save();
      if (action === "more") void query({ append: true });
      if (action === "cancel-external") cancelExternal();
      if (action === "external") {
        hideEditor();
        external.hidden = false;
        external.elements.query.value = search.elements.query.value;
        external.elements.query.focus();
      }
    });

    return {
      open(text = "") {
        hideEditor();
        intent = commandSource = null;
        search.elements.query.value = text.slice(0, 300);
        void query();
      },
      remember(text, messageId) {
        if (working) return;
        if (!canWrite()) { onWriteBlocked(); return; }
        reset();
        setComposeMode(true);
        editEntry(null, text, { ...origin(), messageId });
      },
      recognizes: text => commandPattern.test(text),
      requiresWrite(text) {
        const action = commandPattern.exec(text)?.[1];
        return Boolean(action && action !== "找回");
      },
      command(text) {
        if (!ready() || working) return false;
        const matched = commandPattern.exec(text);
        if (!matched) return false;
        const [, action, body] = matched;
        if (action === "记住") {
          if (body.length > 3000) return false;
          this.remember(body);
          void save();
        } else if (action === "找回") {
          this.open(body);
        } else {
          hideEditor();
          intent = action === "忘记" ? "forget" : "correct";
          commandSource = { ...origin(), prompt: body };
          search.elements.query.value = action === "忘记" ? body.slice(0, 300) : "";
          void query();
        }
        return true;
      },
      reset,
    };
  };
})();
