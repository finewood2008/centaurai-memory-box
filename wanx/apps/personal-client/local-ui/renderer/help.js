// Main process owns public cache persistence and scheduling; this is only its renderer view.
window.createHelpView = function ({ request, changed, now = Date.now }) {
  const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  let data = null, etag = null, visible = false, pending = null, generation = 0;
  let loading = false;
  let error = "", category = "all", query = "", expanded = new Set();
  // Match published names, never deployment-specific database IDs.
  const sceneCategories = { box_setup: "添加盒子、发现与配网", box_connection: "盒子连接与网络恢复" };
  let scene = null, sceneNotice = "";
  function selectScene() {
    if (!data || !scene) return;
    const matches = data.categories.filter(row => row.name.trim() === sceneCategories[scene]);
    category = "all"; expanded.clear(); sceneNotice = "";
    if (matches.length === 1 && matches[0].items.length) {
      category = String(matches[0].id);
      expanded.add(String(matches[0].items[0].id));
    } else sceneNotice = "相关分类暂未提供，已展示全部问题。";
  }
  let draft = { content: "", contact: "", categoryId: null, itemId: null };
  let draftQuestion = "", feedbackOpen = false, feedbackPending = null, feedbackError = "", feedbackNotice = "";
  let feedbackRetryAt = 0, feedbackScope = "minute", feedbackTimer = null;
  const remaining = () => Math.max(0, Math.ceil((feedbackRetryAt - now()) / 1000));
  function countdown() {
    if (typeof clearTimeout === "function") clearTimeout(feedbackTimer);
    if (visible && feedbackOpen && remaining() && typeof setTimeout === "function") {
      feedbackTimer = setTimeout(() => { changed(); countdown(); }, feedbackScope === "day" ? remaining() * 1000 : 1000);
      feedbackTimer?.unref?.();
    }
  }
  function message(error) {
    switch (error?.code || error?.message) {
      case "FAQ_FEEDBACK_INVALID_CONTENT": return error.userMessage || "内容不符合要求，请检查后重试。";
      case "FAQ_FEEDBACK_INVALID_REQUEST": return "提交内容格式有误，请修改后重试。";
      case "FAQ_FEEDBACK_IDEMPOTENCY_CONFLICT": return "刚才这条已提交过，内容有改动，请重新提交。";
      case "FAQ_FEEDBACK_TOO_LARGE": return "内容过长，请精简后重试。";
      case "FAQ_FEEDBACK_RATE_LIMITED": return error.limitScope === "day" ? "今日提交次数已达上限，请明日再试。" : "提交得有些频繁，请等待倒计时结束后再试。";
      case "FAQ_FEEDBACK_UNAVAILABLE": return "反馈服务暂时不可用，内容已保留，请稍后重试。";
      case "FAQ_FEEDBACK_INVALID_RESPONSE": return "返回结果无法确认，请稍后重试。";
      case "FAQ_RATE_LIMITED": return "查看得有些频繁，请稍后再试。";
      case "FAQ_INVALID_RESPONSE": return "帮助内容暂时无法读取，请稍候自动更新。";
      case "ACCOUNT_NETWORK_ERROR": return "暂时无法连接，请检查电脑网络后重试。";
      case "ACCOUNT_CANCELLED": return "请求已取消，稍后将自动更新。";
      default: return "帮助服务暂时不可用，请稍后再试。";
    }
  }
  async function refresh() {
    if (!visible) return;
    if (pending) return pending;
    const revision = generation;
    error = "";
    // Defer the request until pending is installed, including synchronous failures.
    const task = Promise.resolve().then(async () => {
      try {
        let result = await request("help.faq", data && etag ? { etag } : {});
        if (revision !== generation) return;
        loading = result?.loading === true;
        if (result?.notModified && !data) result = await request("help.faq", {});
        if (revision !== generation) return;
        if (result?.notModified && data) {
          etag = result.etag || etag;
        } else if (result?.data) {
          if (!result?.data || !Array.isArray(result.data.categories) ||
              result.data.categories.some(row => !row || typeof row.name !== "string" || !Array.isArray(row.items) ||
                row.items.some(item => !item || typeof item.question !== "string" || typeof item.answer !== "string")))
            throw new Error("FAQ_INVALID_RESPONSE");
          const firstLoad = !data;
          data = result.data; etag = result.etag || null;
          if (category !== "all" && !data.categories.some(row => String(row.id) === category)) category = "all";
          if (firstLoad && !scene && data.categories[0]?.items[0]) expanded.add(String(data.categories[0].items[0].id));
        }
        selectScene();
        if (result?.errorCode) error = message({ code: result.errorCode });
        else if (!data && !loading) error = message({ code: "FAQ_UNAVAILABLE" });
      } catch (reason) {
        if (revision === generation) error = message(reason);
      } finally {
        if (revision === generation) { pending = null; changed(); }
      }
    });
    pending = task; changed();
    return task;
  }
  function input(field, value) {
    if (field === "content" || field === "contact") draft[field] = String(value ?? "");
  }
  async function submitFeedback(values = {}) {
    if (feedbackPending) return feedbackPending;
    for (const field of ["content", "contact"]) if (Object.hasOwn(values, field)) input(field, values[field]);
    feedbackError = ""; feedbackNotice = "";
    if (remaining()) { feedbackError = feedbackScope === "day" ? "今日提交次数已达上限，请明日再试。" : "请等待倒计时结束后再提交。"; changed(); return; }
    if (!draft.content.trim() || [...draft.content.trim()].length > 2000) {
      feedbackError = "请填写 1–2000 字的问题描述。"; changed(); return;
    }
    if ([...draft.contact.trim()].length > 128) {
      feedbackError = "联系方式最多 128 字。"; changed(); return;
    }
    const submitted = { ...draft };
    const task = Promise.resolve().then(async () => {
      try {
        feedbackRetryAt = now() + 60_000; feedbackScope = "minute"; countdown();
        const result = await request("help.feedback", submitted);
        if (result?.received !== true) throw new Error("FAQ_FEEDBACK_INVALID_RESPONSE");
        if (JSON.stringify(draft) === JSON.stringify(submitted)) {
          draft = { content: "", contact: "", categoryId: null, itemId: null };
          draftQuestion = ""; feedbackOpen = false;
          feedbackNotice = "反馈已收到，感谢你的帮助。";
        } else feedbackNotice = "上一条反馈已收到，你新填写的内容已保留。";
      } catch (error) {
        if (error.code === "FAQ_FEEDBACK_RATE_LIMITED") {
          feedbackRetryAt = now() + (Number.isFinite(error.retryAfterSeconds) && error.retryAfterSeconds > 0 ? Math.min(86400, error.retryAfterSeconds) : 60) * 1000;
          feedbackScope = error.limitScope === "day" ? "day" : "minute";
        }
        feedbackError = message(error);
      } finally {
        feedbackPending = null; countdown(); changed();
      }
    });
    feedbackPending = task; changed();
    return task;
  }
  function feedbackMarkup() {
    return `<section class="faq-feedback" aria-label="问题反馈">
      <div class="faq-feedback-heading"><div><h3>没找到答案？</h3><p class="muted">告诉我们你遇到的问题，帮助我们改进万象。</p></div>${!feedbackOpen ? `<button class="button" data-action="help-feedback-open">${draft.content || draft.contact ? "继续填写反馈" : "告诉我们"}</button>` : ""}</div>
      ${feedbackNotice ? `<p class="notice success" role="status">${esc(feedbackNotice)}</p>` : ""}
      ${feedbackOpen ? `<form data-form="help-feedback" class="faq-feedback-form" novalidate>
        <p class="faq-feedback-privacy" id="faq-feedback-privacy">请勿填写密码、密钥、验证码。我们只用于改进帮助内容。</p>
        ${draft.itemId != null ? `<div class="faq-feedback-related"><span>关联问题：${esc(draftQuestion || "此前查看的问题")}</span><button type="button" class="button small" data-action="help-feedback-unlink" aria-label="移除关联问题">移除</button></div>` : ""}
        <label for="faq-feedback-content">问题描述 <span class="muted">必填 · 最多 2000 字</span></label>
        <textarea id="faq-feedback-content" name="content" rows="5" maxlength="2000" aria-describedby="faq-feedback-privacy" placeholder="${esc(query ? `你搜索了“${query}”，可以描述尚未解决的问题。` : "你遇到了什么问题？试过哪些操作？")}">${esc(draft.content)}</textarea>
        <label for="faq-feedback-contact">联系方式 <span class="muted">选填 · 便于回访，可不填</span></label>
        <input id="faq-feedback-contact" name="contact" type="text" maxlength="128" value="${esc(draft.contact)}" autocomplete="off" placeholder="邮箱、电话或其他联系方式" />
        <p class="faq-feedback-hint">无需登录或连接盒子。目前暂不支持在客户端查看处理进度；草稿仅在当前窗口保留，关闭窗口后不保存。</p>
        ${feedbackError ? `<p class="notice error" role="alert">${esc(feedbackError)}</p>` : ""}
        <div class="settings-actions"><button class="button primary" type="submit" aria-busy="${Boolean(feedbackPending)}" ${feedbackPending || remaining() ? "disabled" : ""}>${feedbackPending ? "正在提交…" : remaining() ? feedbackScope === "day" ? "今日次数已用完" : `${remaining()} 秒后可提交` : "提交反馈"}</button><button type="button" class="button" data-action="help-feedback-close">收起</button></div>
      </form>` : ""}
    </section>`;
  }
  return {
    input,
    open(input = {}) {
      scene = Object.hasOwn(sceneCategories, input.scene) ? input.scene : null;
      category = "all"; query = ""; expanded.clear(); sceneNotice = "";
      selectScene();
    },
    visible(value) {
      if (visible === value) return;
      visible = value; countdown();
      if (!value) { generation++; pending = null; }
    },
    refresh,
    action(action, input = {}) {
      if (action === "help-feedback-submit") return submitFeedback(input);
      if (action === "help-feedback-open") {
        feedbackOpen = true; feedbackError = ""; feedbackNotice = ""; countdown();
        for (const row of data?.categories || []) {
          const item = row.items.find(item => String(item.id) === String(input.id));
          if (item) { draft.categoryId = row.id; draft.itemId = item.id; draftQuestion = item.question; break; }
        }
        changed(); return;
      }
      if (action === "help-feedback-close") { feedbackOpen = false; changed(); return; }
      if (action === "help-feedback-unlink") { draft.categoryId = null; draft.itemId = null; draftQuestion = ""; changed(); return; }
      if (["help-category", "help-search", "help-clear", "help-question"].includes(action)) {
        scene = null; sceneNotice = "";
      }
      if (action === "help-category") category = String(input.id || "all");
      else if (action === "help-search") {
        query = String(input.query || "").trim().slice(0, 200);
        if (query) for (const row of data?.categories || []) for (const item of row.items)
          if (`${item.question}\n${item.answer}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())) expanded.add(String(item.id));
      }
      else if (action === "help-clear") { query = ""; category = "all"; }
      else if (action === "help-question") {
        const id = String(input.id);
        if (expanded.has(id)) expanded.delete(id); else expanded.add(id);
      } else return;
      changed();
    },
    render({ drawer = false, backLabel = "返回" } = {}) {
      const categories = data?.categories || [];
      const total = categories.reduce((count, row) => count + row.items.length, 0);
      const needle = query.toLocaleLowerCase();
      const groups = categories.filter(row => category === "all" || String(row.id) === category).map(row => ({ ...row,
        items: row.items.filter(item => !needle || `${item.question}\n${item.answer}`.toLocaleLowerCase().includes(needle)),
      })).filter(row => row.items.length);
      const count = groups.reduce((sum, row) => sum + row.items.length, 0);
      const categoryButton = (id, name, count) => `<button class="faq-category ${category === String(id) ? "active" : ""}" data-action="help-category" data-id="${esc(id)}" aria-pressed="${category === String(id)}"><span>${esc(name)}</span><span class="faq-count">${count}</span></button>`;
      return `<section class="page-content faq-page" aria-label="常见问题">
        <header class="faq-heading"><div><span class="faq-eyebrow">WANX HELP</span><h2 id="faq-title">常见问题</h2><p class="muted">关于万象的使用，这里有一些答案。</p></div><div class="settings-actions"><button class="button small" data-action="help-back">${drawer ? "关闭帮助" : esc(backLabel)}</button></div></header>
        <form class="faq-search" data-form="help-search" role="search"><label for="faq-query">搜索问题</label><input id="faq-query" name="query" type="search" maxlength="200" value="${esc(query)}" placeholder="输入问题关键词，例如：登录、盒子、积分" autocomplete="off" /><button class="button" type="submit">搜索</button></form>
        ${error ? `<div class="notice error faq-notice" role="status">${esc(error)}${data ? " 当前保留上次获取的内容。" : ""}</div>` : ""}
        ${sceneNotice ? `<p class="notice faq-notice" role="status">${esc(sceneNotice)}</p>` : ""}
        ${!data ? `<div class="faq-empty" role="status"><span class="faq-empty-icon" aria-hidden="true">?</span><h3>${pending || loading ? "正在获取帮助内容" : "暂时无法获取帮助内容"}</h3><p>${pending || loading ? "请稍候，正在为你查找答案。" : "正在等待自动重试，请稍后再来查看。"}</p></div>` : !total ? `<div class="faq-empty" role="status"><span class="faq-empty-icon" aria-hidden="true">?</span><h3>帮助内容正在整理中</h3><p>你可以稍后再来看看。</p></div>` : `<div class="faq-layout"><aside class="faq-sidebar" aria-label="问题分类"><h3>问题分类</h3>${categoryButton("all", "全部问题", total)}${categories.map(row => categoryButton(row.id, row.name, row.items.length)).join("")}</aside><div class="faq-results"><p class="faq-result-count" role="status">${query ? `“${esc(query)}” · ` : ""}共 ${count} 个问题</p>${groups.length ? groups.map(row => `<section class="faq-group" aria-label="${esc(row.name)}"><h3>${esc(row.name)}</h3>${row.items.map(item => { const id = String(item.id), open = expanded.has(id); return `<article class="faq-item"><h4><button class="faq-question" data-action="help-question" data-id="${esc(id)}" aria-expanded="${open}" aria-controls="faq-answer-${esc(id)}"><span>${esc(item.question)}</span><span class="faq-chevron" aria-hidden="true">${open ? "−" : "+"}</span></button></h4><div class="faq-answer" id="faq-answer-${esc(id)}" ${open ? "" : "hidden"}>${esc(item.answer)}<div class="faq-feedback-link"><button class="button small" data-action="help-feedback-open" data-id="${esc(item.id)}">仍没解决？反馈问题</button></div></div></article>`; }).join("")}</section>`).join("") : `<div class="faq-empty"><h3>没有找到相关问题</h3><p>试试更简短的关键词，或查看其他分类。</p><button class="button small" data-action="help-clear">查看全部问题</button></div>`}</div></div>`}
        ${feedbackMarkup()}
        <p class="faq-footer">${data ? "内容由万象帮助中心维护，将在后台自动更新。" : "查看常见问题无需登录，也无需连接盒子。"}</p>
      </section>`;
    },
  };
};
