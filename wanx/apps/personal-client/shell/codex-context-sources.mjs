import { extname } from "node:path";

const personalSpace = "personal";
const textTypes = new Set([".txt", ".md", ".csv", ".json", ".log"]);
const searchLimit = { folders: 64, entries: 1200, depth: 12, textFiles: 32, matches: 10 };
const maxTextBytes = 128 * 1024;
const readLength = 12000;
const utf8 = new TextDecoder("utf-8", { fatal: true });

const spaceId = value => typeof value === "string" && /^[a-f0-9]{32}$/.test(value);
const warehouseId = value => typeof value === "string" && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value);
const evidenceId = value => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const name = value => typeof value === "string" && value.length > 0 && value.length <= 240;
const excerpt = (value, max) => typeof value === "string" ? value.trim().slice(0, max) : "";
const error = (status, message) => Object.assign(new Error(message), { status });

async function checked(check, operation) {
  check();
  try {
    return await operation();
  } finally {
    check();
  }
}

function queryText(value, maximum) {
  const query = typeof value === "string" ? value.trim() : "";
  if (!query || query.length > maximum || query.includes("\0")) throw error(400, "请输入有效的搜索词。");
  return query;
}

function locator(value) {
  return excerpt(typeof value === "object" && value !== null ? JSON.stringify(value) : value, 500);
}

function starlinkEvidence(item) {
  const id = item?.evidence_id ?? item?.id;
  const content = excerpt(item?.text || item?.excerpt || item?.content, readLength);
  if (!evidenceId(id) || !content) return null;
  return {
    evidenceId: id,
    title: excerpt(item.document_name || item.original_name || item.document?.original_name || item.title, 240) || "星图资料",
    documentId: evidenceId(item.document_id) ? item.document_id : undefined,
    versionId: evidenceId(item.document_version_id || item.version_id) ? (item.document_version_id || item.version_id) : undefined,
    locator: locator(item.source_locator || item.locator_json || item.locator),
    text: content,
  };
}

function matchQuery(value, terms) {
  const normalized = value.toLowerCase();
  return terms.reduce((score, term, index) => score + (normalized.includes(term) ? index === 0 ? 3 : 1 : 0), 0);
}

function snippet(value, terms) {
  const normalized = value.toLowerCase();
  const hit = terms.map(term => normalized.indexOf(term)).find(index => index >= 0);
  return value.slice(Math.max(0, (hit ?? 0) - 90), (hit ?? 0) + 230);
}

export function createCodexContextSources({ space, starlink }) {
  async function listing(parent, check) {
    if (parent !== "" && !spaceId(parent)) throw error(400, "空间目录标识无效。");
    const page = await checked(check, () => space.operation("list", { parent, space_id: personalSpace }));
    // Some boxes use an empty string to identify the personal root. A task still needs a real folder ID.
    if (page?.space_id !== personalSpace || (page.root !== "" && !spaceId(page.root)) || page.parent !== (parent || page.root) ||
        !Array.isArray(page.items) || !Array.isArray(page.breadcrumbs)) throw error(403, "无法读取所选空间目录。");
    const crumbs = page.breadcrumbs;
    if (!crumbs.every(row => spaceId(row?.id) && row.id !== page.root && name(row.name)) ||
        new Set(crumbs.map(row => row.id)).size !== crumbs.length ||
        (crumbs.at(-1)?.id ?? page.root) !== page.parent) throw error(403, "无法验证空间目录的位置。");
    return {
      root: page.root,
      parent: page.parent,
      crumbs,
      items: page.items.filter(row => spaceId(row?.id) && row.parent === page.parent &&
        row.id !== page.root && name(row.name) && !row.trashed &&
        (!row.space_id || row.space_id === personalSpace) && ["folder", "file"].includes(row.kind)),
    };
  }

  async function warehouses(check) {
    const reply = await checked(check, () => starlink("warehouses"));
    if (!Array.isArray(reply?.items)) throw error(503, "星图仓库暂不可用。");
    return reply.items.filter(item => warehouseId(item?.id) && item.state === "active")
      .map(item => ({ id: item.id, name: excerpt(item.name, 160) || "星图仓库" }));
  }

  async function catalog(parent = "", check, kind) {
    const [page, available] = await Promise.all([
      kind !== "starlink" ? listing(parent, check) : undefined,
      kind !== "space" ? warehouses(check) : undefined,
    ]);
    check();
    return {
      ...(page && {
        folders: page.items.filter(row => row.kind === "folder").map(row => ({ id: row.id, name: row.name })),
        parent: page.crumbs.at(-2)?.id ?? "",
        folder: { id: page.parent, name: page.crumbs.at(-1)?.name ?? "个人空间" },
      }),
      ...(available && { warehouses: available }),
    };
  }

  async function validate(folderId, selectedWarehouseId, check) {
    const hasFolder = folderId != null;
    const hasWarehouse = selectedWarehouseId != null;
    if ((!hasFolder && !hasWarehouse) || (hasFolder && !spaceId(folderId)) || (hasWarehouse && !warehouseId(selectedWarehouseId)))
      throw error(400, "请选择有效的空间文件夹或星图仓库。");
    const [page, available] = await Promise.all([
      hasFolder ? listing(folderId, check) : undefined,
      hasWarehouse ? warehouses(check) : undefined,
    ]);
    check();
    if (page && page.parent === page.root) throw error(400, "请选择个人空间中的一个具体文件夹。");
    const warehouse = available?.find(row => row.id === selectedWarehouseId);
    if (hasWarehouse && !warehouse) throw error(403, "无法访问所选星图仓库。");
    return {
      ...(page && { folderId, folderName: page.crumbs.at(-1).name }),
      ...(warehouse && { warehouseId: warehouse.id, warehouseName: warehouse.name }),
    };
  }

  async function folderWithin(root, folderId, check) {
    const page = await listing(folderId, check);
    const location = page.crumbs.findIndex(row => row.id === root);
    if (location < 0) throw error(403, "目标不在本次选定的空间目录内。");
    return { ...page, relative: page.crumbs.slice(location + 1).map(row => row.name) };
  }

  async function collect(root, check, target) {
    const queue = [{ id: root, depth: 0 }];
    const visited = new Set([root]);
    const files = [];
    let entries = 0;
    let truncated = false;
    for (let index = 0; index < queue.length; index++) {
      const { id, depth } = queue[index];
      const folder = await folderWithin(root, id, check);
      for (const item of folder.items) {
        if (entries === searchLimit.entries) return { files, truncated: true };
        entries++;
        if (item.kind === "folder") {
          if (visited.has(item.id)) continue;
          if (depth >= searchLimit.depth || queue.length >= searchLimit.folders) {
            truncated = true;
            continue;
          }
          visited.add(item.id);
          queue.push({ id: item.id, depth: depth + 1 });
        } else {
          const file = { ...item, path: [...folder.relative, item.name].join("/") };
          if (file.id === target) return { file };
          files.push(file);
        }
      }
    }
    return { files, truncated };
  }

  function readable(file) {
    return textTypes.has(extname(file.name).toLowerCase()) &&
      Number.isSafeInteger(file.size) && file.size >= 0 && file.size <= maxTextBytes;
  }

  async function readText(root, file, check) {
    if (!readable(file)) return null;
    const before = await folderWithin(root, file.parent, check);
    const candidate = before.items.find(row => row.id === file.id && row.kind === "file");
    if (!candidate || candidate.version !== file.version || candidate.name !== file.name || !readable(candidate))
      throw error(403, "文件已变化或已离开授权范围，请重新搜索。");
    const value = await checked(check, () => space.preview(candidate.id, { interactive: false }));
    const after = await folderWithin(root, candidate.parent, check);
    const current = after.items.find(row => row.id === candidate.id && row.kind === "file");
    if (!current || current.version !== candidate.version || current.name !== candidate.name)
      throw error(403, "文件已变化或已离开授权范围，请重新搜索。");
    if (value?.type !== "text/plain" || value.name !== current.name || typeof value.data !== "string" ||
        value.data.length > Math.ceil(maxTextBytes / 3) * 4) return null;
    try {
      const bytes = Buffer.from(value.data, "base64");
      if (bytes.length !== current.size || bytes.length > maxTextBytes) return null;
      const content = utf8.decode(bytes);
      return content.includes("\0") ? null : { content, path: [...after.relative, current.name].join("/") };
    } catch {
      return null;
    }
  }

  async function spaceSearch(root, args, check) {
    const query = queryText(args.query, 300).toLowerCase();
    const terms = [...new Set([query, ...query.split(/[^\p{L}\p{N}_-]+/u).filter(term => term.length >= 2)])].slice(0, 9);
    const { files, truncated } = await collect(root, check);
    const candidates = files.map(file => ({ file, score: matchQuery(file.path, terms) * 2 }));
    candidates.sort((a, b) => b.score - a.score);
    const excerpts = candidates.filter(({ file }) => readable(file));
    let skipped = 0;
    for (const candidate of excerpts.slice(0, searchLimit.textFiles)) {
      try {
        candidate.content = await readText(root, candidate.file, check);
      } catch (cause) {
        check();
        if (cause?.status === 403 || cause?.status === 404) candidate.score = 0;
        skipped++;
        continue;
      }
      if (candidate.content) candidate.score += matchQuery(candidate.content.content, terms);
      else skipped++;
    }
    check();
    const matches = candidates.filter(row => row.score > 0).sort((a, b) => b.score - a.score);
    return {
      matches: matches.slice(0, searchLimit.matches).map(({ file, content }) => ({
        fileId: file.id,
        name: file.name,
        path: content?.path ?? file.path,
        version: file.version,
        snippet: content ? snippet(content.content, terms) : "",
      })),
      truncated: truncated || excerpts.length > searchLimit.textFiles || matches.length > searchLimit.matches,
      skippedTextFiles: skipped,
      filesOutsideTextSupport: files.length - excerpts.length,
    };
  }

  async function spaceRead(root, args, check) {
    const start = args.start ?? 0;
    if (!spaceId(args.fileId) || !Number.isSafeInteger(start) || start < 0) throw error(400, "文件标识或读取位置无效。");
    const { file } = await collect(root, check, args.fileId);
    if (!file) throw error(403, "无法在本次选定的空间目录内找到该文件。");
    const source = await readText(root, file, check);
    check();
    if (!source) throw error(400, "这份文件暂不支持正文读取。");
    if (start > source.content.length) throw error(400, "正文读取位置超过文件长度。");
    const end = Math.min(start + readLength, source.content.length);
    return { fileId: file.id, name: file.name, path: source.path, version: file.version, text: source.content.slice(start, end),
      nextStart: end < source.content.length ? end : null };
  }

  async function call(selection, tool, args = {}, check) {
    check();
    if (tool === "space_search" || tool === "space_read") {
      const root = selection.folderId;
      if (!spaceId(root)) throw error(403, "本次任务没有空间文件夹权限。");
      return tool === "space_search" ? spaceSearch(root, args, check) : spaceRead(root, args, check);
    }
    const selectedId = selection.warehouseId;
    if (!warehouseId(selectedId)) throw error(403, "本次任务没有星图仓库权限。");
    if (tool === "starlink_search") {
      const query = queryText(args.query, 2000);
      const reply = await checked(check, () => starlink("search", { warehouseId: selectedId, query }));
      const items = reply?.items ?? reply?.results;
      if (!Array.isArray(items)) throw error(503, "星图未返回有效检索结果。");
      return {
        matches: items.slice(0, 10).filter(item => !item?.warehouse_id || item.warehouse_id === selectedId)
          .map(starlinkEvidence).filter(Boolean).map(({ text, ...metadata }) => ({ ...metadata, snippet: text.slice(0, 900) })),
      };
    }
    if (tool === "starlink_evidence") {
      if (!evidenceId(args.evidenceId)) throw error(400, "星图证据标识无效。");
      const reply = await checked(check, () => starlink("evidence", { warehouseId: selectedId, id: args.evidenceId }));
      const item = reply?.evidence ?? reply;
      const evidence = starlinkEvidence(item);
      if (!evidence || evidence.evidenceId !== args.evidenceId ||
          (item.warehouse_id && item.warehouse_id !== selectedId)) throw error(403, "无法在本次选定的星图仓库内读取证据。");
      return evidence;
    }
    throw error(400, "不支持此资料工具。");
  }

  return { catalog, validate, call };
}
