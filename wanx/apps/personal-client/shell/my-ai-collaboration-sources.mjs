import { createHash } from "node:crypto";

const sourceNames = { space: "个人空间", starlink: "星图", memory: "历史记忆" };
const validId = value => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const rangeLength = 900;
const segmenter = new Intl.Segmenter("zh", { granularity: "word" });
const termsFor = text => [...new Set([...segmenter.segment(text.slice(0, 300).toLowerCase())]
  .filter(part => part.isWordLike && part.segment.length >= 2 && part.segment.length <= 40)
  .map(part => part.segment))].slice(0, 8);
const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");

function excerpt(text, terms, offset) {
  if (typeof text !== "string" || !text.trim()) return null;
  const normalized = text.toLowerCase();
  const hit = terms.map(term => normalized.indexOf(term)).find(index => index >= 0);
  const start = offset ?? Math.max(0, (hit ?? 0) - 90);
  return { start, text: text.slice(start, start + rangeLength).trim().toWellFormed() };
}

function candidate(kind, title, locator, content) {
  if (!content?.text) return null;
  return { kind, title: String(title || sourceNames[kind]).slice(0, 240).toWellFormed(),
    locator: { ...locator, offset: content.start }, text: content.text };
}

export function createCollaborationSources({ sources, memory, starlink }) {
  const scopeFor = (selection, check) => selection.folderId || selection.warehouseId
    ? sources.validate(selection.folderId, selection.warehouseId, check) : {};
  async function starlinkDetail(warehouseId, id, check) {
    check();
    const detail = await starlink("document", { warehouseId, id });
    check();
    if (detail?.document?.id !== id || !validId(detail?.version?.id) ||
        (detail.document.warehouse_id && detail.document.warehouse_id !== warehouseId) || !Array.isArray(detail.segments))
      throw Error("星图资料不可读。");
    return detail;
  }

  async function spaceCandidates(scope, query, terms, check) {
    const { matches } = await sources.call(scope, "space_search", { query, keywords: terms }, check);
    return (await Promise.all(matches.filter(row => row.snippet).slice(0, 3).map(async row => {
      const file = await sources.call(scope, "space_read", { fileId: row.fileId }, check);
      return file.version === row.version && file.version != null
        ? candidate("space", file.name, { ref: row.fileId, version: file.version, label: file.path }, excerpt(file.text, terms))
        : null;
    }))).filter(Boolean);
  }

  async function starlinkCandidates(warehouseId, terms, check) {
    check();
    // Read the existing document index and parsed segments. Semantic search can
    // invoke a configured embedding model, so keep it out of consent preview.
    const { items } = await starlink("documents", { warehouseId });
    check();
    if (!Array.isArray(items)) throw Error("星图资料暂不可读。");
    const score = value => terms.filter(term => String(value ?? "").toLowerCase().includes(term)).length;
    const documents = items.filter(row => validId(row?.id) && (!row.warehouse_id || row.warehouse_id === warehouseId))
      .sort((a, b) => score(b.title ?? b.original_name) - score(a.title ?? a.original_name)).slice(0, 8);
    const found = [];
    for (const row of documents) {
      try {
        const detail = await starlinkDetail(warehouseId, row.id, check);
        detail.segments.forEach((segment, index) => {
          if (!validId(segment?.id) || typeof segment.text !== "string") return;
          const relevance = score(segment.text) * 2 + score(row.title ?? row.original_name);
          if (relevance) found.push({ relevance, item: candidate("starlink", row.title ?? row.original_name ?? detail.document.original_name,
            { ref: row.id, version: detail.version.id, segmentId: segment.id, label: "正文第 " + (index + 1) + " 段" }, excerpt(segment.text, terms)) });
        });
      } catch { check(); }
    }
    return found.filter(row => row.item).sort((a, b) => b.relevance - a.relevance).slice(0, 3).map(row => row.item);
  }

  async function memoryCandidates(memoryAgent, query, terms, check) {
    const catalog = await memory.sourceCatalog(check);
    if (!catalog.some(source => source.id === memoryAgent)) throw Error("该历史记忆来源不可读。");
    const { matches } = await memory.searchSource(query, memoryAgent, check);
    return (await Promise.all(matches.slice(0, 3).map(async row => {
      const item = await memory.call("memory_read", { memoryId: row.memoryId }, check, undefined, "", memoryAgent);
      return candidate("memory", item.title, { ref: item.memoryId, version: digest(item.body), label: "历史记忆原文" },
        excerpt(item.body, terms));
    }))).filter(Boolean);
  }

  return {
    async catalog(kind, parent, check) {
      if (kind === "memory") return { agents: await memory.sourceCatalog(check) };
      if (kind !== "space" && kind !== "starlink") throw Object.assign(Error("资料类型无效。"), { status: 400 });
      return sources.catalog(parent, check, kind);
    },
    async collect(selection, task, check) {
      const query = task.slice(0, 300).trim();
      const terms = termsFor(query);
      const folders = selection.folderId && (async () => {
        const scope = await scopeFor({ folderId: selection.folderId }, check);
        return spaceCandidates(scope, query, terms, check);
      })();
      const warehouses = selection.warehouseId && (async () => {
        const scope = await scopeFor({ warehouseId: selection.warehouseId }, check);
        return starlinkCandidates(scope.warehouseId, terms, check);
      })();
      const groups = { space: folders, starlink: warehouses,
        memory: selection.memoryAgent && memoryCandidates(selection.memoryAgent, query, terms, check) };
      const present = Object.entries(groups).filter(([, promise]) => promise);
      const results = await Promise.allSettled(present.map(([, promise]) => promise));
      check();
      const evidence = [];
      const notices = [];
      results.forEach((result, index) => {
        const label = sourceNames[present[index][0]];
        if (result.status === "rejected") notices.push(label + "暂无法读取。");
        else if (!result.value.length) notices.push(label + "未找到匹配的可引用文本。");
        else evidence.push(...result.value);
      });
      return { evidence: evidence.map((item, index) => ({ ...item, id: "E" + (index + 1) })), notices };
    },
    async verify(selection, evidence, check) {
      check();
      const { kind, locator } = evidence;
      const scope = await scopeFor({
        ...(kind === "space" && { folderId: selection.folderId }),
        ...(kind === "starlink" && { warehouseId: selection.warehouseId }),
      }, check);
      let current;
      if (kind === "space") {
        const file = await sources.call(scope, "space_read", { fileId: locator.ref }, check);
        if (file.version === locator.version) current = excerpt(file.text, [], locator.offset);
      } else if (kind === "starlink") {
        const detail = await starlinkDetail(scope.warehouseId, locator.ref, check);
        if (detail.version.id === locator.version)
          current = excerpt(detail.segments.find(segment => segment.id === locator.segmentId)?.text, [], locator.offset);
      } else if (kind === "memory") {
        const item = await memory.call("memory_read", { memoryId: locator.ref }, check, undefined, "", selection.memoryAgent);
        if (digest(item.body) === locator.version) current = excerpt(item.body, [], locator.offset);
      }
      check();
      return current?.text === evidence.text;
    },
  };
}
