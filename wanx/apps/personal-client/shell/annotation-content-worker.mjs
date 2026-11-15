import { parentPort, workerData } from "node:worker_threads";
import path from "node:path";
import JSZip from "jszip";

const { format, bytes, limits } = workerData;
const utf8 = new TextDecoder("utf-8", { fatal: true });
const fail = code => Object.assign(new Error(code), { code });
const output = (mode, content = "", reason, truncated = false) => ({ mode, content, format, truncated, ...(reason ? { reason } : {}) });
const normalize = text => text.replace(/\r\n?/g, "\n").replace(/[\t ]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
const cut = (content, partial = false) => {
  content = normalize(content);
  let bounded = content.slice(0, limits.textCharacters);
  if (/[\uD800-\uDBFF]$/.test(bounded)) bounded = bounded.slice(0, -1);
  return content ? output("content", bounded, undefined, partial || content.length > limits.textCharacters)
    : output("name-only", "", "SPACE_ANNOTATION_CONTENT_EMPTY", partial);
};
const decode = value => {
  let text;
  try { text = utf8.decode(value).replace(/^\uFEFF/, ""); }
  catch { throw fail("SPACE_ANNOTATION_CONTENT_INVALID_UTF8"); }
  if (text.includes("\0")) throw fail("SPACE_ANNOTATION_CONTENT_BINARY");
  return text;
};
function entities(value) {
  return value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (all, entity) => {
    if (entity[0] !== "#") return ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " })[entity.toLowerCase()];
    const code = entity[1].toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : "";
  });
}
function safeXML(xml) {
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(xml)) throw fail("SPACE_ANNOTATION_XML_UNSAFE");
  return xml;
}
function markupText(xml, html = false) {
  if (html) {
    if (/<!\s*ENTITY\b/i.test(xml)) throw fail("SPACE_ANNOTATION_XML_UNSAFE");
    xml = xml.replace(/<!doctype\b[^>]*>/gi, "");
  } else safeXML(xml);
  return entities(xml.replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(?:[\w.-]+:)?(?:script|style)\b[^>]*>[\s\S]*?<\/(?:[\w.-]+:)?(?:script|style)\s*>/gi, " ")
    .replace(html ? /<\/?(?:p|br|div|li|tr|h[1-6]|section|article)\b[^>]*>/gi : /<\/?(?:[\w.-]+:)?(?:p|br|div|li|tr)\b[^>]*>/gi, "\n")
    .replace(/<[^>]*>/g, " "));
}
function xmlRuns(xml) {
  safeXML(xml);
  const runs = [];
  for (const match of xml.matchAll(/<(?:[\w.-]+:)?t\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?t\s*>|<(?:[\w.-]+:)?(?:tab)\b[^>]*\/>|<(?:[\w.-]+:)?(?:br)\b[^>]*\/>|<\/(?:[\w.-]+:)?(?:p|tr)\s*>/g)) {
    if (match[1] !== undefined) runs.push(entities(match[1].replace(/<[^>]*>/g, "")));
    else runs.push(/tab\b/.test(match[0]) ? "\t" : "\n");
  }
  return runs.join("");
}
function attributes(value) {
  return Object.fromEntries([...value.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)].map(match => [match[1], entities(match[2] ?? match[3])]));
}
function validZipName(name) {
  return name && !/[\\\0]/.test(name) && !name.startsWith("/") && !/^[A-Za-z]:/.test(name) && !name.split("/").some(part => part === ".." || part === ".");
}
function zipInventory(data) {
  // Check the central directory before JSZip constructs a file collection.
  // Both declared expansion and the actual selected-entry streams are bounded.
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let end = -1;
  for (let i = data.byteLength - 22; i >= Math.max(0, data.byteLength - 65_557); i--) {
    if (view.getUint32(i, true) === 0x06054b50 && i + 22 + view.getUint16(i + 20, true) === data.byteLength) { end = i; break; }
  }
  if (end < 0) throw fail("SPACE_ANNOTATION_ARCHIVE_INVALID");
  const count = view.getUint16(end + 10, true), centralSize = view.getUint32(end + 12, true), centralStart = view.getUint32(end + 16, true);
  if (view.getUint16(end + 4, true) || view.getUint16(end + 6, true) || view.getUint16(end + 8, true) !== count ||
    count === 0xffff || centralStart === 0xffffffff || centralSize === 0xffffffff || count > limits.zipEntries || centralStart + centralSize > end)
    throw fail("SPACE_ANNOTATION_ARCHIVE_LIMIT");
  let cursor = centralStart, total = 0;
  const names = new Set();
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > centralStart + centralSize || view.getUint32(cursor, true) !== 0x02014b50) throw fail("SPACE_ANNOTATION_ARCHIVE_INVALID");
    const flags = view.getUint16(cursor + 8, true), size = view.getUint32(cursor + 24, true);
    if (flags & 1) throw fail("SPACE_ANNOTATION_CONTENT_ENCRYPTED");
    const nameLength = view.getUint16(cursor + 28, true), extra = view.getUint16(cursor + 30, true), comment = view.getUint16(cursor + 32, true);
    const next = cursor + 46 + nameLength + extra + comment;
    if (next > centralStart + centralSize || !nameLength) throw fail("SPACE_ANNOTATION_ARCHIVE_INVALID");
    const name = decode(data.subarray(cursor + 46, cursor + 46 + nameLength));
    if (!validZipName(name) || names.has(name)) throw fail("SPACE_ANNOTATION_ARCHIVE_PATH_INVALID");
    names.add(name); total += size;
    if (size === 0xffffffff || total > limits.expandedBytes) throw fail("SPACE_ANNOTATION_ARCHIVE_LIMIT");
    cursor = next;
  }
  if (cursor !== centralStart + centralSize) throw fail("SPACE_ANNOTATION_ARCHIVE_INVALID");
  return names;
}
async function office(data) {
  const names = zipInventory(data);
  const zip = await JSZip.loadAsync(data, { checkCRC32: false, createFolders: false });
  for (const file of Object.values(zip.files)) {
    if (!validZipName(file.unsafeOriginalName || file.name)) throw fail("SPACE_ANNOTATION_ARCHIVE_PATH_INVALID");
  }
  let expanded = 0;
  async function read(name) {
    const file = zip.file(name);
    if (!file || !names.has(name)) throw fail("SPACE_ANNOTATION_ARCHIVE_INVALID");
    const chunks = []; let size = 0;
    const stream = file.nodeStream("nodebuffer");
    try {
      await new Promise((resolve, reject) => {
        let settled = false;
        stream.on("data", chunk => {
          if (settled) return;
          size += chunk.length; expanded += chunk.length;
          if (size > 16 * 1024 * 1024 || expanded > limits.expandedBytes) {
            settled = true; stream.pause(); stream.destroy(); reject(fail("SPACE_ANNOTATION_ARCHIVE_LIMIT"));
          } else chunks.push(chunk);
        });
        stream.once("error", error => { if (!settled) { settled = true; reject(error); } });
        stream.once("end", () => { if (!settled) { settled = true; resolve(); } });
      });
      return safeXML(decode(Buffer.concat(chunks)));
    } finally { stream.destroy(); }
  }
  if (format === "docx") return cut(xmlRuns(await read("word/document.xml")));
  if (format === "pptx") {
    let slides = [...names].filter(name => /^ppt\/slides\/slide\d+\.xml$/.test(name)).sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
    if (names.has("ppt/presentation.xml") && names.has("ppt/_rels/presentation.xml.rels")) {
      const relations = new Map();
      for (const match of (await read("ppt/_rels/presentation.xml.rels")).matchAll(/<(?:[\w.-]+:)?Relationship\b([^>]*?)\/?\s*>/g)) {
        const attrs = attributes(match[1]);
        if (attrs.TargetMode === "External" || !attrs.Target) continue;
        const target = attrs.Target.startsWith("/") ? attrs.Target.slice(1) : path.posix.normalize(path.posix.join("ppt", attrs.Target));
        if (slides.includes(target)) relations.set(attrs.Id, target);
      }
      slides = [...(await read("ppt/presentation.xml")).matchAll(/<(?:[\w.-]+:)?sldId\b([^>]*?)\/?\s*>/g)]
        .map(match => relations.get(attributes(match[1])["r:id"])).filter(Boolean);
    }
    if (!slides.length) throw fail("SPACE_ANNOTATION_ARCHIVE_INVALID");
    const sections = []; let length = 0, truncated = false;
    for (const [index, name] of slides.entries()) {
      const text = normalize(xmlRuns(await read(name)));
      if (text) { const section = `幻灯片 ${index + 1}\n${text}`; sections.push(section); length += section.length; }
      if (length > limits.textCharacters) { truncated = true; break; }
    }
    return cut(sections.join("\n\n"), truncated);
  }
  const shared = [];
  if (names.has("xl/sharedStrings.xml")) for (const match of (await read("xl/sharedStrings.xml")).matchAll(/<(?:[\w.-]+:)?si\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?si\s*>/g)) shared.push(xmlRuns(match[1]));
  const workbook = await read("xl/workbook.xml");
  const relations = new Map();
  if (names.has("xl/_rels/workbook.xml.rels")) {
    for (const match of (await read("xl/_rels/workbook.xml.rels")).matchAll(/<(?:[\w.-]+:)?Relationship\b([^>]*?)\/?\s*>/g)) {
      const attrs = attributes(match[1]);
      if (attrs.TargetMode === "External" || !attrs.Target) continue;
      const target = attrs.Target.startsWith("/") ? attrs.Target.slice(1) : path.posix.normalize(path.posix.join("xl", attrs.Target));
      if (/^xl\/worksheets\/[^/]+\.xml$/.test(target) && names.has(target)) relations.set(attrs.Id, target);
    }
  }
  const sheets = [...workbook.matchAll(/<(?:[\w.-]+:)?sheet\b([^>]*?)\/?\s*>/g)].map(match => attributes(match[1]));
  const sections = []; let length = 0, truncated = false;
  for (const sheet of sheets) {
    const target = relations.get(sheet["r:id"]) || `xl/worksheets/sheet${sheet.sheetId}.xml`;
    if (!names.has(target)) continue;
    const xml = await read(target), rows = [];
    for (const match of xml.matchAll(/<(?:[\w.-]+:)?row\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?row\s*>/g)) {
      const cells = [];
      for (const cell of match[1].matchAll(/<(?:[\w.-]+:)?c\b([^>]*?)>([\s\S]*?)<\/(?:[\w.-]+:)?c\s*>/g)) {
        const attrs = attributes(cell[1]), cached = cell[2].match(/<(?:[\w.-]+:)?v\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?v\s*>/);
        let value = attrs.t === "inlineStr" ? xmlRuns(cell[2]) : cached ? entities(cached[1]) : "";
        if (attrs.t === "s") value = /^\d+$/.test(value) ? shared[Number(value)] || "" : "";
        if (value) cells.push(`${attrs.r ? attrs.r + ": " : ""}${value}`);
      }
      if (cells.length) { const row = cells.join("\t"); rows.push(row); length += row.length; }
      if (length > limits.textCharacters) { truncated = true; break; }
    }
    if (rows.length) sections.push(`${sheet.name || "工作表"}\n${rows.join("\n")}`);
    if (truncated) break;
  }
  return cut(sections.join("\n\n"), truncated);
}
async function pdf(data) {
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loading = getDocument({ data, isEvalSupported: false, useSystemFonts: false, disableFontFace: true,
    useWorkerFetch: false, disableAutoFetch: true, disableStream: true, disableRange: true, verbosity: 0 });
  let document;
  try {
    document = await loading.promise;
    const pages = []; let length = 0, lastPage = 0;
    for (let number = 1; number <= Math.min(document.numPages, 200); number++) {
      const page = await document.getPage(number);
      const text = await page.getTextContent();
      const content = text.items.map(item => typeof item.str === "string" ? item.str + (item.hasEOL ? "\n" : " ") : "").join("");
      if (content.trim()) { pages.push(content); length += content.length; }
      lastPage = number; page.cleanup();
      if (length > limits.textCharacters) break;
    }
    const truncated = lastPage < document.numPages;
    const result = cut(pages.join("\n\n"), truncated);
    if (result.mode !== "content") result.reason = truncated ? "SPACE_ANNOTATION_EXTRACTION_BUDGET" : "SPACE_ANNOTATION_PDF_NO_TEXT";
    return result;
  } finally { if (document) await document.destroy(); else await loading.destroy(); }
}

try {
  let result;
  if (format === "pdf") result = await pdf(bytes);
  else if (["docx", "xlsx", "pptx"].includes(format)) result = await office(bytes);
  else {
    const text = decode(bytes);
    result = cut(["html", "htm", "xml"].includes(format) ? markupText(text, format !== "xml") : text);
  }
  parentPort.postMessage(result);
} catch (error) {
  const reason = error?.name === "PasswordException" ? "SPACE_ANNOTATION_CONTENT_ENCRYPTED"
    : /^SPACE_ANNOTATION_[A-Z0-9_]+$/.test(error?.code || "") ? error.code : "SPACE_ANNOTATION_EXTRACTION_FAILED";
  parentPort.postMessage(output("unsupported", "", reason));
}
