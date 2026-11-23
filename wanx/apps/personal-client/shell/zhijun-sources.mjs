const segmenter = new Intl.Segmenter("zh", { granularity: "word" });
const fillers = new Set(["你好", "知君", "帮我", "一下", "什么", "哪里", "有没有", "请问", "看看", "我们", "之前"]);

function excerpts(source, items, titleOf, locate = () => ({})) {
  return items.filter(item => item?.snippet?.trim()).slice(0, 3).map(item => ({
    source,
    title: (titleOf(item)?.trim() || "相关资料").slice(0, 180).toWellFormed(),
    text: item.snippet.trim().slice(0, 650).toWellFormed(),
    ...locate(item),
  }));
}

export function createZhijunSourceReader({ sources, memory, interaction }) {
  return async (query, assertScope, selected) => {
    query = query.trim().slice(0, 300);
    const session = interaction();
    if (!session || !query) return { references: [], check: assertScope };
    const check = () => {
      assertScope();
      if (interaction() !== session)
        throw Object.assign(new Error("DIALOGUE_CONTEXT_CHANGED"), { code: "DIALOGUE_CONTEXT_CHANGED" });
    };
    const timeout = AbortSignal.timeout(6500);
    const checkRead = () => { check(); timeout.throwIfAborted(); };
    const deadline = new Promise(resolve => timeout.addEventListener("abort", () => resolve([]), { once: true }));
    const read = fn => Promise.race([Promise.resolve().then(fn).catch(() => []), deadline]);
    const [space, starlink, history] = await Promise.all([
      selected.space ? read(async () => {
        const keywords = [...segmenter.segment(query)].filter(part => part.isWordLike &&
          part.segment.length >= 2 && !fillers.has(part.segment)).map(part => part.segment);
        const { matches } = selected.folderId
          ? await sources.call({ folderId: selected.folderId }, "space_search", { query, keywords }, checkRead)
          : await sources.direct("space_search", { query, keywords }, checkRead);
        return excerpts("space", matches.map(item => ({ ...item,
          readable: Boolean(item.snippet?.trim()),
          snippet: item.snippet || item.annotation?.description || "已找到此文件，未读取正文。",
        })), item => item.path || item.name, item => item.readable ? { file_id: item.fileId } : {});
      }) : [],
      selected.starlink ? read(async () => {
        const { warehouses } = await sources.direct("starlink_warehouses", {}, checkRead);
        const ranked = warehouses.filter(row => !selected.warehouseId || row.id === selected.warehouseId)
          .sort((a, b) => Number(query.includes(b.name)) - Number(query.includes(a.name)));
        const hits = [];
        for (let i = 0; i < ranked.length && hits.length < 3; i += 4) {
          checkRead();
          const batch = await Promise.allSettled(ranked.slice(i, i + 4).map(async warehouse => {
            const { matches } = await sources.call({ warehouseId: warehouse.id }, "starlink_search", { query }, checkRead);
            return excerpts(
              "starlink", matches,
              item => [warehouse.name, item.title, item.locator].filter(Boolean).join(" · "),
              item => item.evidenceId ? { warehouse_id: warehouse.id, evidence_id: item.evidenceId } : {},
            );
          }));
          for (const result of batch) if (result.status === "fulfilled") hits.push(...result.value);
        }
        return hits.slice(0, 3);
      }) : [],
      selected.memory && selected.memoryAgent !== "zhijun" ? read(async () => {
        const { matches } = await memory(query, checkRead, selected.memoryAgent);
        return excerpts("memmy", matches, item => item.title);
      }) : [],
    ]);
    check();
    return { references: [...space, ...starlink, ...history], check };
  };
}

export async function openZhijunSource(sources, reference, check) {
  if (reference.source === "space")
    return sources.direct("space_read", { fileId: reference.file_id }, check);
  if (reference.source === "starlink")
    return sources.direct("starlink_evidence", {
      warehouseId: reference.warehouse_id, evidenceId: reference.evidence_id,
    }, check);
  throw Object.assign(new Error("DIALOGUE_ACCESS_DENIED"), { code: "DIALOGUE_ACCESS_DENIED" });
}
