import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import JSZip from "jszip";
import { createPersonalSpace } from "../shell/personal-space.mjs";
import { createCodexContextSources } from "../shell/codex-context-sources.mjs";
import { createCodexContext } from "../shell/codex-context.mjs";

const folder = "a".repeat(32), target = "b".repeat(32), outside = "c".repeat(32);
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const check = () => {};
async function fixture(t, name, bytes, before = () => {}) {
  const requests = [], listeners = new Set();
  const state = { phase: "ready", account: { phase: "authenticated", accountId: "owner" }, connection: { deviceId: "box" } };
  const file = { id: target, parent: folder, name, kind: "file", version: 1, modified: 1, size: bytes.length, digest: hash(bytes), space_id: "personal" };
  const client = { snapshot: () => state, subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    async applicationConnection() { return { context() { return {}; }, async request(input) {
      requests.push(input); await before(input, file);
      const url = new URL(input.path, "http://fixture");
      let value;
      if (url.pathname.endsWith("/files")) {
        const parent = url.searchParams.get("parent");
        value = { root: "", parent, space_id: "personal", breadcrumbs: parent ? [{ id: parent, name: "我的资料文件夹" }] : [], items: file.parent === parent ? [{ ...file }] : [] };
      } else if (url.pathname.endsWith("/content")) {
        const offset = Number(url.searchParams.get("offset")), length = Number(url.searchParams.get("length"));
        const chunk = bytes.subarray(offset, offset + length);
        return { status: 200, body: chunk, headers: { "x-content-sha256": hash(chunk) } };
      } else if (url.pathname.endsWith("/" + target)) value = { ...file };
      else assert.fail("Unexpected request: " + input.path);
      return { status: 200, headers: {}, body: Buffer.from(JSON.stringify(value)) };
    } }; } };
  const space = await createPersonalSpace({ client, store: { async load() { return []; }, async save() {} } });
  t.after(() => space.close());
  const sources = createCodexContextSources({ space });
  return { space, sources, file, requests, read: (start, guard = check) => sources.call({ folderId: folder }, "space_read", { fileId: target, start }, guard) };
}

test("MCP finds HTML body text and reads verified visible content without running scripts or loading links", async t => {
  const bytes = Buffer.from('<!doctype html><h1>供应链 &amp; 会员数据</h1><script>throw new Error("must not run")</script><style>.hidden{}</style><img src="https://example.invalid/private"><p>年度核对正文</p>');
  const h = await fixture(t, "供应链与会员数据查询汇总报告 (1).html", bytes);
  const search = await h.sources.call({ folderId: folder }, "space_search", { query: "年度核对正文" }, check);
  assert.equal(search.matches[0].fileId, target);
  assert.match(search.matches[0].snippet, /年度核对正文/);
  const read = await h.read(0);
  assert.match(read.text, /供应链 & 会员数据/);
  assert.doesNotMatch(read.text, /must not run|hidden|https:|<h1>/);
  assert.equal(read.extractedFormat, "html"); assert.equal(read.contentTruncated, false);
  const directory = await mkdtemp(path.join(tmpdir(), "html-mcp-")), descriptor = path.join(directory, "endpoint.json");
  const context = createCodexContext({ sources: h.sources, scope: () => "fixture/box/session", descriptor,
    configure: { async ensure() {}, async isConfigured() { return true; } } });
  t.after(async () => { await context.close(); await rm(directory, { recursive: true, force: true }); });
  await context.manage("connect", {}, check);
  const grant = await context.prepare({ folderId: folder }, check);
  const { port, token } = JSON.parse(await readFile(descriptor, "utf8"));
  const response = await fetch(`http://127.0.0.1:${port}/mcp`, { method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + token },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {
      name: "space_read", arguments: { task_id: grant.taskId, fileId: target },
    } }),
  });
  const reply = (await response.json()).result;
  assert.equal(reply.isError, undefined);
  assert.deepEqual(JSON.parse(reply.content[0].text), read);
  assert.ok(h.requests.every(row => row.path.startsWith("/api/personal-space/") && row.method === "GET"));
});

function pdf(text) {
  const stream = text ? `BT /F1 12 Tf 20 100 Td (${text}) Tj ET` : "";
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
  let body = "%PDF-1.4\n";
  const offsets = objects.map((object, index) => { const offset = Buffer.byteLength(body); body += `${index + 1} 0 obj\n${object}\nendobj\n`; return offset; });
  const start = Buffer.byteLength(body);
  body += "xref\n0 6\n0000000000 65535 f \n" + offsets.map(offset => String(offset).padStart(10, "0") + " 00000 n \n").join("");
  return Buffer.from(body + `trailer\n<< /Root 1 0 R /Size 6 >>\nstartxref\n${start}\n%%EOF\n`);
}

test("MCP reads PDF text and explains when a PDF has no readable text", async t => {
  const h = await fixture(t, "report.pdf", pdf("Synthetic PDF body"));
  assert.match((await h.read(0)).text, /Synthetic PDF body/);
  const blank = await fixture(t, "scan.pdf", pdf(""));
  await assert.rejects(blank.read(0), /OCR/);
});

for (const [name, files, expected] of [
  ["研发.docx", { "word/document.xml": '<w:document><w:p><w:r><w:t>研发记录正文</w:t></w:r></w:p></w:document>' }, "研发记录正文"],
  ["研发.pptx", { "ppt/slides/slide1.xml": '<p:sld><a:p><a:r><a:t>研发演示正文</a:t></a:r></a:p></p:sld>' }, "研发演示正文"],
  ["研发.xlsx", { "xl/workbook.xml": '<workbook><sheet name="研发预算" sheetId="1"/></workbook>', "xl/worksheets/sheet1.xml": '<worksheet><row><c r="A1" t="inlineStr"><is><t>预算正文</t></is></c></row></worksheet>' }, "预算正文"],
]) test(`MCP reads original ${name} bytes through the document extractor`, async t => {
  const zip = new JSZip(); for (const [path, text] of Object.entries(files)) zip.file(path, text);
  const h = await fixture(t, name, await zip.generateAsync({ type: "nodebuffer" }));
  assert.match((await h.read(0)).text, new RegExp(expected));
  assert.equal(h.requests.some(row => row.path.includes("space-previews")), false);
});

test("extracted text paginates and explicitly reports the extraction limit", async t => {
  const h = await fixture(t, "长报告.html", Buffer.from("<p>" + "正文".repeat(25000) + "</p>"));
  let start = 0, text = "";
  do { const page = await h.read(start); text += page.text; start = page.nextStart; assert.equal(page.contentTruncated, true); } while (start !== null);
  assert.equal(text.length, 32768);
});

test("a move or changed digest during document reading prevents content delivery", async t => {
  for (const change of [file => { file.parent = outside; }, file => { file.digest = "0".repeat(64); }]) {
    const h = await fixture(t, "report.html", Buffer.from("<p>不得返回的旧正文</p>"), (request, file) => { if (request.path.includes("/content?")) change(file); });
    await assert.rejects(h.read(0), { status: 403 });
  }
});

test("MCP revocation during extraction withholds text and malformed HTML encoding reports the reason", async t => {
  const h = await fixture(t, "report.html", Buffer.from("<p>授权正文</p>"));
  let revoked = false;
  const read = h.space.readDocument;
  h.space.readDocument = async (...args) => { const value = await read(...args); revoked = true; return value; };
  await assert.rejects(h.read(0, () => { if (revoked) throw new Error("TASK_REVOKED"); }), /TASK_REVOKED/);
  const invalid = await fixture(t, "invalid.html", Buffer.from([0xff, 0xff]));
  await assert.rejects(invalid.read(0), /UTF-8/);
});

test("document search limits extraction work and reports incomplete coverage", async () => {
  const files = Array.from({ length: 5 }, (_, index) => ({ id: String(index + 1).repeat(32), kind: "file", parent: folder,
    name: `report-${index}.html`, size: 100, version: 1 }));
  const parsed = [];
  const sources = createCodexContextSources({ space: {
    async operation(action, input) {
      assert.equal(action, "list"); assert.equal(input.parent, folder);
      return { root: "", parent: folder, space_id: "personal", breadcrumbs: [{ id: folder, name: "Docs" }], items: files };
    },
    async readDocument(file, { signal }) {
      assert.ok(signal); assert.equal(signal.aborted, false); parsed.push(file.id);
      return { mode: "content", format: "html", content: "search-token", truncated: false };
    },
  } });
  const result = await sources.call({ folderId: folder }, "space_search", { query: "search-token" }, check);
  assert.equal(parsed.length, 4);
  assert.equal(result.matches.length, 4);
  assert.equal(result.truncated, true);
  assert.equal(result.skippedTextFiles, 1);
});
