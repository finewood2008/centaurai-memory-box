(() => {
  const esc = value => String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
  const tagSeparators = /[,，;；\n]+/;
  const parseTags = value => [...new Map((Array.isArray(value) ? value : String(value || "").split(tagSeparators)).map(tag => tag.trim()).filter(Boolean).map(tag => [tag.toLocaleLowerCase(), tag])).values()];
  const ownTags = row => row?.annotation?.manual?.tags ?? row?.annotation?.automatic?.tags ?? [];
  const ownDescription = row => row?.annotation?.manual?.description ?? row?.annotation?.automatic?.description ?? "";
  const effectiveDescription = row => row?.annotation?.description ?? ownDescription(row);
  const stateNames = { unannotated: "待标注", suggested: "有建议", confirmed: "已确认", review: "需复核", failed: "失败" };
  const busyStates = new Set(["scanning", "generating", "suggesting", "applying", "undoing", "running"]);
  const errors = { SPACE_CONTEXT_CHANGED: "账号、盒子或权限已变化，请重新打开工作台。", SPACE_ANNOTATION_CONFLICT: "文件或标注已经更新，冲突项已保留，请重新核对。", SPACE_ANNOTATION_READ_ONLY: "此空间为只读，不能保存标注。", SPACE_ANNOTATION_STORAGE_FAILED: "草稿或标注未能保存，请检查本机存储后重试。", SPACE_ANNOTATION_MODEL_UPSTREAM_UNAVAILABLE: "当前默认模型的上游服务暂不可用，请检查盒子模型服务后重试；原标注未改动。", SPACE_ANNOTATION_MODEL_INPUT_TOO_LARGE: "当前资料超出默认模型的单次输入上限，请缩小范围或选用较短资料；内容未被截断。", SPACE_ANNOTATION_MODEL_UNAVAILABLE: "盒子默认模型暂不可用，请检查模型配置。", SPACE_ANNOTATION_MODEL_FORBIDDEN: "模型访问被拒绝，请检查当前盒子的访问权限。", SPACE_ANNOTATION_MODEL_UPDATE_REQUIRED: "当前盒子尚未提供所需模型接口，请先更新盒子服务。", SPACE_ANNOTATION_MODEL_TIMEOUT: "默认模型调用超时，本次未生成建议。", SPACE_ANNOTATION_MODEL_QUOTA: "默认模型额度或调用频率受限，请稍后重试。", SPACE_ANNOTATION_MODEL_FAILED: "默认模型调用未完成，请稍后重试。", SPACE_ANNOTATION_INVALID_MODEL_OUTPUT: "模型返回的建议格式无效，本次未保存。", SPACE_ANNOTATION_INSTRUCTIONS_TOO_LONG: "方案要求与本批补充要求合计最多 4000 个字符，请缩短后重试。", SPACE_ANNOTATION_NO_CHANGES: "所选项目已与目标一致，没有需要保存的变更。", BOX_CONNECTION_REQUIRED: "连接暂不可用，请恢复盒子连接后继续。", UNKNOWN_CLIENT_ACTION: "工作台接口尚未加载，请重启客户端。" };
  const errorText = cause => { const code = String(cause?.code || cause?.message || cause || ""); return Object.entries(errors).find(([key]) => code.includes(key))?.[1] || "操作未完成，已保留本次草稿。请重试。"; };
  const size = value => Number.isFinite(value) ? value >= 1048576 ? `${(value / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.ceil(value / 1024))} KB` : "—";
  const button = (label, name, extra = "", disabled = false, primary = false) => `<button type="button" class="button ${primary ? "primary" : ""}" data-action="space-wb-${name}" ${extra} ${disabled ? "disabled" : ""}>${label}</button>`;
  const analysisReasons = { SPACE_ANNOTATION_FOLDER_NAME_ONLY: "文件夹按名称分析", SPACE_ANNOTATION_IMAGE_NO_OCR: "图片尚不支持文字识别", SPACE_ANNOTATION_CONTENT_UNSUPPORTED: "此文件格式暂不支持内容读取", SPACE_ANNOTATION_CONTENT_NOT_READ: "本次未读取文件正文", SPACE_ANNOTATION_NAME_ONLY: "本次未读取文件正文", SPACE_ANNOTATION_CONTENT_EMPTY: "未提取到可用正文", SPACE_ANNOTATION_CONTENT_TOO_LARGE: "文件超出本次内容读取大小限制", SPACE_ANNOTATION_EXTRACTION_TIMEOUT: "内容读取超时", SPACE_ANNOTATION_CONTENT_ENCRYPTED: "文件已加密，无法读取正文", SPACE_ANNOTATION_PDF_NO_TEXT: "未找到可提取文字，首版不提供 OCR", SPACE_ANNOTATION_EXTRACTION_BUDGET: "内容读取达到本次预算限制" };
  const analysisLabel = suggestion => suggestion.contentMode === "content" ? "内容分析" : suggestion.contentMode === "unsupported" ? "不支持内容分析" : "仅分析名称";
  const analysisReason = suggestion => !suggestion.reason ? "" : analysisReasons[suggestion.reason] || "本次无法读取文件正文，可继续手工标注";
  const readingLimits = "每项最大 64 MB；文本型 PDF 最多读取前 200 页；每项最多分析 32768 个字符";
  const pageSizes = [5, 10, 20, 50];

  window.createSpaceAnnotationWorkbench = ({ call, changed = () => {}, onClose = () => {} }) => {
    let visible = false, epoch = 0, origin = null, job = null, items = [], total = 0, filteredTotal = 0, offset = 0;
    let summary = {}, filteredSummary = null, resumableJobs = [], error = "", loading = false, message = "", leftHidden = true;
    let query = "", type = "", state = "", activeId = "", anchor = "", selected = new Set(), allMatching = null;
    let cache = new Map(), drafts = new Map(), draftTimers = new Map(), draftWrites = new Map(), draftError = new Set(), committingDrafts = new Map();
    let scrollTop = 0, poll = null, queryTimer = null, loadingList = false, nextAfterApply = null;
    let schemesLoading = false;
    let reusableTags = [], tagInputs = new Map(), tagFocus = "", tagRepaint = false;
    let tab = "edit", schemes = [], scheme = "", instructions = "", schemeName = "";
    let bulk = { tagMode: "keep", tags: "", descriptionMode: "keep", description: "", inherit: "keep" };
    let suggestionPolicy = { tagMode: "add", descriptionMode: "fill-empty" };
    let plan = null, planKind = "", preview = null, previewURL = null, previewOpen = false, composing = false, scopeHistory = [], pendingFocus = "", focusedPlan = "";
    let pageSize = 10, listRequest = 0;
    const current = () => cache.get(activeId);
    const selectedCount = () => allMatching ? filteredTotal : selected.size || (activeId ? 1 : 0);
    const selection = () => allMatching ? { allMatching: { ...allMatching } } : { ids: selected.size ? [...selected] : activeId ? [activeId] : [] };
    const selectedRows = () => selected.size ? [...selected].map(id => cache.get(id)).filter(Boolean) : current() ? [current()] : [];
    const isBatch = () => !!allMatching || selected.size > 1;
    const isBusy = () => loading || busyStates.has(job?.status);
    const writable = () => allMatching ? true : selectedRows().some(row => row.writable !== false);
    const emit = () => { if (visible) changed(); };
    const check = revision => { if (!visible || revision !== epoch) throw Object.assign(Error("SPACE_CONTEXT_CHANGED"), { code: "SPACE_CONTEXT_CHANGED" }); };
    const invoke = async input => { const revision = epoch; check(revision); const value = await call(input); check(revision); return value; };
    function releasePreview() { if (previewURL) URL.revokeObjectURL(previewURL); previewURL = null; preview = null; }
    function reconcileFocus() {
      if (selected.size || allMatching || items.some(row => row.id === activeId)) return;
      const position = nextAfterApply ? nextAfterApply.position - offset : 0;
      activeId = items[Math.max(0, Math.min(items.length - 1, position))]?.id || "";
      anchor = activeId;
      previewOpen = false;
      releasePreview();
    }
    function schedulePoll() {
      clearTimeout(poll); poll = null;
      if (visible && busyStates.has(job?.status)) poll = setTimeout(() => { void loadPage(true); }, 1000);
    }
    function consume(value, preservePage = false) {
      if (value?.job) job = value.job;
      if (Array.isArray(value?.items)) {
        if (!preservePage) items = value.items.slice(0, pageSize);
        else { const updated = new Map(value.items.map(row => [row.id, row])); items = items.map(row => updated.get(row.id) || row); }
        for (const row of value.items) {
          const draft = drafts.get(row.id), applied = committingDrafts.get(row.id), revisionChanged = draft && draft._baseRevision !== row.annotation?.revision;
          if (revisionChanged) {
            if (!draft._edited || applied && applied.serial === draft._serial && applied.revision === draft._baseRevision && job?.applied?.includes(row.id) && !row.draft) {
              clearTimeout(draftTimers.get(row.id)); draftTimers.delete(row.id); drafts.delete(row.id); draftError.delete(row.id); committingDrafts.delete(row.id);
            } else { draft._conflict = true; clearTimeout(draftTimers.get(row.id)); draftTimers.delete(row.id); }
          }
          cache.set(row.id, row);
          if (row.draft && !revisionChanged && !drafts.has(row.id)) drafts.set(row.id, { tags: [...ownTags(row)], description: effectiveDescription(row), inherit: row.annotation?.inherit !== false, ...row.draft, _fields: new Set(Object.keys(row.draft).filter(key => ["tags", "description", "inherit"].includes(key))), _edited: true, _serial: 0, _baseRevision: row.draftRevision ?? row.annotation?.revision, _conflict: row.draftRevision !== undefined && row.draftRevision !== row.annotation?.revision });
        }
      }
      total = value?.total ?? job?.total ?? total;
      if (!preservePage) filteredTotal = value?.filteredTotal ?? value?.total ?? total;
      summary = value?.summary || summary;
      if (!preservePage) filteredSummary = value?.filteredSummary || null;
      resumableJobs = value?.resumableJobs || resumableJobs;
      if (!preservePage) offset = value?.offset ?? offset;
      if (!preservePage) reconcileFocus();
      schedulePoll();
    }
    async function loadPage(quiet = false, targetOffset = offset, limit = pageSize) {
      if (!job || (quiet && loadingList)) return false;
      const revision = epoch, request = ++listRequest;
      const latest = () => revision === epoch && request === listRequest;
      loadingList = true; if (!quiet) { loading = true; emit(); }
      try {
        const input = { op: "list", jobId: job.id, offset: targetOffset, limit, query, type, status: state };
        let value = await invoke(input);
        if (!latest()) return false;
        const count = value.filteredTotal ?? value.total ?? 0;
        const lastOffset = Math.max(0, Math.ceil(count / limit) - 1) * limit;
        if (targetOffset > lastOffset) {
          value = await invoke({ ...input, offset: lastOffset });
          if (!latest()) return false;
        }
        if (offset !== value.offset || pageSize !== limit) scrollTop = 0;
        pageSize = limit;
        consume(value);
        error = "";
      } catch (cause) {
        if (latest()) { error = errorText(cause); schedulePoll(); }
        return false;
      } finally {
        if (latest()) { loadingList = false; loading = false; emit(); }
      }
      if (nextAfterApply && !busyStates.has(job?.status)) {
        const prior = nextAfterApply;
        nextAfterApply = null;
        if (activeId === prior.id && job?.applied?.includes(prior.id)) {
          selected.clear();
          if (items.some(row => row.id === prior.id)) await moveRow(1);
          else {
            // Saving can remove the current file from the filtered list.
            const index = Math.max(0, Math.min(items.length - 1, prior.position - offset));
            if (items[index]) await focusRow(items[index].id);
            else reconcileFocus();
          }
          if (revision === epoch) emit();
        } else if (activeId === prior.id) {
          error = errorText(cache.get(prior.id)?.error || job?.error);
          emit();
        }
      }
      return revision === epoch;
    }
    async function loadSchemes() {
      if (schemesLoading) return;
      const revision = epoch; schemesLoading = true; emit();
      try { const value = await invoke({ op: "schemes" }); schemes = value.items || []; reusableTags = value.tags || []; }
      catch (cause) { if (visible && revision === epoch) error = errorText(cause); }
      finally { if (revision === epoch) { schemesLoading = false; emit(); } }
    }
    async function open(input, keepHistory = false) {
      const history = keepHistory ? [...scopeHistory] : [];
      reset(); scopeHistory = history; visible = true; epoch++; origin = { ...input }; loading = true;
      const revision = epoch;
      selected = new Set(input.ids || []); activeId = input.ids?.[0] || ""; error = ""; emit();
      try {
        const value = await invoke({ op: "open", space_id: input.space_id || "personal", parent: input.parent || "", ...(input.ids?.length ? { ids: input.ids } : {}), recursive: input.recursive === true, ...(input.fresh ? { fresh: true } : {}) });
        consume(value);
        if (value.directoryRefreshError) message = "暂时无法检查新增文件，当前显示上次扫描的列表。可返回空间后重新打开工作台重试。";
      }
      catch (cause) { if (visible && revision === epoch) error = errorText(cause); }
      finally { if (revision === epoch) { loading = false; emit(); void loadSchemes(); } }
    }
    function reset() {
      visible = false; epoch++; clearTimeout(poll); clearTimeout(queryTimer); poll = queryTimer = null;
      for (const timer of draftTimers.values()) clearTimeout(timer);
      draftTimers.clear(); draftWrites.clear(); draftError.clear(); drafts.clear(); committingDrafts.clear(); cache.clear(); releasePreview();
      origin = null; job = null; items = []; total = filteredTotal = offset = scrollTop = 0; loading = loadingList = false;
      pageSize = 10;
      activeId = anchor = ""; selected.clear(); allMatching = null; error = message = ""; plan = null; nextAfterApply = null;
      summary = {}; filteredSummary = null; resumableJobs = []; query = type = state = ""; previewOpen = composing = false;
      scopeHistory = []; pendingFocus = focusedPlan = "";
      schemesLoading = false; scheme = schemeName = instructions = ""; schemes = []; tab = "edit"; leftHidden = true;
      reusableTags = []; tagInputs.clear(); tagFocus = ""; tagRepaint = false;
      bulk = { tagMode: "keep", tags: "", descriptionMode: "keep", description: "", inherit: "keep" };
      suggestionPolicy = { tagMode: "add", descriptionMode: "fill-empty" };
    }
    function draftFor(row) {
      if (!row) return { tags: [], description: "", inherit: true };
      if (!drafts.has(row.id)) drafts.set(row.id, { tags: [...ownTags(row)], description: effectiveDescription(row), inherit: row.annotation?.inherit !== false, _fields: new Set(), _baseRevision: row.annotation?.revision, _serial: 0, _edited: false });
      return drafts.get(row.id);
    }
    async function flushDraft(id, force = false) {
      clearTimeout(draftTimers.get(id)); draftTimers.delete(id);
      if (!job || !drafts.has(id)) return;
      if (drafts.get(id)._conflict) throw Object.assign(Error("SPACE_ANNOTATION_CONFLICT"), { code: "SPACE_ANNOTATION_CONFLICT" });
      const value = drafts.get(id), patch = {};
      if (!force && !draftError.has(id) && !value._dirty) return draftWrites.get(id);
      for (const key of value._fields) patch[key] = key === "tags" ? [...value.tags] : value[key];
      if (force && !Object.keys(patch).length) patch.tags = [...value.tags];
      const revision = epoch, jobId = job.id, expectedRevision = value._baseRevision;
      value._dirty = false;
      const previous = draftWrites.get(id) || Promise.resolve();
      const work = previous.catch(() => {}).then(() => { check(revision); return invoke({ op: "draft", jobId, id, patch, expectedRevision }); }).then(() => { if (revision === epoch) draftError.delete(id); }, cause => { if (revision === epoch) draftError.add(id); throw cause; });
      draftWrites.set(id, work);
      try { await work; }
      catch (cause) { if (visible && revision === epoch) { error = errorText(cause); emit(); } throw cause; }
      finally { if (draftWrites.get(id) === work) draftWrites.delete(id); }
    }
    async function focusRow(id, event = {}) {
      if (id === activeId) return;
      const revision = epoch;
      if (!commitTags(tagField(), false)) return;
      if (activeId) try { await flushDraft(activeId); } catch { return; }
      if (!visible || revision !== epoch) return;
      const before = activeId; activeId = id;
      pendingFocus = id;
      if (event.shiftKey) {
        allMatching = null;
        const from = items.findIndex(row => row.id === (anchor || before)), to = items.findIndex(row => row.id === id);
        for (const row of items.slice(Math.max(0, Math.min(from, to)), Math.max(from, to) + 1)) selected.add(row.id);
      } else { anchor = id; if (!event.preserveSelection && selected.size === 1 && !selected.has(id)) selected.clear(); }
      if (previewOpen) void fetchPreview();
      emit();
    }
    async function moveRow(direction, event) {
      const revision = epoch, prior = activeId;
      const index = items.findIndex(row => row.id === prior);
      const row = items[index < 0 ? 0 : index + direction];
      if (row) return focusRow(row.id, event);
      const target = offset + direction * pageSize;
      if (!items.length || target < 0 || target >= filteredTotal || !commitTags(tagField(), false)) return;
      if (prior) await flushDraft(prior);
      if (revision !== epoch || prior !== activeId) return;
      if (await loadPage(false, target)) {
        const first = direction > 0 ? items[0] : items.at(-1);
        if (!first) return;
        if (event?.shiftKey) {
          selected.add(prior);
          selected.add(first.id);
          anchor = first.id;
        }
        await focusRow(first.id, event);
      }
    }
    async function fetchPreview() {
      const id = activeId, revision = epoch; releasePreview(); previewOpen = true; preview = { loading: true }; emit();
      try {
        const result = await invoke({ op: "preview", jobId: job.id, id });
        if (id !== activeId) return;
        preview = result;
        if (typeof result.data === "string" && /^(?:image\/(?:png|jpeg|gif|webp)|application\/pdf)$/.test(result.type)) {
          const bytes = Uint8Array.from(atob(result.data), c => c.charCodeAt(0)); previewURL = URL.createObjectURL(new Blob([bytes], { type: result.type }));
        } else if (result.type === "text/plain" && typeof result.data === "string") preview.text = new TextDecoder().decode(Uint8Array.from(atob(result.data), c => c.charCodeAt(0)));
      } catch (cause) { if (id === activeId && visible && revision === epoch) preview = { error: errorText(cause) }; }
      emit();
    }
    function changes() {
      return { tagMode: bulk.tagMode, tags: parseTags(bulk.tags), descriptionMode: bulk.descriptionMode, description: bulk.description,
        ...(bulk.inherit !== "keep" ? { inherit: bulk.inherit === "on" } : {}) };
    }
    const tagField = () => isBatch() || tab === "schemes" ? "bulk-tag-input" : "item-tag-input";
    const tagKey = field => field === "bulk-tag-input" ? "bulk" : activeId;
    const tagValues = field => field === "bulk-tag-input" ? parseTags(bulk.tags) : [...draftFor(current()).tags];
    const tagWritable = field => !isBusy() && (field === "bulk-tag-input" && tab === "schemes" || writable() && (field !== "item-tag-input" || current()?.writable !== false));
    function setTags(field, values, focus = true) {
      if (!tagWritable(field)) return false;
      const tags = [...new Map(values.map(tag => [tag.trim().toLocaleLowerCase(), tag.trim()]).filter(([tag]) => tag)).values()];
      if (tags.length > 30 || tags.some(tag => tag.length > 80)) { error = "最多添加 30 个标签，每个标签最多 80 个字符。"; tagRepaint = true; if (focus) tagFocus = field; emit(); return false; }
      input(field === "bulk-tag-input" ? "bulk-tags" : "item-tags", tags);
      error = ""; tagRepaint = true; if (focus) tagFocus = field; return true;
    }
    function commitTags(field = tagField(), focus = true) {
      const text = (tagInputs.get(tagKey(field)) || "").trim();
      if (!text) return true;
      const known = tagSeparators.test(text) && availableTags().find(tag => tag.toLocaleLowerCase() === text.toLocaleLowerCase());
      if (!setTags(field, [...tagValues(field), ...(known ? [known] : parseTags(text))], focus)) return false;
      tagInputs.delete(tagKey(field)); return true;
    }
    function availableTags() {
      return parseTags([...drafts.values()].reverse().flatMap(draft => draft.tags).concat((summary.tagCounts || []).map(item => item.tag), reusableTags, schemes.flatMap(item => item.tags || []))).slice(0, 500);
    }
    function tagsEditor(field, tags, label, disabled) {
      const selected = new Set(tags.map(tag => tag.toLocaleLowerCase())), choices = availableTags().filter(tag => !selected.has(tag.toLocaleLowerCase()));
      return `<div class="awb-tag-editor"><label for="awb-tag-input">${esc(label)}</label>
        <div class="awb-tag-field">${tags.map(tag => `<span class="awb-tag-token">${esc(tag)}<button type="button" data-action="space-wb-tag-remove" data-field="${field}" data-tag="${esc(tag)}" aria-label="移除标签 ${esc(tag)}" ${disabled ? "disabled" : ""}>×</button></span>`).join("")}
          <div class="awb-tag-entry"><input id="awb-tag-input" data-wb-field="${field}" value="${esc(tagInputs.get(tagKey(field)) || "")}" maxlength="2400" placeholder="输入标签" aria-label="${esc(label)}，按回车添加" ${disabled ? "disabled" : ""}>
            ${choices.length ? `<select data-wb-field="tag-existing" aria-label="选择已有标签" ${disabled ? "disabled" : ""}><option value="" selected disabled>已有标签</option>${choices.map(tag => `<option value="${esc(tag)}">${esc(tag)}</option>`).join("")}</select>` : ""}
          </div>
        </div><small class="awb-hint">回车或逗号添加，支持多个标签。</small></div>`;
    }
    async function prepare(kind, forCurrent = false) {
      if (!job || !selectedCount() || !writable() || isBusy() || ((forCurrent || ["single", "next"].includes(kind)) && current()?.writable === false)) return;
      if (!commitTags(tagField(), false)) return;
      const id = activeId;
      error = ""; loading = true; emit();
      try {
        if (kind === "single" || kind === "next") await flushDraft(id, true);
        plan = await invoke({ op: "prepare", jobId: job.id, selection: forCurrent || kind === "single" || kind === "next" ? { ids: [id] } : selection(),
          change: kind === "single" || kind === "next" ? { tagMode: "keep", tags: [], descriptionMode: "keep", description: "" } : kind === "suggestion" ? { ...suggestionPolicy, tags: [], description: "" } : changes(),
          ...(kind === "single" || kind === "next" ? { useDrafts: true } : {}), ...(kind === "suggestion" ? { acceptSuggestions: true } : {}) });
        planKind = kind;
      } catch (cause) {
        if (kind === "next" && String(cause?.code || cause?.message || "").includes("SPACE_ANNOTATION_NO_CHANGES")) {
          message = errorText(cause); selected.clear(); await moveRow(1);
        } else error = errorText(cause);
      }
      finally { loading = false; emit(); }
    }
    async function submitPlan() {
      if (!plan || loading) return;
      loading = true; error = ""; const prepared = plan; const kind = planKind; emit();
      try {
        if (kind === "single" || kind === "next") { const draft = drafts.get(activeId); if (draft) committingDrafts.set(activeId, { serial: draft._serial, revision: draft._baseRevision }); }
        const value = await invoke({ op: "apply", jobId: job.id, planId: prepared.planId });
        if (kind === "next") nextAfterApply = {id: activeId, position: offset + items.findIndex(row => row.id === activeId)};
        plan = null; message = "已提交本批次，冲突和失败项会单独保留。"; consume(value, true); await loadPage(true);
      } catch (cause) { error = errorText(cause); }
      finally { loading = false; emit(); }
    }
    async function close() {
      const revision = epoch;
      if (!commitTags(tagField(), false)) return;
      try { for (const id of drafts.keys()) await flushDraft(id); await Promise.all([...draftWrites.values()]); }
      catch { return; }
      if (!visible || revision !== epoch) return;
      reset(); onClose(); changed();
    }
    async function changeScope(input, push = true) {
      const revision = epoch;
      if (!commitTags(tagField(), false)) return;
      for (const id of drafts.keys()) await flushDraft(id);
      await Promise.all([...draftWrites.values()]);
      check(revision);
      if (push) scopeHistory.push({ ...origin });
      await open(input, true);
    }
    async function changeJob(id) {
      if (!id || id === job?.id || loading) return;
      const revision = epoch;
      if (!commitTags(tagField(), false)) return;
      for (const draftId of drafts.keys()) await flushDraft(draftId);
      await Promise.all([...draftWrites.values()]);
      check(revision);
      epoch++; loadingList = false; schemesLoading = false;
      clearTimeout(poll); clearTimeout(queryTimer); poll = queryTimer = null;
      drafts.clear(); draftWrites.clear(); draftError.clear(); committingDrafts.clear(); cache.clear(); releasePreview();
      tagInputs.clear(); tagFocus = ""; tagRepaint = false;
      selected.clear(); allMatching = null; activeId = anchor = ""; items = []; offset = scrollTop = 0; plan = null; nextAfterApply = null; previewOpen = false; filteredSummary = null;
      suggestionPolicy = { tagMode: "add", descriptionMode: "fill-empty" };
      bulk = { tagMode: "keep", tags: "", descriptionMode: "keep", description: "", inherit: "keep" };
      scheme = schemeName = instructions = ""; tab = "edit"; job = { id, status: "paused" }; await loadPage();
    }
    async function action(name, data = {}, event = {}) {
      if (!visible || loading) return;
      const revision = epoch;
      try {
        if (["check", "page-select", "matching-select", "clear", "tab", "use-scheme", "filter", "previous-page", "next-page", "scope-parent"].includes(name)) {
          const field = tagField();
          if (!commitTags(field, false)) return;
          if (field === "item-tag-input" && activeId) await flushDraft(activeId);
          check(revision);
        }
        if (name === "close") return await close();
        if (name === "focus") return await focusRow(data.id, event);
        if (name === "check") {
          if (allMatching || !cache.has(data.id)) return;
          const adding = !selected.has(data.id), next = new Set(selected);
          if (adding) next.add(data.id); else next.delete(data.id);
          const focus = next.size === 1 ? [...next][0] : adding ? data.id : activeId;
          if (focus !== activeId) { await focusRow(focus, { preserveSelection: true }); if (activeId !== focus) return; }
          selected = next; reconcileFocus(); emit(); return;
        }
        if (name === "page-select") {
          if (allMatching) { allMatching = null; selected.clear(); reconcileFocus(); emit(); return; }
          const next = new Set(selected), all = items.length > 0 && items.every(row => selected.has(row.id));
          for (const row of items) if (all) next.delete(row.id); else next.add(row.id);
          if (next.size === 1) { const focus = [...next][0]; await focusRow(focus, { preserveSelection: true }); if (activeId !== focus) return; }
          selected = next; reconcileFocus(); emit(); return;
        }
        if (name === "matching-select") { if (!job?.scanComplete) { message = "目录仍在扫描，完成后可选择整个筛选范围。"; emit(); return; } selected.clear(); allMatching = { query, type, status: state }; emit(); return; }
        if (name === "clear") { selected.clear(); allMatching = null; reconcileFocus(); emit(); return; }
        if (name === "filter") { state = data.status || ""; scrollTop = 0; allMatching = null; filteredSummary = null; await loadPage(false, 0); return; }
        if (name === "previous-page" || name === "next-page") {
          const target = offset + (name === "next-page" ? pageSize : -pageSize);
          if (target >= 0 && target < filteredTotal && await loadPage(false, target) && !selected.size && items[0]) await focusRow(items[0].id);
          return;
        }
        if (name === "previous" || name === "next") return await moveRow(name === "next" ? 1 : -1, event);
        if (name === "preview") { if (previewOpen) { previewOpen = false; releasePreview(); emit(); } else await fetchPreview(); return; }
        if (name === "left") { leftHidden = !leftHidden; emit(); return; }
        if (name === "tab") { if (!["edit", "schemes"].includes(data.tab)) return; tab = data.tab; emit(); if (tab === "schemes") await loadSchemes(); return; }
        if (name === "use-scheme") {
          const chosen = schemes.find(item => item.id === scheme);
          if (!chosen || !selectedCount() || isBusy() || !writable()) return;
          if (isBatch()) bulk.tagMode = "add";
          else {
            const row = current(); if (!row || row.writable === false) return;
            const draft = draftFor(row); draft.tags = parseTags([...draft.tags, ...parseTags(bulk.tags)]); draft._fields.add("tags");
            if (bulk.inherit !== "keep") { draft.inherit = bulk.inherit === "on"; draft._fields.add("inherit"); }
            draft._dirty = draft._edited = true; draft._serial++; await flushDraft(row.id);
          }
          tab = "edit"; message = "已带入方案，请核对后保存。"; emit(); return;
        }
        if (name === "plan-close") { plan = null; emit(); return; }
        if (name === "plan-apply") return await submitPlan();
        if (name === "discard-draft") { loading = true; emit(); const value = await invoke({ op: "refresh-item", jobId: job.id, id: activeId, discardDraft: true }); clearTimeout(draftTimers.get(activeId)); draftTimers.delete(activeId); drafts.delete(activeId); draftError.delete(activeId); committingDrafts.delete(activeId); consume(value, true); await loadPage(true); loading = false; emit(); return; }
        if (name === "review-draft") { const draft = drafts.get(activeId); if (draft) { draft._baseRevision = current()?.annotation?.revision; draft._conflict = false; draft._dirty = true; } return await prepare("single"); }
        if (name === "prepare") return await prepare(isBatch() ? "batch" : "single");
        if (name === "save-next") return await prepare("next");
        if (name === "accept-suggestion") return await prepare("suggestion");
        if (name === "accept-item-suggestion") return await prepare("suggestion", true);
        if (name === "skip-suggestions" || name === "skip-item-suggestion") {
          if (!job || isBusy() || (name === "skip-item-suggestion" ? !activeId : !selectedCount())) return;
          loading = true; error = ""; emit(); consume(await invoke({ op: "skip-suggestions", jobId: job.id, selection: name === "skip-item-suggestion" ? { ids: [activeId] } : selection() }), true); await loadPage(true);
          message = "已跳过建议，已有标签、说明与人工草稿保持原值。"; loading = false; emit(); return;
        }
        if (name === "resume" && job?.activity === "suggest") { message = "自动建议已停用，可直接手工标注。"; emit(); return; }
        if (["pause", "resume", "cancel", "undo"].includes(name)) { loading = true; emit(); consume(await invoke({ op: name, jobId: job.id }), true); await loadPage(true); message = name === "undo" ? "已核对并撤销可恢复的项目；后续修改冲突会单独保留。" : ""; loading = false; emit(); return; }
        if (name === "refresh") return await loadPage();
        if (name === "fresh") return await changeScope({ ...origin, fresh: true }, false);
        if (name === "scope-parent" && scopeHistory.length) { const previous = scopeHistory.pop(); return await changeScope(previous, false); }
        if (name === "scope-folder") return await changeScope({ space_id: origin.space_id, parent: data.id || "", recursive: origin.recursive, scopeName: data.name || "文件夹" });
        if (name === "source") return await changeScope({ space_id: origin.space_id, parent: "", ids: [data.id], scopeName: data.name || "来源文件夹" });
        if (name === "tag-remove") {
          const field = tagField(), tags = tagValues(field);
          if (data.field !== field || typeof data.tag !== "string") return;
          if (setTags(field, tags.filter(tag => tag !== data.tag))) emit();
          return;
        }
        if (name === "save-scheme") {
          if (!commitTags("bulk-tag-input", false)) return;
          if (!schemeName.trim()) { error = "请为方案填写名称。"; emit(); return; }
          if (schemeName.trim().length > 80) { error = "方案名称最多 80 个字符。"; emit(); return; }
          await invoke({ op: "save-scheme", scheme: { ...(scheme ? { id: scheme } : {}), name: schemeName.trim(), tags: parseTags(bulk.tags), instructions, ...(bulk.inherit !== "keep" ? { inherit: bulk.inherit === "on" } : {}) } });
          schemes = (await invoke({ op: "schemes" })).items || []; message = "方案已保存，可在其他批次复用。"; emit(); return;
        }
        if (name === "delete-scheme" && scheme) { await invoke({ op: "delete-scheme", id: scheme }); scheme = ""; schemes = (await invoke({ op: "schemes" })).items || []; emit(); return; }
      } catch (cause) { if (visible && revision === epoch) { error = errorText(cause); loading = false; emit(); } }
    }
    function input(name, value) {
      if (!visible) return;
      if (name === "tag-existing") {
        const field = tagField();
        if (availableTags().includes(value) && commitTags(field, false) &&
            setTags(field, [...tagValues(field), value])) emit();
        return;
      }
      if (["item-tag-input", "bulk-tag-input"].includes(name)) {
        if (!tagWritable(name)) return;
        tagInputs.set(tagKey(name), String(value));
        if (!composing && tagSeparators.test(value)) { commitTags(name); emit(); }
        return;
      }
      if (["item-tags", "item-description", "item-inherit"].includes(name)) {
        const row = current(); if (!row || row.writable === false || isBusy()) return;
        const draft = draftFor(row), key = name === "item-tags" ? "tags" : name === "item-description" ? "description" : "inherit"; draft[key] = name === "item-tags" ? parseTags(value) : value; draft._fields.add(key);
        draft._dirty = draft._edited = true; draft._serial++; clearTimeout(draftTimers.get(row.id)); if (!draft._conflict) draftTimers.set(row.id, setTimeout(() => { void flushDraft(row.id).catch(() => {}); }, 250)); return;
      }
      if (["query", "status", "type", "page-size", "bulk-tagMode"].includes(name) && !commitTags(tagField(), false)) { emit(); return; }
      if (name === "page-size") {
        const limit = Number(value);
        if (pageSizes.includes(limit) && limit !== pageSize) void loadPage(false, Math.floor(offset / limit) * limit, limit);
        return;
      }
      if (name === "query") { query = value; scrollTop = 0; allMatching = null; filteredSummary = null; clearTimeout(queryTimer); queryTimer = setTimeout(() => { void loadPage(false, 0); }, 250); return; }
      if (name === "status") { if (value && !Object.hasOwn(stateNames, value)) return; state = value; scrollTop = 0; allMatching = null; filteredSummary = null; clearTimeout(queryTimer); void loadPage(false, 0); return; }
      if (name === "type") { type = value; scrollTop = 0; allMatching = null; filteredSummary = null; clearTimeout(queryTimer); void loadPage(false, 0); return; }
      if (name === "recursive") { void changeScope({ ...origin, recursive: value, fresh: true }, false).catch(cause => { error = errorText(cause); emit(); }); return; }
      if (name === "job") { void changeJob(value).catch(cause => { error = errorText(cause); emit(); }); return; }
      if (name === "scheme") {
        tagInputs.delete("bulk");
        scheme = value; const chosen = schemes.find(item => item.id === value);
        if (chosen) { bulk.tags = [...(chosen.tags || [])]; bulk.tagMode = "add"; instructions = chosen.instructions || ""; bulk.inherit = chosen.inherit === undefined ? "keep" : chosen.inherit ? "on" : "off"; schemeName = chosen.name; }
        else schemeName = "";
        emit(); return;
      }
      if (name === "suggestion-tags" && ["add", "keep", "replace"].includes(value)) suggestionPolicy.tagMode = value;
      else if (name === "suggestion-description" && ["fill-empty", "keep", "replace"].includes(value)) suggestionPolicy.descriptionMode = value;
      else if (name === "instructions") instructions = value;
      else if (name === "scheme-name") schemeName = value;
      else if (name.startsWith("bulk-")) {
        const field = name.slice(5); if (Object.hasOwn(bulk, field)) bulk[field] = value;
        if (field === "tags" && bulk.tagMode === "keep") bulk.tagMode = "add";
        if (field === "description" && bulk.descriptionMode === "keep") bulk.descriptionMode = "fill-empty";
      }
      if (["bulk-tagMode", "bulk-descriptionMode", "bulk-inherit", "suggestion-tags", "suggestion-description"].includes(name)) emit();
    }
    async function keydown(event) {
      if (!visible || composing || event.isComposing) return false;
      const field = event.target?.dataset?.wbField;
      if (["item-tag-input", "bulk-tag-input"].includes(field) && event.key === "Enter" && !event.metaKey && !event.ctrlKey) { event.preventDefault(); commitTags(field); emit(); return true; }
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") { if (tab === "schemes" && !plan) return false; event.preventDefault(); if (plan) await submitPlan(); else await prepare(isBatch() ? "batch" : "next"); return true; }
      if (plan) { if (event.key === "Escape") { event.preventDefault(); plan = null; emit(); } return true; }
      if (event.key === "Escape" && !leftHidden) { event.preventDefault(); leftHidden = true; emit(); return true; }
      if (event.target?.closest?.("input, textarea, select, button, summary, a, [role=button]")) return false;
      if (["ArrowDown", "ArrowUp"].includes(event.key)) { event.preventDefault(); await action(event.key === "ArrowDown" ? "next" : "previous", {}, event); return true; }
      if (event.key === " " && activeId) { event.preventDefault(); await action("check", { id: activeId }); return true; }
      return false;
    }
    function selectionSummary() {
      const rows = selectedRows(), note = allMatching ? `<p class="awb-selection-note">已选择整个筛选范围 ${filteredTotal} 项。未修改的字段会逐项保留。</p>` : "";
      if (!allMatching && !rows.length) return "";
      let values;
      if (allMatching) {
        if (!filteredSummary || filteredSummary.count !== filteredTotal) return `${note}<p class="awb-hint">完整筛选范围统计尚未就绪，将在保存前完整核对。</p>`;
        values = filteredSummary;
      } else {
        const counts = new Map(), descriptions = rows.map(effectiveDescription);
        for (const row of rows) for (const tag of new Set(ownTags(row))) counts.set(tag, (counts.get(tag) || 0) + 1);
        values = { count: rows.length, tagCounts: [...counts].map(([tag, count]) => ({ tag, count })), emptyDescriptions: descriptions.filter(value => !value.trim()).length,
          commonDescription: descriptions.every(value => value === descriptions[0]) ? descriptions[0] : null, inheritOn: rows.filter(row => row.annotation?.inherit !== false).length, inheritOff: rows.filter(row => row.annotation?.inherit === false).length };
      }
      const chips = `<div class="awb-common-tags">${(values.tagCounts || []).slice(0, 12).map(({ tag, count }) => `<span class="awb-chip ${count === values.count ? "" : "is-mixed"}" title="${count === values.count ? "全部共有" : "部分文件已有"}">${esc(tag)} <small>${count}/${values.count}</small></span>`).join("") || '<span class="muted">暂无直接标签</span>'}</div>`;
      if (!isBatch()) return chips;
      const partial = !allMatching && rows.length < selectedCount();
      return `${note}${partial ? `<p class="awb-hint">已加载 ${rows.length}/${selectedCount()} 项，以下仅统计已加载项；提交前会完整核对。</p>` : allMatching ? '<p class="awb-hint">完整筛选范围统计</p>' : ""}${chips}<p class="awb-hint">${values.commonDescription === null ? "说明为混合值，未修改时各项保留" : `说明共同值：${esc(values.commonDescription || "空说明")}`}<br>空说明 ${Number(values.emptyDescriptions) || 0}/${values.count} 项 · 继承开启 ${Number(values.inheritOn) || 0} 项 / 关闭 ${Number(values.inheritOff) || 0} 项</p>`;
    }
    function suggestionControls(disabled = false) {
      return `<div class="awb-reading-scope"><strong>接受建议的方式</strong><label>建议标签<select data-wb-field="suggestion-tags" ${disabled ? "disabled" : ""}><option value="add" ${suggestionPolicy.tagMode === "add" ? "selected" : ""}>补充标签，保留已有标签</option><option value="keep" ${suggestionPolicy.tagMode === "keep" ? "selected" : ""}>保持已有标签</option><option value="replace" ${suggestionPolicy.tagMode === "replace" ? "selected" : ""}>替换直接添加的标签</option></select></label><label>建议说明<select data-wb-field="suggestion-description" ${disabled ? "disabled" : ""}><option value="fill-empty" ${suggestionPolicy.descriptionMode === "fill-empty" ? "selected" : ""}>仅填补空说明</option><option value="keep" ${suggestionPolicy.descriptionMode === "keep" ? "selected" : ""}>保持已有说明</option><option value="replace" ${suggestionPolicy.descriptionMode === "replace" ? "selected" : ""}>替换本项说明</option></select></label><p class="awb-hint">逐文件使用各自的建议；继承设置保持原值。替换前会展示实际变更。</p></div>`;
    }
    function editPanel() {
      const row = current(), batch = isBatch(), disabled = isBusy() || !writable(), draft = draftFor(row);
      const inherited = row?.annotation?.provenance?.filter(item => item.source === "inherited") || [];
      if (!row && !allMatching) return '<div class="awb-panel-empty"><strong>开始标注</strong><p>点选文件，在这里填写标签和说明。</p></div>';
      const tagLabel = batch ? bulk.tagMode === "remove" ? "移除标签" : bulk.tagMode === "replace" ? "替换标签" : "添加标签" : row.kind === "folder" ? "文件夹标签" : "文件标签";
      const descriptionLabel = batch ? bulk.descriptionMode === "replace" ? "统一修改说明" : "填写空说明" : row.kind === "folder" ? "文件夹说明" : "文件说明";
      const controls = batch ? `<label>标签操作<select data-wb-field="bulk-tagMode" ${disabled ? "disabled" : ""}><option value="keep" ${bulk.tagMode === "keep" ? "selected" : ""}>保持原值</option><option value="add" ${bulk.tagMode === "add" ? "selected" : ""}>新增标签</option><option value="remove" ${bulk.tagMode === "remove" ? "selected" : ""}>移除此项目的标签</option><option value="replace" ${bulk.tagMode === "replace" ? "selected" : ""}>替换直接添加的标签</option></select></label><label>说明操作<select data-wb-field="bulk-descriptionMode" ${disabled ? "disabled" : ""}><option value="keep" ${bulk.descriptionMode === "keep" ? "selected" : ""}>保持原值</option><option value="fill-empty" ${bulk.descriptionMode === "fill-empty" ? "selected" : ""}>仅填写尚未填写的说明</option><option value="replace" ${bulk.descriptionMode === "replace" ? "selected" : ""}>统一修改说明</option></select></label><label>文件夹继承<select data-wb-field="bulk-inherit" ${disabled ? "disabled" : ""}><option value="keep" ${bulk.inherit === "keep" ? "selected" : ""}>逐项保持原设置</option><option value="on" ${bulk.inherit === "on" ? "selected" : ""}>开启继承</option><option value="off" ${bulk.inherit === "off" ? "selected" : ""}>关闭继承</option></select></label>`
        : `<label class="awb-check"><input type="checkbox" data-wb-field="item-inherit" ${draft.inherit ? "checked" : ""} ${disabled ? "disabled" : ""}>继承上级文件夹标签与说明</label>`;
      return `<div class="awb-editor">
        <div class="awb-editor-heading"><span class="awb-eyebrow">${batch ? "批量标注" : "标注"}</span>${button("常用方案", "tab", 'data-tab="schemes"')}</div>
        <div class="awb-panel-heading"><h3>${batch ? `批量处理 ${selectedCount()} 项` : esc(row.name)}</h3>${row?.writable === false ? '<span class="awb-badge">只读</span>' : ""}</div>
        ${batch ? '<p class="awb-hint">默认追加标签、只填空说明，未修改的内容保留。</p>' : ""}
        ${row?.annotation?.needsReview ? '<p class="awb-alert">文件内容已变化，保存前请复核原标注。</p>' : ""}
        ${tagsEditor(batch ? "bulk-tag-input" : "item-tag-input", batch ? parseTags(bulk.tags) : draft.tags, tagLabel, disabled)}
        <label>${descriptionLabel}<textarea data-wb-field="${batch ? "bulk-description" : "item-description"}" rows="5" maxlength="2000" placeholder="简单说明这份资料的内容或用途" ${disabled ? "disabled" : ""}>${esc(batch ? bulk.description : draft.description)}</textarea></label>
        ${scheme && instructions ? `<p class="awb-hint">填写提示：${esc(instructions)}</p>` : ""}
        ${!batch && row?.kind === "folder" ? '<p class="awb-hint">文件夹标注可由子文件继承，无需逐项填写。</p>' : ""}
        ${inherited.length && !batch ? `<div class="awb-inherited"><span>继承标签 · 来源文件夹</span>${inherited.map(item => `<button type="button" class="awb-chip is-inherited" data-action="space-wb-source" data-id="${esc(item.itemId)}" data-name="${esc(item.sourceName || "来源文件夹")}" title="${esc(item.sourcePath || item.sourceName || "查看来源文件夹")}">${esc(item.tag)} <small>↗ ${esc(item.sourceName || "来源文件夹")}</small></button>`).join("")}</div>` : ""}
        <details class="awb-details"><summary>${batch ? "更多批量选项" : "继承设置"}</summary><div class="awb-detail-fields">${controls}</div></details>
        ${batch ? `<details class="awb-details"><summary>查看已有标注与差异</summary>${selectionSummary()}</details>` : ""}
        ${!batch && draft._conflict ? `<section class="awb-alert"><p>标注已经更新，本项未提交草稿仍保留。请核对最新值后选择处理方式。</p><p>最新标签：${esc(ownTags(row).join("、") || "无")}<br>最新说明：${esc(effectiveDescription(row) || "无")}</p>${button("采用最新标注", "discard-draft", "", disabled)}${button("以此草稿重新预览", "review-draft", "", disabled)}</section>` : ""}
        ${draftError.has(activeId) ? '<p class="awb-alert">本项草稿尚未保存，请重试。</p>' : ""}
        <div class="awb-editor-actions">${button(batch ? "预览批量变更" : "保存标注", "prepare", "", disabled || (!batch && draft._conflict), true)}${!batch ? button("保存并下一项", "save-next", "", disabled || draft._conflict) : ""}</div>
        ${row?.suggestion ? `<details class="awb-details awb-suggestion"><summary>历史建议</summary><p>${(row.suggestion.tags || []).map(tag => `<span class="awb-chip">${esc(tag)}</span>`).join("")}</p><p>${esc(row.suggestion.description)}</p><small>${esc(analysisLabel(row.suggestion))}${row.suggestion.truncated ? ` · 部分内容（${readingLimits}，此建议未覆盖全文）` : ""}${analysisReason(row.suggestion) ? ` · ${esc(analysisReason(row.suggestion))}` : ""}</small>${suggestionControls(disabled)}<div class="awb-actions">${button("审核此建议", "accept-item-suggestion", "", disabled || row.writable === false)}${button("跳过此建议", "skip-item-suggestion", "", isBusy())}${batch ? button("审核所选建议", "accept-suggestion", "", disabled) + button("跳过所选建议", "skip-suggestions", "", isBusy()) : ""}</div></details>` : ""}
      </div>`;
    }
    function schemesPanel() {
      return `<div class="awb-editor"><div class="awb-editor-heading"><h3>常用方案</h3>${button("返回标注", "tab", 'data-tab="edit"')}</div>
        <p class="awb-hint">保存常用标签，下次直接复用。</p>
        ${schemesLoading ? '<p class="awb-hint" role="status">正在读取方案…</p>' : ""}
        <label>选择方案<select data-wb-field="scheme"><option value="">新建方案</option>${schemes.map(item => `<option value="${esc(item.id)}" ${item.id === scheme ? "selected" : ""}>${esc(item.name)}</option>`).join("")}</select></label>
        <label>方案名称<input data-wb-field="scheme-name" maxlength="80" value="${esc(schemeName)}" placeholder="例如：客户项目资料"></label>
        ${tagsEditor("bulk-tag-input", parseTags(bulk.tags), "常用标签", isBusy())}
        <label>说明填写提示<textarea data-wb-field="instructions" rows="3" maxlength="4000" placeholder="提醒自己需要填写哪些内容">${esc(instructions)}</textarea></label>
        <details class="awb-details"><summary>继承偏好</summary><label><select aria-label="方案继承偏好" data-wb-field="bulk-inherit"><option value="keep" ${bulk.inherit === "keep" ? "selected" : ""}>保留各项设置</option><option value="on" ${bulk.inherit === "on" ? "selected" : ""}>开启继承</option><option value="off" ${bulk.inherit === "off" ? "selected" : ""}>关闭继承</option></select></label></details>
        <div class="awb-editor-actions">${scheme ? button("使用此方案", "use-scheme", "", loading || schemesLoading || !selectedCount() || !writable(), true) : ""}${button("保存方案", "save-scheme", "", loading || schemesLoading, !scheme)}${scheme ? button("删除此方案", "delete-scheme", "", loading || schemesLoading) : ""}</div>
      </div>`;
    }
    function previewView() {
      if (!previewOpen) return "";
      let body = '<p class="awb-hint">此类型暂不支持内容预览，仍可进行手工标注。</p>';
      if (preview?.loading) body = '<p role="status">正在读取预览…</p>';
      else if (preview?.error) body = `<p role="status">${esc(preview.error)}</p>`;
      else if (preview?.text !== undefined) body = `<pre>${esc(preview.text)}</pre>`;
      else if (previewURL && preview?.type === "application/pdf") body = `<iframe sandbox title="${esc(preview.name || "文件预览")}" src="${esc(previewURL)}"></iframe>`;
      else if (previewURL && preview?.type?.startsWith("image/")) body = `<img src="${esc(previewURL)}" alt="${esc(preview.name || "文件预览")}">`;
      return `<section class="awb-preview" aria-label="文件预览"><header><strong>${esc(current()?.name || "文件预览")}</strong><span>${preview?.truncated ? "部分内容" : ""}</span>${button("收起", "preview")}</header>${body}</section>`;
    }
    function planView() {
      if (!plan) return "";
      const describe = (value, before = false) => {
        if (!value || typeof value !== "object") return typeof value === "string" ? value : "人工字段保持原值";
        if (before) { const annotation = Object.hasOwn(value, "manual") || Object.hasOwn(value, "automatic") ? value : { manual: value }; return `本项标签：${ownTags({ annotation }).join("、") || "无"} · 本项说明：${ownDescription({ annotation }) || "空"} · 继承：${value.inherit === false ? "关闭" : "开启"}`; }
        const changes = [];
        if (Object.hasOwn(value, "tags")) changes.push(value.tags?.length ? `本项标签改为：${value.tags.join("、")}` : "清空本项标签");
        if (Object.hasOwn(value, "description")) changes.push(value.description ? `本项说明改为：${value.description}` : "清空本项说明");
        if (Object.hasOwn(value, "inherit")) changes.push(value.inherit ? "开启继承" : "关闭继承");
        return changes.join(" · ") || (value.reviewed ? "确认本项标注，人工字段保持原值" : "人工字段保持原值");
      };
      return `<div class="awb-overlay"><section role="dialog" aria-modal="true" aria-label="确认标注变更" class="awb-confirm" tabindex="-1"><p class="awb-eyebrow">保存前核对</p><h2>将处理 ${Number(plan.targetCount) || 0} 项</h2><p>实际变更 ${Number(plan.changeCount) || 0} 项；未修改字段保持原值。</p>${planKind === "suggestion" ? `<p class="awb-hint">内容读取边界：${readingLimits}。标记“部分内容”的建议未覆盖全文，请对照原文件复核。</p>` : ""}${error ? `<p class="awb-alert" role="alert">${esc(error)}</p>` : ""}${(plan.warnings || []).map(item => `<p class="awb-alert">${esc(typeof item === "string" ? item : item.message || item.code)}</p>`).join("")}<div class="awb-diffs">${(plan.examples || []).slice(0, 8).map(item => `<article><strong>${esc(item.name)}</strong><del>${esc(describe(item.before, true))}</del><ins>${esc(describe(item.after))}</ins></article>`).join("")}</div><footer>${button("返回调整", "plan-close", "", loading)}${button(loading ? "提交中…" : planKind === "next" ? "确认保存并下一项" : "确认保存", "plan-apply", "", loading || !plan.changeCount, true)}</footer></section></div>`;
    }
    function render() {
      if (!visible) return "";
      const selectedVisible = items.length && items.every(row => selected.has(row.id));
      const pageNumber = Math.floor(offset / pageSize) + 1, pageCount = Math.max(1, Math.ceil(filteredTotal / pageSize));
      const typeOptions = [...new Set([...cache.values()].map(row => row.kind === "folder" ? "folder" : String(row.name).split(".").at(-1).toLowerCase()).concat(type ? [type] : []))].sort();
      const folders = items.filter(row => row.kind === "folder"), hasSelection = selected.size > 0 || !!allMatching;
      const resumeAllowed = ["paused", "partial"].includes(job?.status) && job?.activity !== "suggest" && (job?.activity || job?.scanComplete === false);
      const legacyGenerating = job?.activity === "suggest" && busyStates.has(job?.status);
      return `<section class="annotation-workbench ${leftHidden ? "is-left-hidden" : ""}" aria-label="空间标注工作台" data-workbench-job="${esc(job?.id || "")}">
        <header class="awb-top"><div>${button("← 返回空间", "close")}<div><h2>标注工作台</h2><p class="awb-context">${esc(origin?.scopeName || (origin?.ids?.length ? `选定的 ${origin.ids.length} 项` : "当前文件夹"))}</p></div></div>
          <div class="awb-top-actions">${resumeAllowed ? button("继续未完成任务", "resume", "", loading, true) : ""}
            <details class="awb-more"><summary class="button">更多 ⋯</summary><div class="awb-menu" role="group" aria-label="工作台更多操作">${button("撤销最近批次", "undo", "", loading || !job)}${button("重新扫描", "fresh", "", loading)}${busyStates.has(job?.status) ? button("暂停", "pause", "", loading) : ""}${busyStates.has(job?.status) || job?.status === "paused" ? button("取消后续处理", "cancel", "", loading) : ""}</div></details>
          </div></header>
        ${loading || busyStates.has(job?.status) || job?.scanComplete === false ? `<div class="awb-progress" role="status"><span>${loading ? "正在处理…" : job?.scanComplete === false ? `正在扫描，已发现 ${Number(job?.scanned) || items.length} 项` : `已完成 ${Number(job?.completed) || 0} 项`}</span>${legacyGenerating ? `<span>此前的建议任务仍在运行</span>${button("停止生成", "cancel", "", loading)}` : '<span>进度自动保留</span>'}</div>` : ""}
        ${error ? `<div class="awb-alert" role="alert">${esc(error)} ${button("重试读取", "refresh", "", loading)}</div>` : ""}
        ${message ? `<p class="awb-message" role="status">${esc(message)}</p>` : ""}
        <div class="awb-layout">
          ${!leftHidden ? `<aside class="awb-left" aria-label="标注范围与待办"><div class="awb-panel-heading"><h3>范围设置</h3>${button("完成", "left")}</div>${scopeHistory.length ? button("← 上一级范围", "scope-parent") : ""}
            <p class="awb-scope-name">${esc(origin?.scopeName || "当前文件夹")}</p><label class="awb-check"><input type="checkbox" data-wb-field="recursive" ${origin?.recursive ? "checked" : ""} ${loading || origin?.ids?.length ? "disabled" : ""}>包含子文件夹</label>
            ${resumableJobs.filter(item => item.id !== job?.id).length ? `<label>最近任务<select data-wb-field="job"><option value="${esc(job?.id)}">当前任务 · ${total} 项</option>${resumableJobs.filter(item => item.id !== job?.id).map(item => `<option value="${esc(item.id)}">${esc(item.name || "标注任务")} · ${Number(item.total) || 0} 项${item.status === "paused" ? " · 已暂停" : ""}</option>`).join("")}</select></label>` : ""}
            ${folders.length ? `<div class="awb-scope-folders"><h3>当前目录中的文件夹</h3>${folders.slice(0, 30).map(row => `<button type="button" class="awb-folder" data-action="space-wb-scope-folder" data-id="${esc(row.id)}" data-name="${esc(row.name)}">▸ ${esc(row.name)}</button>`).join("")}</div>` : ""}
          </aside>` : ""}
          <main class="awb-main"><div class="awb-list-tools"><label class="awb-search"><input type="search" aria-label="查找文件" data-wb-field="query" value="${esc(query)}" placeholder="搜索文件、标签或说明"></label>
            <select data-wb-field="status" aria-label="按标注状态筛选"><option value="">全部状态</option>${Object.entries(stateNames).map(([key, name]) => `<option value="${key}" ${state === key ? "selected" : ""}>${name} (${Number(summary[key]) || 0})</option>`).join("")}</select>
            <select data-wb-field="type" aria-label="按文件类型筛选"><option value="">所有类型</option>${typeOptions.map(value => `<option value="${esc(value)}" ${type === value ? "selected" : ""}>${esc(value === "folder" ? "文件夹" : value.toUpperCase())}</option>`).join("")}</select>
            ${button("范围设置", "left", `aria-expanded="${!leftHidden}"`)}</div>
            <div class="awb-selection-bar"><span>${allMatching ? `已选全部筛选结果 ${filteredTotal} 项` : selected.size ? `已选 ${selected.size} 项` : `共 ${filteredTotal} 项 · 点击文件开始标注`}</span>${hasSelection ? button("清除选择", "clear") : ""}${hasSelection && !allMatching && filteredTotal > items.length ? button(`选择整个筛选范围（${filteredTotal}）`, "matching-select", "", !job?.scanComplete) : ""}</div>
            <div class="awb-table-head" role="row"><span><input type="checkbox" data-action="space-wb-page-select" aria-label="选择当前页" title="选择当前页" ${selectedVisible || allMatching ? "checked" : ""} ${!items.length ? "disabled" : ""}></span><span>文件</span><span>标签</span><span>状态</span></div>
            <div class="awb-list-viewport" data-wb-scroll tabindex="0" role="listbox" aria-multiselectable="true" aria-label="标注文件列表" aria-busy="${loadingList}">${items.map(row => `<article class="awb-file ${row.id === activeId ? "is-current" : ""} ${allMatching || selected.has(row.id) ? "is-selected" : ""}" role="option" aria-selected="${allMatching || selected.has(row.id)}" data-action="space-wb-focus" data-id="${esc(row.id)}" tabindex="${row.id === activeId ? "0" : "-1"}"><input type="checkbox" aria-label="选择 ${esc(row.name)}" data-action="space-wb-check" data-id="${esc(row.id)}" ${allMatching || selected.has(row.id) ? "checked" : ""} ${allMatching ? 'disabled title="先清除全部范围选择，再逐项选择"' : ""}><div class="awb-file-name"><strong><span aria-hidden="true">${row.kind === "folder" ? "▰" : "▤"}</span> ${esc(row.name)}</strong><small title="${esc(row.path || "")}">${esc(row.path || "当前目录")} · ${row.kind === "folder" ? "文件夹" : size(row.size)}</small></div><div class="awb-row-tags">${(row.annotation?.tags || []).slice(0, 2).map(tag => `<span class="awb-chip">${esc(tag)}</span>`).join("")}${(row.annotation?.tags?.length || 0) > 2 ? `<small>+${row.annotation.tags.length - 2}</small>` : ""}</div><div><span class="awb-status is-${esc(row.status || "unannotated")}">${stateNames[row.status] || "待标注"}</span>${row.writable === false ? '<small class="awb-readonly">只读</small>' : ""}${row.error ? `<small title="${esc(errorText(row.error))}">需重试</small>` : ""}</div></article>`).join("") || `<div class="awb-empty">${loading ? "正在读取文件…" : "没有匹配的文件"}</div>`}</div>
            <footer class="awb-list-footer"><span class="awb-page-range" aria-live="polite">${items.length ? offset + 1 : 0}–${Math.min(offset + items.length, filteredTotal)} / ${filteredTotal}${job?.scanComplete === false ? " · 扫描中" : ""}</span><div class="awb-pagination"><label class="awb-page-size">每页 <select data-wb-field="page-size" aria-label="每页文件数" ${loading || !job ? "disabled" : ""}>${pageSizes.map(count => `<option value="${count}" ${pageSize === count ? "selected" : ""}>${count}</option>`).join("")}</select> 项</label><span class="awb-page-count">第 ${pageNumber} / ${pageCount} 页</span>${button("上一页", "previous-page", "", offset === 0 || loading)}${button("下一页", "next-page", "", offset + pageSize >= filteredTotal || loading)}</div></footer>
            <div class="awb-reader-bar">${button("上一项", "previous", "", !activeId)}${button("下一项", "next", "", !activeId)}${button(previewOpen ? "收起预览" : "文件预览", "preview", "", !activeId)}</div>${previewView()}
          </main>
          <aside class="awb-right" aria-label="标注编辑器">${tab === "schemes" ? schemesPanel() : editPanel()}</aside>
        </div>
        <footer class="awb-bottom"><span>勾选多项即可批量标注</span><span>↑ ↓ 切换 · ⌘ / Ctrl + Enter 保存${isBatch() ? "所选项" : "并下一项"}</span></footer>${planView()}
      </section>`;
    }
    function mounted(root = document) {
      tagRepaint = false;
      if (tagFocus) { const field = tagFocus; tagFocus = ""; root.querySelector?.(`[data-wb-field="${field}"]`)?.focus?.({ preventScroll: true }); }
      const viewport = root.querySelector?.("[data-wb-scroll]");
      if (viewport) { if (Math.abs(viewport.scrollTop - scrollTop) > 2) viewport.scrollTop = scrollTop; }
      for (const node of root.querySelectorAll?.(".awb-top, .awb-layout, .awb-bottom") || []) node.inert = !!plan;
      if (plan && focusedPlan !== plan.planId) { focusedPlan = plan.planId; root.querySelector?.(".awb-confirm")?.focus?.(); }
      else if (!plan && pendingFocus) {
        const row = root.querySelector?.(`.awb-file[data-id="${pendingFocus}"]`);
        row?.focus?.({ preventScroll: true });
        row?.scrollIntoView?.({ block: "nearest" });
        if (viewport) scrollTop = viewport.scrollTop;
        pendingFocus = ""; focusedPlan = "";
      }
    }
    function onScroll(top) { scrollTop = top; }
    function retainEditor() {
      if (!visible || plan || tagRepaint || drafts.get(activeId)?._conflict || isBusy()) return false;
      const field = document.activeElement;
      return !!field?.dataset?.wbField && !["type", "status", "page-size", "tag-existing", "recursive", "job", "scheme", "suggestion-tags", "suggestion-description", "bulk-tagMode", "bulk-descriptionMode", "bulk-inherit"].includes(field.dataset.wbField);
    }
    return { open, render, action, input, keydown, reset, active: () => visible, mounted, onScroll, retainEditor,
      composition(value) { composing = value; }, refresh: loadPage };
  };
})();
