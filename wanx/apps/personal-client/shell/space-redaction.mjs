import { extname } from "node:path";
import { ANNOTATION_CONTENT_LIMITS, extractAnnotationContent } from "./annotation-content.mjs";
import { validUploadName } from "./space-upload-imports.mjs";

const mark = "****";
const maxTextBytes = 4 * 1024 * 1024;
const simpleFormats = new Set(["txt", "md", "csv", "tsv", "json", "log"]);
const extractedFormats = new Set(["pdf", "docx", "xlsx", "pptx"]);
const plainOutputFormats = new Set(["csv", "tsv", "json", ...extractedFormats]);
const builtinRules = [
  {
    id: "email", label: "电子邮箱",
    pattern: /(?<![A-Z0-9.!#$%&'*+/=?^_`{|}~-])[A-Z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Z0-9][A-Z0-9.-]{0,251}\.[A-Z]{2,63}(?![A-Z0-9-]|\.[A-Z0-9-])/gi,
  },
  { id: "phone", label: "中国大陆手机号", pattern: /(?<!\d)(?:(?:\+|00)?86[ \t-]?)?1[3-9]\d[ \t-]?\d{4}[ \t-]?\d{4}(?!\d)/g },
  { id: "id-card", label: "中国大陆身份证号", pattern: /(?<!\d)[1-9]\d{16}[\dXx](?!\d)/g },
];

const fail = code => Object.assign(new Error(code), { code });
const invalidRules = () => fail("SPACE_REDACTION_RULES_INVALID");

export function defaultRedactionRules() {
  return { builtins: builtinRules.map(({ id, label }) => ({ id, label, enabled: true })), customRules: [] };
}

export function normalizeRedactionRules(input) {
  if (!Array.isArray(input?.builtins) || input.builtins.length !== builtinRules.length ||
      !Array.isArray(input?.customRules) || input.customRules.length > 30) throw invalidRules();
  const builtins = builtinRules.map(({ id, label }) => {
    const rule = input.builtins.find(item => item?.id === id);
    if (typeof rule?.enabled !== "boolean") throw invalidRules();
    return { id, label, enabled: rule.enabled };
  });
  const names = new Set(), values = new Set();
  const customRules = Array.from(input.customRules, rule => {
    if (typeof rule?.name !== "string" || typeof rule?.value !== "string") throw invalidRules();
    const name = rule.name.trim(), value = rule.value;
    if (!name || name.length > 60 || !value.trim() || value.length > 200 ||
        names.has(name.toLowerCase()) || values.has(value)) throw invalidRules();
    names.add(name.toLowerCase());
    values.add(value);
    return { name, value };
  });
  return { builtins, customRules };
}

export function redactionSource(entry) {
  if (entry?.kind !== "file" || !validUploadName(entry.name)) throw fail("SPACE_REDACTION_UNSUPPORTED");
  const extension = extname(entry.name);
  const format = extension.slice(1).toLowerCase();
  const extract = extractedFormats.has(format);
  if (!extract && !simpleFormats.has(format)) throw fail("SPACE_REDACTION_UNSUPPORTED");
  if (!Number.isSafeInteger(entry.size) || entry.size < 0) throw fail("SPACE_REDACTION_READ_FAILED");
  if (entry.size > (extract ? ANNOTATION_CONTENT_LIMITS.inputBytes : maxTextBytes)) throw fail("SPACE_REDACTION_TOO_LARGE");
  return { format, extension, extract };
}

function outputName(entry, source) {
  const suffix = `-脱敏${plainOutputFormats.has(source.format) ? ".txt" : source.extension}`;
  // Leave room for the space service's " (2)" collision suffix.
  const limit = 228 - Buffer.byteLength(suffix);
  let length = 0, stem = "";
  for (const character of entry.name.slice(0, -source.extension.length)) {
    length += Buffer.byteLength(character);
    if (length > limit) break;
    stem += character;
  }
  return stem + suffix;
}

function decodeJsonText(text) {
  try { JSON.parse(text); }
  catch { throw fail("SPACE_REDACTION_FORMAT_INVALID"); }
  // Decode escapes in keys and values while keeping the original numeric lexemes.
  // A parsed 18-digit number can lose precision before the rules inspect it.
  if (!text.includes("\\")) return text;
  const parts = [];
  let cursor = 0, start = 0, quote;
  while ((quote = text.indexOf('"', cursor)) !== -1) {
    cursor = quote + 1;
    let escaped = false;
    while (text[cursor] !== '"') {
      if (text[cursor] === "\\") { escaped = true; cursor++; }
      cursor++;
    }
    if (escaped) {
      parts.push(text.slice(start, quote + 1), JSON.parse(text.slice(quote, cursor + 1)));
      start = cursor;
    }
    cursor++;
  }
  return parts.length ? parts.join("") + text.slice(start) : text;
}

function maskText(text, policy) {
  const ends = new Uint32Array(text.length);
  for (const { id, pattern } of builtinRules) {
    if (!policy.builtins.find(rule => rule.id === id).enabled) continue;
    for (const match of text.matchAll(pattern)) ends[match.index] = Math.max(ends[match.index], match.index + match[0].length);
  }
  if (policy.customRules.length) {
    const terms = policy.customRules.map(rule => rule.value).sort((left, right) => right.length - left.length);
    const escaped = terms.map(value => value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&"));
    // A lookahead finds overlapping occurrences. Try the longest literal at each position.
    for (const match of text.matchAll(new RegExp(`(?=(${escaped.join("|")}))`, "gu"))) {
      ends[match.index] = Math.max(ends[match.index], match.index + match[1].length);
    }
  }

  const parts = [], chunks = [];
  let last = 0, matches = 0;
  for (let start = 0; start < ends.length; start++) {
    let end = ends[start];
    if (!end) continue;
    // Merge overlapping spans before replacing so no rule leaves part of another match visible.
    for (let index = start + 1; index < end; index++) end = Math.max(end, ends[index]);
    parts.push(text.slice(last, start), mark);
    if (parts.length >= 8192) {
      chunks.push(Buffer.from(parts.join(""), "utf8"));
      parts.length = 0;
    }
    matches++;
    last = end;
    start = end - 1;
  }
  if (!matches) return { bytes: Buffer.alloc(0), matches };
  parts.push(text.slice(last));
  const tail = Buffer.from(parts.join(""), "utf8");
  return { bytes: chunks.length ? Buffer.concat([...chunks, tail]) : tail, matches };
}

export async function redactSpaceFile({ entry, source = redactionSource(entry), bytes, rules, signal }) {
  signal?.throwIfAborted();
  const policy = normalizeRedactionRules(rules);
  if (!policy.builtins.some(rule => rule.enabled) && !policy.customRules.length) throw fail("SPACE_REDACTION_NO_RULES");
  if (!(bytes instanceof Uint8Array) || bytes.length !== entry.size) throw fail("SPACE_REDACTION_READ_FAILED");

  let text;
  if (source.extract) {
    const result = await extractAnnotationContent({ entry, bytes, signal });
    signal?.throwIfAborted();
    if (result.truncated) throw fail("SPACE_REDACTION_TOO_LARGE");
    if (result.mode !== "content" || !result.content.trim()) throw fail("SPACE_REDACTION_FORMAT_INVALID");
    text = result.content;
  } else {
    try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
    catch { throw fail("SPACE_REDACTION_FORMAT_INVALID"); }
    if (text.includes("\0")) throw fail("SPACE_REDACTION_FORMAT_INVALID");
    if (source.format === "json") text = decodeJsonText(text.replace(/^\uFEFF/, ""));
  }
  signal?.throwIfAborted();
  return { name: outputName(entry, source), ...maskText(text, policy) };
}
