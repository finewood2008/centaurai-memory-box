import { extname } from "node:path";

const personalSpace = "personal";
const managedBackupFolder = "半人马AI记忆备份";
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

function starlinkDocument(item) {
  const content = excerpt(item?.text, readLength);
  if (!evidenceId(item?.documentId) || !evidenceId(item?.versionId) || !content) return null;
  const metadata = annotation(item.annotation);
  return { kind: "document", documentId: item.documentId, versionId: item.versionId,
    title: excerpt(item.title, 240) || "星图资料", locator: locator(item.locator), snippet: content.slice(0, 900),
    ...(metadata && { annotation: metadata }) };
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

function annotation(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const tags = Array.isArray(value.tags) ? value.tags.filter(tag => typeof tag === "string" && tag.trim()).slice(0, 2048).map(tag => tag.slice(0, 160)) : [];
  const provenance = Array.isArray(value.provenance) ? value.provenance.filter(row =>
    row && tags.includes(row.tag) && ["manual", "automatic", "inherited"].includes(row.source) && spaceId(row.itemId)
  ).slice(0, 2048).map(({ tag, source, itemId }) => ({ tag, source, itemId })) : [];
  return { tags, description: excerpt(value.description, 2000), provenance,
    revision: Number.isSafeInteger(value.revision) && value.revision >= 0 ? value.revision : 0,
    needsReview: value.needsReview === true };
}

function annotationScore(value, terms) {
  // Review-pending metadata remains visible, but cannot create a new match.
  return value && !value.needsReview ? matchQuery([...value.tags, value.description].join("\n"), terms) * 2 : 0;
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
    if (root === "") {
      if (page.crumbs[0]?.name === managedBackupFolder) throw error(403, "此目录由记忆备份管理。");
      const items = page.parent === page.root
        ? page.items.filter(item => item.kind !== "folder" || item.name !== managedBackupFolder)
        : page.items;
      return { ...page, items, relative: page.crumbs.map(row => row.name) };
    }
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

  async function currentFile(root, file, check) {
    const page = await folderWithin(root, file.parent, check);
    const current = page.items.find(row => row.id === file.id && row.kind === "file");
    if (!current || current.version !== file.version || current.name !== file.name ||
        current.digest !== file.digest || current.size !== file.size)
      throw error(403, "文件已变化或已离开授权范围，请重新搜索。");
    return { file: current, path: [...page.relative, current.name].join("/") };
  }

  async function readText(root, file, check) {
    if (!readable(file)) return null;
    const { file: candidate } = await currentFile(root, file, check);
    if (!readable(candidate))
      throw error(403, "文件已变化或已离开授权范围，请重新搜索。");
    const value = await checked(check, () => space.preview(candidate.id, { interactive: false }));
    const { file: current, path } = await currentFile(root, file, check);
    if (value?.type !== "text/plain" || value.name !== current.name || typeof value.data !== "string" ||
        value.data.length > Math.ceil(maxTextBytes / 3) * 4) return null;
    try {
      const bytes = Buffer.from(value.data, "base64");
      if (bytes.length !== current.size || bytes.length > maxTextBytes) return null;
      const content = utf8.decode(bytes);
      return content.includes("\0") ? null : { content, path, annotation: annotation(current.annotation) };
    } catch {
      return null;
    }
  }

  async function spaceSearch(root, args, check) {
    const query = queryText(args.query, 300).toLowerCase();
    const terms = [...new Set([query, ...query.split(/[^\p{L}\p{N}_-]+/u).filter(term => term.length >= 2)])].slice(0, 9);
    const { files, truncated } = await collect(root, check);
    const candidates = files.map(file => ({ file, score: matchQuery(file.path, terms) * 2 + annotationScore(annotation(file.annotation), terms) }));
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
      if (candidate.content) candidate.score = matchQuery(candidate.content.path, terms) * 2 +
        annotationScore(candidate.content.annotation, terms) + matchQuery(candidate.content.content, terms);
      else skipped++;
    }
    check();
    const ranked = candidates.filter(row => row.score > 0).sort((a, b) => b.score - a.score);
    const matches = [];
    for (const candidate of ranked) {
      if (matches.length === searchLimit.matches) break;
      try {
        // A local annotation index is never an access grant. Revalidate even
        // non-text matches, and do not publish a label removed during the scan.
        const current = await currentFile(root, candidate.file, check);
        const metadata = annotation(current.file.annotation);
        const score = matchQuery(current.path, terms) * 2 + annotationScore(metadata, terms) +
          (candidate.content ? matchQuery(candidate.content.content, terms) : 0);
        if (score > 0) matches.push({ ...candidate, annotation: metadata, score });
      } catch (cause) {
        check();
        if (cause?.status !== 403 && cause?.status !== 404) throw cause;
      }
    }
    matches.sort((a, b) => b.score - a.score);
    return {
      matches: matches.map(({ file, content, annotation: metadata }) => ({
        fileId: file.id,
        name: file.name,
        path: content?.path ?? file.path,
        version: file.version,
        snippet: content ? snippet(content.content, terms) : "",
        ...(metadata && { annotation: metadata }),
      })),
      truncated: truncated || excerpts.length > searchLimit.textFiles || ranked.length > searchLimit.matches,
      skippedTextFiles: skipped,
      filesOutsideTextSupport: files.length - excerpts.length,
    };
  }

  async function spaceRead(root, args, check) {
    const start = args.start ?? 0;
    if (!spaceId(args.fileId) || !Number.isSafeInteger(start) || start < 0) throw error(400, "文件标识或读取位置无效。");
    const file = root === ""
      ? await checked(check, () => space.operation("stat", { id: args.fileId, space_id: personalSpace }))
      : (await collect(root, check, args.fileId)).file;
    if (!file) throw error(403, "无法在本次选定的空间目录内找到该文件。");
    if (file.id !== args.fileId || file.kind !== "file" || file.trashed ||
        (file.space_id && file.space_id !== personalSpace) ||
        (file.parent !== "" && !spaceId(file.parent))) throw error(403, "无法验证文件所属的空间目录。");
    const source = await readText(root, file, check);
    check();
    if (!source) throw error(400, "这份文件暂不支持正文读取。");
    if (start > source.content.length) throw error(400, "正文读取位置超过文件长度。");
    const end = Math.min(start + readLength, source.content.length);
    return { fileId: file.id, name: file.name, path: source.path, version: file.version, text: source.content.slice(start, end),
      nextStart: end < source.content.length ? end : null, ...(source.annotation && { annotation: source.annotation }) };
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
      // Annotation recall points to a real, versioned document. It is distinct
      // from evidence; starlink_evidence only accepts native evidence IDs.
      const documents = Array.isArray(reply.annotationDocuments) ? reply.annotationDocuments.filter(item =>
        (!item?.warehouse_id || item.warehouse_id === selectedId) && (!item?.warehouseId || item.warehouseId === selectedId)
      ).slice(0, 10).map(starlinkDocument).filter(Boolean) : [];
      return {
        matches: [...documents, ...items.slice(0, 10).filter(item => !item?.warehouse_id || item.warehouse_id === selectedId)
          .map(starlinkEvidence).filter(Boolean).map(({ text, ...metadata }) => ({ ...metadata, snippet: text.slice(0, 900) }))].slice(0, 10),
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

  async function direct(tool, args, check) {
    if (tool === "space_list") {
      const page = await folderWithin("", args.folderId ?? "", check);
      return {
        path: page.relative.join("/"),
        items: page.items.slice(0, searchLimit.entries).map(({ id, name, kind, size }) => ({ id, name, kind, size })),
        truncated: page.items.length > searchLimit.entries,
      };
    }
    if (tool === "space_search") return spaceSearch("", args, check);
    if (tool === "space_read") return spaceRead("", args, check);
    const available = await warehouses(check);
    if (tool === "starlink_warehouses") return { warehouses: available };
    if (!available.some(row => row.id === args.warehouseId)) throw error(400, "无法访问所选星图仓库。");
    return call({ warehouseId: args.warehouseId }, tool, args, check);
  }

  return { catalog, validate, call, direct };
}
