(() => {
  const esc = value => String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
  const parseTags = value => [...new Set(String(value || "").split(/[,，;；\n]+/).map(tag => tag.trim()).filter(Boolean))];
  const ownTags = row => row?.annotation?.manual?.tags ?? row?.annotation?.automatic?.tags ?? [];
  const ownDescription = row => row?.annotation?.manual?.description ?? row?.annotation?.automatic?.description ?? "";
  const effectiveDescription = row => row?.annotation?.description ?? ownDescription(row);
  const stateNames = { unannotated: "待标注", suggested: "有建议", confirmed: "已确认", review: "需复核", failed: "失败" };
  const busyStates = new Set(["scanning", "generating", "suggesting", "applying", "undoing", "running"]);
  const errors = { SPACE_CONTEXT_CHANGED: "账号、盒子或权限已变化，请重新打开工作台。", SPACE_ANNOTATION_CONFLICT: "文件或标注已经更新，冲突项已保留，请重新核对。", SPACE_ANNOTATION_READ_ONLY: "此空间为只读，不能保存标注。", SPACE_ANNOTATION_STORAGE_FAILED: "草稿或标注未能保存，请检查本机存储后重试。", SPACE_ANNOTATION_MODEL_UNAVAILABLE: "尚未配置可用模型；手工批量标注仍可使用。", SPACE_ANNOTATION_INSTRUCTIONS_TOO_LONG: "方案要求与本批补充要求合计最多 4000 个字符，请缩短后重试。", SPACE_ANNOTATION_NO_CHANGES: "所选项目已与目标一致，没有需要保存的变更。", BOX_CONNECTION_REQUIRED: "连接暂不可用，请恢复盒子连接后继续。", UNKNOWN_CLIENT_ACTION: "工作台接口尚未加载，请重启客户端。" };
  const errorText = cause => { const code = String(cause?.code || cause?.message || cause || ""); return Object.entries(errors).find(([key]) => code.includes(key))?.[1] || "操作未完成，已保留本次草稿。请重试。"; };
  const size = value => Number.isFinite(value) ? value >= 1048576 ? `${(value / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.ceil(value / 1024))} KB` : "—";
  const button = (label, name, extra = "", disabled = false, primary = false) => `<button type="button" class="button ${primary ? "primary" : ""}" data-action="space-wb-${name}" ${extra} ${disabled ? "disabled" : ""}>${label}</button>`;
  const analysisReasons = { SPACE_ANNOTATION_FOLDER_NAME_ONLY: "文件夹按名称分析", SPACE_ANNOTATION_IMAGE_NO_OCR: "图片尚不支持文字识别", SPACE_ANNOTATION_CONTENT_UNSUPPORTED: "此文件格式暂不支持内容读取", SPACE_ANNOTATION_CONTENT_NOT_READ: "本次未读取文件正文", SPACE_ANNOTATION_NAME_ONLY: "本次未读取文件正文", SPACE_ANNOTATION_CONTENT_EMPTY: "未提取到可用正文", SPACE_ANNOTATION_CONTENT_TOO_LARGE: "文件超出本次内容读取大小限制", SPACE_ANNOTATION_EXTRACTION_TIMEOUT: "内容读取超时", SPACE_ANNOTATION_CONTENT_ENCRYPTED: "文件已加密，无法读取正文", SPACE_ANNOTATION_PDF_NO_TEXT: "未找到可提取文字，首版不提供 OCR", SPACE_ANNOTATION_EXTRACTION_BUDGET: "内容读取达到本次预算限制" };
  const analysisLabel = suggestion => suggestion.contentMode === "content" ? "内容分析" : suggestion.contentMode === "unsupported" ? "不支持内容分析" : "仅分析名称";
  const analysisReason = suggestion => !suggestion.reason ? "" : analysisReasons[suggestion.reason] || "本次无法读取文件正文，可继续手工标注";
  const readingLimits = "每项最大 64 MB；文本型 PDF 最多读取前 200 页；每项最多分析 32768 个字符";

  window.createSpaceAnnotationWorkbench = ({ call, changed = () => {}, onClose = () => {} }) => {
    let visible = false, epoch = 0, origin = null, job = null, items = [], total = 0, filteredTotal = 0, offset = 0;
    let summary = {}, filteredSummary = null, resumableJobs = [], error = "", loading = false, message = "", leftHidden = false, rightHidden = false;
    let query = "", type = "", state = "", activeId = "", anchor = "", selected = new Set(), allMatching = null;
    let cache = new Map(), drafts = new Map(), draftTimers = new Map(), draftWrites = new Map(), draftError = new Set(), committingDrafts = new Map();
    let scrollTop = 0, poll = null, queryTimer = null, loadingList = false, nextAfterApply = null;
    let tab = "edit", model = "", models = { available: false, presets: [] }, schemes = [], scheme = "", instructions = "", schemeName = "";
    let bulk = { tagMode: "keep", tags: "", descriptionMode: "keep", description: "", inherit: "keep" };
    let suggestionPolicy = { tagMode: "add", descriptionMode: "fill-empty" };
    let plan = null, planKind = "", preview = null, previewURL = null, previewOpen = false, composing = false, scopeHistory = [], pendingFocus = "", focusedPlan = "";
    const pageSize = 200, rowHeight = 58, visibleRows = 22;
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
    function schedulePoll() {
      clearTimeout(poll); poll = null;
      if (visible && busyStates.has(job?.status)) poll = setTimeout(() => { void loadPage(true); }, 1000);
    }
    function consume(value, preservePage = false) {
      if (value?.job) job = value.job;
      if (Array.isArray(value?.items)) {
        if (!preservePage) items = value.items;
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
      if (!activeId && items.length) activeId = items[0].id;
      if (nextAfterApply && !preservePage && !busyStates.has(job?.status)) {
        const prior = nextAfterApply; nextAfterApply = null;
        if (cache.get(prior)?.status !== "failed") { const index = items.findIndex(row => row.id === prior); activeId = items[Math.min(items.length - 1, index + 1)]?.id || prior; selected.clear(); }
      }
      schedulePoll();
    }
    async function loadPage(quiet = false) {
      if (!job || loadingList) return;
      const revision = epoch;
      loadingList = true; if (!quiet) { loading = true; emit(); }
      try { consume(await invoke({ op: "list", jobId: job.id, offset, limit: pageSize, query, type, status: state })); error = ""; }
      catch (cause) { if (visible && revision === epoch) error = errorText(cause); }
      finally { if (revision === epoch) { loadingList = false; loading = false; emit(); } }
    }
    async function loadAuxiliary() {
      const revision = epoch;
      const values = await Promise.allSettled([invoke({ op: "models" }), invoke({ op: "schemes" })]);
      if (!visible || revision !== epoch) return;
      models = values[0].status === "fulfilled" ? values[0].value : { available: false, presets: [] };
      schemes = values[1].status === "fulfilled" ? values[1].value.items || [] : [];
      if (!models.presets?.some(item => item.id === model)) model = models.presets?.[0]?.id || "";
      emit();
    }
    async function open(input, keepHistory = false) {
      const history = keepHistory ? [...scopeHistory] : [];
      reset(); scopeHistory = history; visible = true; epoch++; origin = { ...input }; loading = true;
      const revision = epoch;
      selected = new Set(input.ids || []); activeId = input.ids?.[0] || ""; error = ""; emit();
      try { consume(await invoke({ op: "open", space_id: input.space_id || "personal", parent: input.parent || "", ...(input.ids?.length ? { ids: input.ids } : {}), recursive: input.recursive === true, ...(input.fresh ? { fresh: true } : {}) })); void loadAuxiliary(); }
      catch (cause) { if (visible && revision === epoch) error = errorText(cause); }
      finally { if (revision === epoch) { loading = false; emit(); } }
    }
    function reset() {
      visible = false; epoch++; clearTimeout(poll); clearTimeout(queryTimer); poll = queryTimer = null;
      for (const timer of draftTimers.values()) clearTimeout(timer);
      draftTimers.clear(); draftWrites.clear(); draftError.clear(); drafts.clear(); committingDrafts.clear(); cache.clear(); releasePreview();
      origin = null; job = null; items = []; total = filteredTotal = offset = scrollTop = 0; loading = loadingList = false;
      activeId = anchor = ""; selected.clear(); allMatching = null; error = message = ""; plan = null; nextAfterApply = null;
      summary = {}; filteredSummary = null; resumableJobs = []; query = type = state = ""; previewOpen = composing = false;
      scopeHistory = []; pendingFocus = focusedPlan = "";
      models = { available: false, presets: [] }; model = scheme = schemeName = instructions = ""; schemes = []; tab = "edit";
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
      if (!job || !drafts.has(id) || (!force && !draftError.has(id) && !drafts.get(id)._dirty)) return;
      if (drafts.get(id)._conflict) throw Object.assign(Error("SPACE_ANNOTATION_CONFLICT"), { code: "SPACE_ANNOTATION_CONFLICT" });
      const value = drafts.get(id), patch = {};
      for (const key of value._fields) patch[key] = key === "tags" ? [...value.tags] : value[key];
      if (force && !Object.keys(patch).length) patch.tags = [...value.tags];
      const revision = epoch, jobId = job.id;
      value._dirty = false;
      const previous = draftWrites.get(id) || Promise.resolve();
      const work = previous.catch(() => {}).then(() => { check(revision); return invoke({ op: "draft", jobId, id, patch }); }).then(() => { if (revision === epoch) draftError.delete(id); }, cause => { if (revision === epoch) draftError.add(id); throw cause; });
      draftWrites.set(id, work);
      try { await work; }
      catch (cause) { if (visible && revision === epoch) { error = errorText(cause); emit(); } throw cause; }
    }
    async function focusRow(id, event = {}) {
      if (id === activeId) return;
      if (activeId) try { await flushDraft(activeId); } catch { return; }
      const before = activeId; activeId = id;
      pendingFocus = id;
      if (event.shiftKey) {
        allMatching = null;
        const from = items.findIndex(row => row.id === (anchor || before)), to = items.findIndex(row => row.id === id);
        for (const row of items.slice(Math.max(0, Math.min(from, to)), Math.max(from, to) + 1)) selected.add(row.id);
      } else anchor = id;
      if (previewOpen) void fetchPreview();
      emit();
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
    async function prepare(kind, forCurrent = false) {
      if (!job || !selectedCount() || !writable() || isBusy() || ((forCurrent || ["single", "next"].includes(kind)) && current()?.writable === false)) return;
      error = ""; loading = true; emit();
      try {
        if (kind === "single" || kind === "next") await flushDraft(activeId, true);
        plan = await invoke({ op: "prepare", jobId: job.id, selection: forCurrent || kind === "single" || kind === "next" ? { ids: [activeId] } : selection(),
          change: kind === "single" || kind === "next" ? { tagMode: "keep", tags: [], descriptionMode: "keep", description: "" } : kind === "suggestion" ? { ...suggestionPolicy, tags: [], description: "" } : changes(),
          ...(kind === "single" || kind === "next" ? { useDrafts: true } : {}), ...(kind === "suggestion" ? { acceptSuggestions: true } : {}) });
        planKind = kind;
      } catch (cause) {
        if (kind === "next" && String(cause?.code || cause?.message || "").includes("SPACE_ANNOTATION_NO_CHANGES")) {
          message = errorText(cause); selected.clear(); const index = items.findIndex(row => row.id === activeId); await focusRow(items[Math.min(items.length - 1, index + 1)]?.id || activeId);
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
        if (kind === "next") nextAfterApply = activeId;
        plan = null; message = "已提交本批次，冲突和失败项会单独保留。"; consume(value, true); await loadPage(true);
      } catch (cause) { error = errorText(cause); }
      finally { loading = false; emit(); }
    }
    async function close() {
      try { for (const id of drafts.keys()) await flushDraft(id); await Promise.all([...draftWrites.values()]); }
      catch { return; }
      reset(); onClose(); changed();
    }
    async function changeScope(input, push = true) {
      for (const id of drafts.keys()) await flushDraft(id);
      await Promise.all([...draftWrites.values()]);
      if (push) scopeHistory.push({ ...origin });
      await open(input, true);
    }
    async function changeJob(id) {
      if (!id || id === job?.id || loading) return;
      for (const draftId of drafts.keys()) await flushDraft(draftId);
      await Promise.all([...draftWrites.values()]);
      epoch++; loadingList = false;
      clearTimeout(poll); clearTimeout(queryTimer); poll = queryTimer = null;
      drafts.clear(); draftWrites.clear(); draftError.clear(); committingDrafts.clear(); cache.clear(); releasePreview();
      selected.clear(); allMatching = null; activeId = anchor = ""; items = []; offset = scrollTop = 0; plan = null; nextAfterApply = null; previewOpen = false; filteredSummary = null;
      suggestionPolicy = { tagMode: "add", descriptionMode: "fill-empty" }; job = { id, status: "paused" }; await loadPage();
    }
    async function action(name, data = {}, event = {}) {
      if (!visible) return;
      try {
        if (name === "close") return await close();
        if (name === "focus") return await focusRow(data.id, event);
        if (name === "check") { allMatching = null; if (selected.has(data.id)) selected.delete(data.id); else selected.add(data.id); if (!activeId) activeId = data.id; emit(); return; }
        if (name === "page-select") { allMatching = null; const all = items.length > 0 && items.every(row => selected.has(row.id)); for (const row of items) if (all) selected.delete(row.id); else selected.add(row.id); emit(); return; }
        if (name === "matching-select") { if (!job?.scanComplete) { message = "目录仍在扫描，完成后可选择整个筛选范围。"; emit(); return; } selected.clear(); allMatching = { query, type, status: state }; emit(); return; }
        if (name === "clear") { selected.clear(); allMatching = null; emit(); return; }
        if (name === "filter") { state = data.status || ""; offset = scrollTop = 0; allMatching = null; filteredSummary = null; await loadPage(); return; }
        if (name === "previous-page" || name === "next-page") { offset = Math.max(0, offset + (name === "next-page" ? pageSize : -pageSize)); scrollTop = 0; await loadPage(); return; }
        if (name === "previous" || name === "next") { const index = items.findIndex(row => row.id === activeId); await focusRow(items[Math.max(0, Math.min(items.length - 1, index + (name === "next" ? 1 : -1)))]?.id || activeId); return; }
        if (name === "preview") { if (previewOpen) { previewOpen = false; releasePreview(); emit(); } else await fetchPreview(); return; }
        if (name === "left" || name === "right") { if (name === "left") leftHidden = !leftHidden; else rightHidden = !rightHidden; emit(); return; }
        if (name === "tab") { tab = data.tab; emit(); return; }
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
        if (["pause", "resume", "cancel", "undo"].includes(name)) { loading = true; emit(); consume(await invoke({ op: name, jobId: job.id }), true); await loadPage(true); message = name === "undo" ? "已核对并撤销可恢复的项目；后续修改冲突会单独保留。" : ""; loading = false; emit(); return; }
        if (name === "refresh") return await loadPage();
        if (name === "fresh") return await changeScope({ ...origin, fresh: true }, false);
        if (name === "scope-parent" && scopeHistory.length) { const previous = scopeHistory.pop(); return await changeScope(previous, false); }
        if (name === "scope-folder") return await changeScope({ space_id: origin.space_id, parent: data.id || "", recursive: origin.recursive, scopeName: data.name || "文件夹" });
        if (name === "source") return await changeScope({ space_id: origin.space_id, parent: "", ids: [data.id], scopeName: data.name || "来源文件夹" });
        if (name === "chip") { if (!writable() || isBusy()) return; if (isBatch()) { bulk.tagMode = "add"; bulk.tags = [...new Set([...parseTags(bulk.tags), data.tag])].join("，"); } else { const value = draftFor(current()); value.tags = [...new Set([...value.tags, data.tag])]; value._fields.add("tags"); value._dirty = value._edited = true; value._serial++; if (!value._conflict) void flushDraft(activeId).catch(() => {}); } emit(); return; }
        if (name === "suggest") {
          if (!models.available || !model || !selectedCount() || isBusy()) return;
          loading = true; error = ""; emit(); consume(await invoke({ op: "suggest", jobId: job.id, selection: selection(), modelPresetId: model, instructions, ...(scheme ? { schemeId: scheme } : {}) }), true); await loadPage(true);
          message = "建议将逐项进入待审核列表，原标注尚未改变。"; loading = false; emit(); return;
        }
        if (name === "save-scheme") {
          if (!schemeName.trim()) { error = "请为方案填写名称。"; emit(); return; }
          if (schemeName.trim().length > 80) { error = "方案名称最多 80 个字符。"; emit(); return; }
          await invoke({ op: "save-scheme", scheme: { ...(scheme ? { id: scheme } : {}), name: schemeName.trim(), tags: parseTags(bulk.tags), instructions, ...(bulk.inherit !== "keep" ? { inherit: bulk.inherit === "on" } : {}) } });
          schemes = (await invoke({ op: "schemes" })).items || []; message = "方案已保存，可在其他批次复用。"; emit(); return;
        }
        if (name === "delete-scheme" && scheme) { await invoke({ op: "delete-scheme", id: scheme }); scheme = ""; schemes = (await invoke({ op: "schemes" })).items || []; emit(); return; }
      } catch (cause) { error = errorText(cause); loading = false; emit(); }
    }
    function input(name, value) {
      if (!visible) return;
      if (["item-tags", "item-description", "item-inherit"].includes(name)) {
        const row = current(); if (!row || row.writable === false || isBusy()) return;
        const draft = draftFor(row), key = name === "item-tags" ? "tags" : name === "item-description" ? "description" : "inherit"; draft[key] = name === "item-tags" ? parseTags(value) : value; draft._fields.add(key);
        draft._dirty = draft._edited = true; draft._serial++; clearTimeout(draftTimers.get(row.id)); if (!draft._conflict) draftTimers.set(row.id, setTimeout(() => { void flushDraft(row.id).catch(() => {}); }, 250)); return;
      }
      if (name === "query") { query = value; offset = scrollTop = 0; allMatching = null; filteredSummary = null; clearTimeout(queryTimer); queryTimer = setTimeout(() => { void loadPage(); }, 250); return; }
      if (name === "type") { type = value; offset = scrollTop = 0; allMatching = null; filteredSummary = null; void loadPage(); return; }
      if (name === "recursive") { void changeScope({ ...origin, recursive: value, fresh: true }, false).catch(cause => { error = errorText(cause); emit(); }); return; }
      if (name === "job") { void changeJob(value).catch(cause => { error = errorText(cause); emit(); }); return; }
      if (name === "scheme") {
        scheme = value; const chosen = schemes.find(item => item.id === value);
        if (chosen) { bulk.tags = (chosen.tags || []).join("，"); bulk.tagMode = "add"; instructions = chosen.instructions || ""; bulk.inherit = chosen.inherit === undefined ? "keep" : chosen.inherit ? "on" : "off"; schemeName = chosen.name; }
        else schemeName = "";
        emit(); return;
      }
      if (name === "model") model = value;
      else if (name === "suggestion-tags" && ["add", "keep", "replace"].includes(value)) suggestionPolicy.tagMode = value;
      else if (name === "suggestion-description" && ["fill-empty", "keep", "replace"].includes(value)) suggestionPolicy.descriptionMode = value;
      else if (name === "instructions") instructions = value;
      else if (name === "scheme-name") schemeName = value;
      else if (name.startsWith("bulk-")) { const field = name.slice(5); if (Object.hasOwn(bulk, field)) bulk[field] = value; }
      if (["bulk-tagMode", "bulk-descriptionMode", "bulk-inherit", "suggestion-tags", "suggestion-description"].includes(name)) emit();
    }
    async function keydown(event) {
      if (!visible || composing || event.isComposing) return false;
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") { event.preventDefault(); if (plan) await submitPlan(); else await prepare("next"); return true; }
      if (plan) { if (event.key === "Escape") { event.preventDefault(); plan = null; emit(); } return true; }
      if (event.target?.closest?.("input, textarea, select")) return false;
      if (["ArrowDown", "ArrowUp"].includes(event.key)) { event.preventDefault(); const index = items.findIndex(row => row.id === activeId); const row = items[Math.max(0, Math.min(items.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)))]; if (row) await focusRow(row.id, event); return true; }
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
      const chips = `<div class="awb-common-tags">${(values.tagCounts || []).slice(0, 12).map(({ tag, count }) => `<span class="awb-chip ${count === values.count ? "" : "is-mixed"}" title="${count === values.count ? "全部共有" : "部分文件已有"}">${esc(tag)} <small>${count}/${values.count}</small></span>`).join("") || '<span class="muted">暂无本项标签</span>'}</div>`;
      if (!isBatch()) return chips;
      const partial = !allMatching && rows.length < selectedCount();
      return `${note}${partial ? `<p class="awb-hint">已加载 ${rows.length}/${selectedCount()} 项，以下仅统计已加载项；提交前会完整核对。</p>` : allMatching ? '<p class="awb-hint">完整筛选范围统计</p>' : ""}${chips}<p class="awb-hint">${values.commonDescription === null ? "说明为混合值，未修改时各项保留" : `说明共同值：${esc(values.commonDescription || "空说明")}`}<br>空说明 ${Number(values.emptyDescriptions) || 0}/${values.count} 项 · 继承开启 ${Number(values.inheritOn) || 0} 项 / 关闭 ${Number(values.inheritOff) || 0} 项</p>`;
    }
    function suggestionControls(disabled = false) {
      return `<div class="awb-reading-scope"><strong>接受建议的方式</strong><label>建议标签<select data-wb-field="suggestion-tags" ${disabled ? "disabled" : ""}><option value="add" ${suggestionPolicy.tagMode === "add" ? "selected" : ""}>补充标签，保留已有标签</option><option value="keep" ${suggestionPolicy.tagMode === "keep" ? "selected" : ""}>保持已有标签</option><option value="replace" ${suggestionPolicy.tagMode === "replace" ? "selected" : ""}>替换本项标签</option></select></label><label>建议说明<select data-wb-field="suggestion-description" ${disabled ? "disabled" : ""}><option value="fill-empty" ${suggestionPolicy.descriptionMode === "fill-empty" ? "selected" : ""}>仅填补空说明</option><option value="keep" ${suggestionPolicy.descriptionMode === "keep" ? "selected" : ""}>保持已有说明</option><option value="replace" ${suggestionPolicy.descriptionMode === "replace" ? "selected" : ""}>替换本项说明</option></select></label><p class="awb-hint">逐文件使用各自的建议；继承设置保持原值。替换前会展示实际变更。</p></div>`;
    }
    function editPanel() {
      const row = current(), batch = isBatch(), disabled = isBusy() || !writable();
      const draft = draftFor(row);
      const inherited = row?.annotation?.provenance?.filter(item => item.source === "inherited") || [];
      if (!row && !allMatching) return '<div class="awb-panel-empty">从列表选择一份文件，或勾选多项批量处理。</div>';
      const tags = batch ? `<label>标签操作<select data-wb-field="bulk-tagMode"><option value="keep" ${bulk.tagMode === "keep" ? "selected" : ""}>保持原值</option><option value="add" ${bulk.tagMode === "add" ? "selected" : ""}>新增标签</option><option value="remove" ${bulk.tagMode === "remove" ? "selected" : ""}>移除本项标签</option><option value="replace" ${bulk.tagMode === "replace" ? "selected" : ""}>替换本项标签</option></select></label>${bulk.tagMode !== "keep" ? `<label>标签（逗号分隔）<input data-wb-field="bulk-tags" value="${esc(bulk.tags)}" maxlength="2400" placeholder="例如：客户资料，待归档" ${disabled ? "disabled" : ""}></label>` : ""}` : `<label>本项标签<input data-wb-field="item-tags" value="${esc(draft.tags.join("，"))}" maxlength="2400" placeholder="输入标签，以逗号分隔" ${disabled ? "disabled" : ""}></label>`;
      const description = batch ? `<label>说明操作<select data-wb-field="bulk-descriptionMode"><option value="keep" ${bulk.descriptionMode === "keep" ? "selected" : ""}>保持原值</option><option value="fill-empty" ${bulk.descriptionMode === "fill-empty" ? "selected" : ""}>只填写空说明</option><option value="replace" ${bulk.descriptionMode === "replace" ? "selected" : ""}>统一修改说明</option></select></label>${bulk.descriptionMode !== "keep" ? `<label>统一说明<textarea data-wb-field="bulk-description" rows="4" maxlength="2000" ${disabled ? "disabled" : ""}>${esc(bulk.description)}</textarea></label><p class="awb-hint">该文字将用于符合条件的全部目标文件；逐文件说明请使用助手建议。</p>` : ""}` : `<label>本项说明<textarea data-wb-field="item-description" rows="5" maxlength="2000" placeholder="这份资料是什么，适合何时使用…" ${disabled ? "disabled" : ""}>${esc(draft.description)}</textarea></label>`;
      return `<div class="awb-editor"><div class="awb-panel-heading"><strong>${batch ? `批量处理 ${selectedCount()} 项` : esc(row.name)}</strong>${row?.writable === false ? '<span class="awb-badge">只读</span>' : ""}</div>${selectionSummary()}${row?.annotation?.needsReview ? '<p class="awb-alert">文件内容已变化，保存前请复核原标注。</p>' : ""}${tags}${description}${batch ? `<label>文件夹继承<select data-wb-field="bulk-inherit"><option value="keep" ${bulk.inherit === "keep" ? "selected" : ""}>逐项保持原设置</option><option value="on" ${bulk.inherit === "on" ? "selected" : ""}>开启继承</option><option value="off" ${bulk.inherit === "off" ? "selected" : ""}>关闭继承</option></select></label>` : `<label class="awb-check"><input type="checkbox" data-wb-field="item-inherit" ${draft.inherit ? "checked" : ""} ${disabled ? "disabled" : ""}>继承上级文件夹标签与说明</label>`}${inherited.length ? `<div class="awb-inherited"><span>继承标签 · 修改来源或关闭继承后调整</span>${inherited.map(item => `<button type="button" class="awb-chip is-inherited" data-action="space-wb-source" data-id="${esc(item.itemId)}" data-name="${esc(item.sourceName || "来源文件夹")}" title="${esc(item.sourcePath || item.sourceName || "查看来源文件夹")}">${esc(item.tag)} <small>↗ ${esc(item.sourceName || "来源文件夹")}</small></button>`).join("")}</div>` : ""}${!batch && draft._conflict ? `<section class="awb-alert"><p>标注已经更新，本项未提交草稿仍保留。请核对最新值后选择处理方式。</p><p>最新标签：${esc(ownTags(row).join("、") || "无")}<br>最新说明：${esc(effectiveDescription(row) || "无")}</p>${button("采用最新标注", "discard-draft", "", disabled)}${button("以此草稿重新预览", "review-draft", "", disabled)}</section>` : ""}${draftError.has(activeId) ? '<p class="awb-alert">本项草稿尚未保存，请重试。</p>' : ""}<div class="awb-editor-actions">${button(batch ? "预览批量变更" : "预览并保存", "prepare", "", disabled || (!batch && draft._conflict), true)}${!batch ? button("保存并下一项", "save-next", "", disabled || draft._conflict) : ""}</div>${row?.suggestion ? `<section class="awb-suggestion"><h4>当前项待审核建议</h4><p>${(row.suggestion.tags || []).map(tag => `<span class="awb-chip">${esc(tag)}</span>`).join("")}</p><p>${esc(row.suggestion.description)}</p><small>${esc(analysisLabel(row.suggestion))}${row.suggestion.truncated ? ` · 部分内容（${readingLimits}，此建议未覆盖全文）` : ""}${analysisReason(row.suggestion) ? ` · ${esc(analysisReason(row.suggestion))}` : ""}</small>${suggestionControls(disabled)}${button("审核此建议", "accept-item-suggestion", "", disabled)}${button("跳过此建议", "skip-item-suggestion", "", isBusy())}</section>` : ""}</div>`;
    }
    function assistantPanel() {
      return `<div class="awb-editor"><h3>辅助标注</h3><p class="awb-hint">逐份生成建议，审核保存后才改变标注。已有人工说明默认保留。</p>${!models.available ? `<p class="awb-alert">${esc(models.reason || "尚未配置可用模型。手工标注和方案仍可使用。")}</p>` : models.aiAvailable === false ? '<p class="awb-message">AI 尚未配置；可使用本地规则生成建议，手工标注和方案仍可使用。</p>' : ""}<label>使用模型<select data-wb-field="model" ${!models.available ? "disabled" : ""}>${(models.presets || []).map(item => `<option value="${esc(item.id)}" ${item.id === model ? "selected" : ""}>${esc(item.name || item.id)}${item.provider ? ` · ${esc(item.provider)}` : ""}</option>`).join("") || '<option>暂无可用模型</option>'}</select></label><label>本批要求<textarea data-wb-field="instructions" rows="6" maxlength="4000" placeholder="例如：按客户和资料用途归类，每份资料用一句话说明。">${esc(instructions)}</textarea></label><div class="awb-reading-scope"><strong>本次读取范围</strong><p>${selectedCount()} 项 · ${allMatching ? "整个筛选范围" : "当前选定文件"}</p><p>${readingLimits}。图片、扫描件等会明确标记仅按名称分析，首版不提供 OCR。文件不会被移动或删除。</p></div>${button(isBusy() ? "正在处理…" : `为 ${selectedCount()} 项生成建议`, "suggest", "", !models.available || !model || !selectedCount() || isBusy(), true)}<p class="awb-hint">可随时暂停。恢复任务由你确认，避免重启后自动重复调用模型。</p>${suggestionControls(isBusy() || !writable())}${button("审核所选建议", "accept-suggestion", "", !selectedCount() || isBusy() || !writable())}${button("跳过所选建议", "skip-suggestions", "", !selectedCount() || isBusy())}</div>`;
    }
    function schemesPanel() {
      return `<div class="awb-editor"><h3>可复用标注方案</h3><p class="awb-hint">方案只保存标签和填写要求，不携带文件权限或模型凭据。</p><label>选择方案<select data-wb-field="scheme"><option value="">新建方案</option>${schemes.map(item => `<option value="${esc(item.id)}" ${item.id === scheme ? "selected" : ""}>${esc(item.name)}</option>`).join("")}</select></label><label>方案名称<input data-wb-field="scheme-name" maxlength="80" value="${esc(schemeName)}" placeholder="例如：客户项目资料"></label><label>常用标签<input data-wb-field="bulk-tags" maxlength="2400" value="${esc(bulk.tags)}" placeholder="客户资料，项目归档"></label><label>说明填写要求<textarea data-wb-field="instructions" rows="5" maxlength="4000">${esc(instructions)}</textarea></label><label>继承偏好<select data-wb-field="bulk-inherit"><option value="keep" ${bulk.inherit === "keep" ? "selected" : ""}>保留各项设置</option><option value="on" ${bulk.inherit === "on" ? "selected" : ""}>开启继承</option><option value="off" ${bulk.inherit === "off" ? "selected" : ""}>关闭继承</option></select></label>${button("保存方案", "save-scheme", "", loading, true)}${scheme ? button("删除此方案", "delete-scheme", "", loading) : ""}<p class="awb-hint">选择已有方案后，可回到“标注”预览应用，也可带入助手生成建议。</p></div>`;
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
      const start = Math.max(0, Math.floor(scrollTop / rowHeight) - 4), end = Math.min(items.length, start + visibleRows);
      const rendered = items.slice(start, end), selectedVisible = items.length && items.every(row => selected.has(row.id));
      const stateSummary = Object.entries(stateNames).map(([key, name]) => `<button type="button" class="awb-queue ${state === key ? "active" : ""}" data-action="space-wb-filter" data-status="${key}"><span>${name}</span><small>${Number(summary[key]) || 0}</small></button>`).join("");
      const typeOptions = [...new Set([...cache.values()].map(row => row.kind === "folder" ? "folder" : String(row.name).split(".").at(-1).toLowerCase()).concat(type ? [type] : []))].sort();
      const folders = items.filter(row => row.kind === "folder");
      return `<section class="annotation-workbench ${leftHidden ? "is-left-hidden" : ""} ${rightHidden ? "is-right-hidden" : ""}" aria-label="空间标注工作台" data-workbench-job="${esc(job?.id || "")}"><header class="awb-top"><div>${button("← 返回空间", "close")}<div><p class="awb-eyebrow">SPACE ANNOTATION</p><h2>标注工作台</h2></div></div><div class="awb-top-actions">${button(leftHidden ? "显示范围" : "收起范围", "left")}${button(rightHidden ? "显示编辑器" : "收起编辑器", "right")}${button("撤销最近批次", "undo", "", loading || !job)}${button("重新扫描", "fresh", "", loading)}${job?.status === "paused" || job?.status === "partial" ? button("继续任务", "resume", "", loading, true) : busyStates.has(job?.status) ? button("暂停", "pause", "", loading) : ""}${busyStates.has(job?.status) || job?.status === "paused" ? button("取消后续处理", "cancel", "", loading) : ""}</div></header><div class="awb-progress" role="status"><span>${loading ? "正在处理…" : job?.scanComplete === false ? `正在扫描，已发现 ${Number(job?.scanned) || items.length} 项` : `已扫描 ${Number(job?.scanned) || total} 项`}</span><span>${job?.status === "paused" ? "任务已暂停，继续后才会恢复处理" : busyStates.has(job?.status) ? "进度自动保留" : "支持混合文件 · 人工字段优先"}</span>${job?.completed !== undefined ? `<span>已完成 ${Number(job.completed)}${job.failed ? ` · ${Number(job.failed)} 项需处理` : ""}</span>` : ""}</div>${error ? `<div class="awb-alert" role="alert">${esc(error)} ${button("重试读取", "refresh", "", loading)}</div>` : ""}${message ? `<p class="awb-message" role="status">${esc(message)}</p>` : ""}<div class="awb-layout"><aside class="awb-left" aria-label="标注范围与待办"><h3>处理范围</h3>${scopeHistory.length ? button("← 上一级范围", "scope-parent") : ""}<p class="awb-scope-name">${esc(origin?.scopeName || (origin?.ids?.length ? `选定的 ${origin.ids.length} 项` : "当前文件夹"))}</p><label class="awb-check"><input type="checkbox" data-wb-field="recursive" ${origin?.recursive ? "checked" : ""} ${loading || origin?.ids?.length ? "disabled" : ""}>包含子文件夹</label><p class="awb-hint">文件夹默认标注自身，后代通过继承生效。</p>${resumableJobs.length ? `<label>最近任务<select data-wb-field="job"><option value="${esc(job?.id)}">当前任务 · ${total} 项</option>${resumableJobs.filter(item => item.id !== job?.id).map(item => `<option value="${esc(item.id)}" ${item.id === job?.id ? "selected" : ""}>${esc(item.name || "标注任务")} · ${Number(item.total) || 0} 项${item.status === "paused" ? " · 已暂停" : ""}</option>`).join("")}</select></label>` : ""}<div class="awb-queues"><button type="button" class="awb-queue ${!state ? "active" : ""}" data-action="space-wb-filter" data-status=""><span>全部文件</span><small>${total}</small></button>${stateSummary}</div><details ${folders.length < 8 ? "open" : ""}><summary>当前目录中的文件夹</summary>${folders.slice(0, 30).map(row => `<button type="button" class="awb-folder" data-action="space-wb-scope-folder" data-id="${esc(row.id)}" data-name="${esc(row.name)}">▸ ${esc(row.name)}</button>`).join("") || '<p class="awb-hint">当前页没有文件夹。</p>'}</details><div class="awb-tag-library"><h3>当前范围常用标签</h3>${(summary.tagCounts || []).slice(0, 18).map(item => `<button type="button" class="awb-chip" data-action="space-wb-chip" data-tag="${esc(item.tag)}">${esc(item.tag)} <small>${Number(item.count) || 0}</small></button>`).join("") || '<p class="awb-hint">扫描后在这里复用已有标签。</p>'}</div></aside><main class="awb-main"><div class="awb-list-tools"><label class="awb-search"><span>查找</span><input type="search" data-wb-field="query" value="${esc(query)}" placeholder="名称、路径、标签或说明"></label><select data-wb-field="type" aria-label="按文件类型筛选"><option value="">所有类型</option>${typeOptions.map(value => `<option value="${esc(value)}" ${type === value ? "selected" : ""}>${esc(value === "folder" ? "文件夹" : value.toUpperCase())}</option>`).join("")}</select></div><div class="awb-selection-bar">${button(selectedVisible && !allMatching ? "取消本页选择" : "选择当前页", "page-select", "", !items.length)}${button(`选择整个筛选范围（${filteredTotal}）`, "matching-select", "", !job?.scanComplete || !filteredTotal)}${selected.size || allMatching ? button("清除选择", "clear") : ""}<span>${allMatching ? `整个筛选范围 ${filteredTotal} 项` : selected.size ? `已勾选 ${selected.size} 项` : activeId ? "当前文件 · 尚未勾选批量目标" : "请选择文件"}</span></div><div class="awb-table-head" role="row"><span>选择</span><span>名称与目录</span><span>标签</span><span>状态</span></div><div class="awb-virtual" data-wb-scroll tabindex="0" role="listbox" aria-multiselectable="true" aria-label="标注文件列表" aria-busy="${loading}"><div style="height:${start * rowHeight}px" aria-hidden="true"></div>${rendered.map(row => `<article class="awb-file ${row.id === activeId ? "is-current" : ""} ${allMatching || selected.has(row.id) ? "is-selected" : ""}" role="option" aria-selected="${allMatching || selected.has(row.id)}" data-action="space-wb-focus" data-id="${esc(row.id)}" tabindex="${row.id === activeId ? "0" : "-1"}"><input type="checkbox" aria-label="选择 ${esc(row.name)}" data-action="space-wb-check" data-id="${esc(row.id)}" ${allMatching || selected.has(row.id) ? "checked" : ""}><div class="awb-file-name"><strong><span aria-hidden="true">${row.kind === "folder" ? "▰" : "▤"}</span> ${esc(row.name)}</strong><small title="${esc(row.path || "")}">${esc(row.path || "当前目录")} · ${row.kind === "folder" ? "文件夹" : size(row.size)}</small></div><div class="awb-row-tags">${(row.annotation?.tags || []).slice(0, 3).map(tag => `<span class="awb-chip">${esc(tag)}</span>`).join("")}${(row.annotation?.tags?.length || 0) > 3 ? `<small>+${row.annotation.tags.length - 3}</small>` : ""}</div><div><span class="awb-status is-${esc(row.status || "unannotated")}">${stateNames[row.status] || "待标注"}</span>${row.writable === false ? '<small class="awb-readonly">只读</small>' : ""}${row.error ? `<small title="${esc(errorText(row.error))}">需重试</small>` : ""}</div></article>`).join("") || `<div class="awb-empty">${loading ? "正在读取文件…" : "当前筛选没有文件"}</div>`}<div style="height:${Math.max(0, items.length - end) * rowHeight}px" aria-hidden="true"></div></div><footer class="awb-list-footer"><span>${filteredTotal ? offset + 1 : 0}–${Math.min(offset + items.length, filteredTotal)} / ${filteredTotal}${job?.scanComplete === false ? " · 扫描中，数量仍在增加" : ""}</span><div>${button("上一页", "previous-page", "", offset === 0 || loading)}${button("下一页", "next-page", "", offset + items.length >= filteredTotal || loading)}</div></footer><div class="awb-reader-bar">${button("上一项", "previous", "", !activeId)}${button("下一项", "next", "", !activeId)}${button(previewOpen ? "收起预览" : "展开预览", "preview", "", !activeId)}</div>${previewView()}</main><aside class="awb-right" aria-label="标注编辑器"><nav class="awb-tabs" aria-label="标注工具">${[ ["edit", "标注"], ["assistant", "AI 助手"], ["schemes", "方案"] ].map(([key, label]) => `<button type="button" data-action="space-wb-tab" data-tab="${key}" aria-selected="${tab === key}" class="${tab === key ? "active" : ""}">${label}</button>`).join("")}</nav>${tab === "assistant" ? assistantPanel() : tab === "schemes" ? schemesPanel() : editPanel()}</aside></div><footer class="awb-bottom"><span>↑ ↓ 切换文件 · 空格勾选 · Shift 连选</span><span>⌘ / Ctrl + Enter 保存并下一项 · 提交前核对变更</span></footer>${planView()}</section>`;
    }
    function mounted(root = document) {
      const viewport = root.querySelector?.("[data-wb-scroll]");
      if (viewport) { if (Math.abs(viewport.scrollTop - scrollTop) > 2) viewport.scrollTop = scrollTop; }
      for (const node of root.querySelectorAll?.(".awb-top, .awb-layout, .awb-bottom") || []) node.inert = !!plan;
      if (plan && focusedPlan !== plan.planId) { focusedPlan = plan.planId; root.querySelector?.(".awb-confirm")?.focus?.(); }
      else if (!plan && pendingFocus) { root.querySelector?.(`.awb-file[data-id="${pendingFocus}"]`)?.focus?.({ preventScroll: true }); pendingFocus = ""; focusedPlan = ""; }
    }
    function onScroll(top) { if (Math.floor(top / rowHeight) === Math.floor(scrollTop / rowHeight)) { scrollTop = top; return; } scrollTop = top; emit(); }
    function retainEditor() {
      if (!visible || plan || drafts.get(activeId)?._conflict || isBusy()) return false;
      const field = document.activeElement;
      return !!field?.dataset?.wbField && !["type", "recursive", "job", "scheme", "model", "suggestion-tags", "suggestion-description", "bulk-tagMode", "bulk-descriptionMode", "bulk-inherit"].includes(field.dataset.wbField);
    }
    return { open, render, action, input, keydown, reset, active: () => visible, mounted, onScroll, retainEditor,
      composition(value) { composing = value; }, refresh: loadPage };
  };
})();
