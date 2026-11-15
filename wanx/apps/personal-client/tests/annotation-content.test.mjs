import test from "node:test";
import assert from "node:assert/strict";
import JSZip from "jszip";
import { extractAnnotationContent, ANNOTATION_CONTENT_LIMITS } from "../shell/annotation-content.mjs";

const extract = (name, bytes, signal) => extractAnnotationContent({ entry: { id: "a".repeat(32), name, kind: "file", size: bytes?.byteLength }, bytes, signal });
async function archive(files) {
  const zip = new JSZip();
  for (const [name, text] of Object.entries(files)) zip.file(name, text);
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}
function pdf(pages, encrypted = false) {
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
  const kids = [];
  for (const text of pages) {
    const page = objects.length + 1, stream = page + 1;
    kids.push(`${page} 0 R`);
    const escaped = text.replace(/[\\()]/g, value => "\\" + value);
    const content = text ? `BT /F1 12 Tf 20 100 Td (${escaped}) Tj ET` : "";
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 3 0 R >> >> /Contents ${stream} 0 R >>`);
    objects.push(`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`);
  }
  objects[1] = `<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${pages.length} >>`;
  if (encrypted) objects.push(`<< /Filter /Standard /V 1 /R 2 /Length 40 /O <${"00".repeat(32)}> /U <${"00".repeat(32)}> /P -4 >>`);
  let text = "%PDF-1.4\n", offsets = [0];
  for (const [index, object] of objects.entries()) { offsets.push(Buffer.byteLength(text)); text += `${index + 1} 0 obj\n${object}\nendobj\n`; }
  const start = Buffer.byteLength(text);
  text += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) text += String(offset).padStart(10, "0") + " 00000 n \n";
  text += `trailer\n<< /Root 1 0 R /Size ${objects.length + 1}${encrypted ? ` /Encrypt ${objects.length} 0 R /ID [<00112233445566778899aabbccddeeff> <00112233445566778899aabbccddeeff>]` : ""} >>\nstartxref\n${start}\n%%EOF\n`;
  return Buffer.from(text);
}

test("UTF-8 text, CSV, JSON and logs are extracted without detaching the caller buffer", async () => {
  for (const [name, content] of [["合成资料.txt", "项目预算核对\n第二行"], ["table.csv", "项目,金额\nA,300"], ["state.json", '{"project":"synthetic"}'], ["events.log", "synthetic event"]]) {
    const bytes = Buffer.from(content), before = Buffer.from(bytes);
    const value = await extract(name, bytes);
    assert.equal(value.mode, "content");
    assert.equal(value.content, content);
    assert.equal(value.truncated, false);
    assert.deepEqual(bytes, before);
  }
});

test("text output is bounded and reports truncation", async () => {
  const value = await extract("long.md", Buffer.from("预算".repeat(30_000)));
  assert.equal(value.mode, "content");
  assert.equal(value.content.length, ANNOTATION_CONTENT_LIMITS.textCharacters);
  assert.equal(value.truncated, true);
  const unicode = await extract("unicode.txt", Buffer.from("a".repeat(ANNOTATION_CONTENT_LIMITS.textCharacters - 1) + "😀"));
  assert.equal(unicode.truncated, true);
  assert.equal(unicode.content.length, ANNOTATION_CONTENT_LIMITS.textCharacters - 1);
});

test("HTML and XML extract visible text without scripts, styles or entity expansion", async () => {
  const html = await extract("page.html", Buffer.from('<!DOCTYPE html><h1>合成 &amp; 安全</h1><script>secretScript()</script><style>.secret{}</style><p>会议&#x7eaa;&#35201;</p>'));
  assert.equal(html.mode, "content");
  assert.match(html.content, /合成 & 安全/);
  assert.match(html.content, /会议纪要/);
  assert.doesNotMatch(html.content, /secret|script|style/);
  const xml = await extract("safe.xml", Buffer.from("<root><p>合成 XML</p></root>"));
  assert.match(xml.content, /合成 XML/);
  const unsafe = await extract("unsafe.xml", Buffer.from('<!DOCTYPE root [<!ENTITY x SYSTEM "file:///secret">]><root>&x;</root>'));
  assert.equal(unsafe.mode, "unsupported");
  assert.equal(unsafe.reason, "SPACE_ANNOTATION_XML_UNSAFE");
});

test("a text PDF preserves multiple pages; an image-only PDF is labeled without claiming OCR", async () => {
  const text = await extract("pages.pdf", pdf(["Synthetic project budget", "Second page meeting notes"]));
  assert.equal(text.mode, "content");
  assert.match(text.content, /Synthetic project budget/);
  assert.match(text.content, /Second page meeting notes/);
  assert.equal(text.truncated, false);
  const blank = await extract("scanned.pdf", pdf(["", ""]));
  assert.equal(blank.mode, "name-only");
  assert.equal(blank.content, "");
  assert.equal(blank.reason, "SPACE_ANNOTATION_PDF_NO_TEXT");
  const encrypted = await extract("locked.pdf", pdf(["synthetic"], true));
  assert.equal(encrypted.mode, "unsupported");
  assert.equal(encrypted.reason, "SPACE_ANNOTATION_CONTENT_ENCRYPTED");
});

test("DOCX extracts body paragraphs and tables, without evaluating fields or reading links", async () => {
  const bytes = await archive({
    "word/document.xml": '<w:document xmlns:w="urn:w"><w:body><w:p><w:r><w:t>项目合成资料 &amp; 合同</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>表格正文</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:p><w:r><w:instrText>HYPERLINK https://example.invalid/secret</w:instrText></w:r></w:p></w:body></w:document>',
    "word/_rels/document.xml.rels": '<Relationships><Relationship TargetMode="External" Target="https://example.invalid/external"/></Relationships>',
  });
  const value = await extract("synthetic.docx", bytes);
  assert.equal(value.mode, "content");
  assert.match(value.content, /项目合成资料 & 合同/);
  assert.match(value.content, /表格正文/);
  assert.doesNotMatch(value.content, /HYPERLINK|https:/);
});

test("PPTX extracts slides in numeric order, independently of ZIP entry order", async () => {
  const bytes = await archive({
    "ppt/slides/slide10.xml": '<p:sld xmlns:p="urn:p" xmlns:a="urn:a"><a:p><a:r><a:t>第十页</a:t></a:r></a:p></p:sld>',
    "ppt/slides/slide2.xml": '<p:sld xmlns:p="urn:p" xmlns:a="urn:a"><a:p><a:r><a:t>第二页</a:t></a:r></a:p></p:sld>',
    "ppt/slides/slide1.xml": '<p:sld xmlns:p="urn:p" xmlns:a="urn:a"><a:p><a:r><a:t>第一页</a:t></a:r></a:p></p:sld>',
  });
  const value = await extract("synthetic.pptx", bytes);
  assert.equal(value.mode, "content");
  assert.ok(value.content.indexOf("第一页") < value.content.indexOf("第二页"));
  assert.ok(value.content.indexOf("第二页") < value.content.indexOf("第十页"));
});

test("PPTX follows presentation relationship order after slides have been rearranged", async () => {
  const bytes = await archive({
    "ppt/presentation.xml": '<p:presentation xmlns:p="urn:p" xmlns:r="urn:r"><p:sldIdLst><p:sldId id="1" r:id="rId2"/><p:sldId id="2" r:id="rId1"/></p:sldIdLst></p:presentation>',
    "ppt/_rels/presentation.xml.rels": '<Relationships><Relationship Id="rId1" Target="slides/slide1.xml"/><Relationship Id="rId2" Target="slides/slide2.xml"/></Relationships>',
    "ppt/slides/slide1.xml": "<a:t>原来第一页</a:t>",
    "ppt/slides/slide2.xml": "<a:t>现在第一页</a:t>",
  });
  const value = await extract("reordered.pptx", bytes);
  assert.equal(value.mode, "content");
  assert.ok(value.content.indexOf("现在第一页") < value.content.indexOf("原来第一页"));
});

test("XLSX reads multiple named sheets, shared/inline strings and cached values without formulas", async () => {
  const bytes = await archive({
    "xl/workbook.xml": '<workbook xmlns:r="urn:r"><sheets><sheet name="预算" sheetId="1" r:id="rId1"/><sheet name="客户" sheetId="2" r:id="rId2"/></sheets></workbook>',
    "xl/_rels/workbook.xml.rels": '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="/xl/worksheets/sheet2.xml"/><Relationship Id="external" TargetMode="External" Target="https://example.invalid/external"/></Relationships>',
    "xl/sharedStrings.xml": '<sst><si><t>合成项目</t></si><si><r><t>客户</t></r><r><t>资料</t></r></si></sst>',
    "xl/worksheets/sheet1.xml": '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><f>HYPERLINK("https://example.invalid/secret")</f><v>300</v></c></row></sheetData></worksheet>',
    "xl/worksheets/sheet2.xml": '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>仅合成客户</t></is></c><c r="B1" t="s"><v>1</v></c></row></sheetData></worksheet>',
  });
  const value = await extract("synthetic.xlsx", bytes);
  assert.equal(value.mode, "content");
  for (const text of ["预算", "合成项目", "300", "客户", "仅合成客户", "客户资料"]) assert.ok(value.content.includes(text), text);
  assert.doesNotMatch(value.content, /HYPERLINK|https:/);
});

test("Office extraction reports output truncation", async () => {
  const bytes = await archive({ "word/document.xml": `<w:document xmlns:w="urn:w"><w:p><w:r><w:t>${"Synthetic paragraph ".repeat(4000)}</w:t></w:r></w:p></w:document>` });
  const value = await extract("long.docx", bytes);
  assert.equal(value.mode, "content");
  assert.equal(value.content.length, ANNOTATION_CONTENT_LIMITS.textCharacters);
  assert.equal(value.truncated, true);
});

test("images, unknown formats, folders and missing bytes explicitly remain name-only", async () => {
  for (const [name, reason] of [["photo.png", "SPACE_ANNOTATION_IMAGE_NO_OCR"], ["archive.7z", "SPACE_ANNOTATION_CONTENT_UNSUPPORTED"], ["existing.pdf", "SPACE_ANNOTATION_CONTENT_NOT_READ"]]) {
    const value = await extract(name);
    assert.equal(value.mode, "name-only");
    assert.equal(value.reason, reason);
    assert.equal(value.content, "");
  }
  const folder = await extractAnnotationContent({ entry: { name: "合成项目", kind: "folder" } });
  assert.equal(folder.mode, "name-only");
  assert.equal(folder.format, "folder");
});

test("invalid PDF, invalid UTF-8, binary data and incorrect Office packages fail explicitly", async () => {
  const invalidPDF = await extract("invalid.pdf", Buffer.from("this is not a PDF"));
  assert.equal(invalidPDF.mode, "unsupported");
  const invalidText = await extract("invalid.txt", Buffer.from([0xff, 0xff]));
  assert.equal(invalidText.reason, "SPACE_ANNOTATION_CONTENT_INVALID_UTF8");
  const binary = await extract("binary.txt", Buffer.from([0, 1, 2]));
  assert.equal(binary.reason, "SPACE_ANNOTATION_CONTENT_BINARY");
  const wrongPackage = await extract("invalid.docx", await archive({ "other.xml": "<data>nothing</data>" }));
  assert.equal(wrongPackage.mode, "unsupported");
  assert.equal(wrongPackage.reason, "SPACE_ANNOTATION_ARCHIVE_INVALID");
});

test("ZIP traversal, expansion budgets, entry limits and encrypted flags are rejected before content", async () => {
  const traversal = await extract("unsafe.docx", await archive({ "word/document.xml": "<w:t>body</w:t>", "../outside.xml": "secret" }));
  assert.equal(traversal.reason, "SPACE_ANNOTATION_ARCHIVE_PATH_INVALID");
  const valid = await archive({ "word/document.xml": "<w:t>body</w:t>" });
  const central = valid.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  const expanded = Buffer.from(valid); expanded.writeUInt32LE(ANNOTATION_CONTENT_LIMITS.expandedBytes + 1, central + 24);
  assert.equal((await extract("expanded.docx", expanded)).reason, "SPACE_ANNOTATION_ARCHIVE_LIMIT");
  const excessive = Buffer.from(valid), end = excessive.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  excessive.writeUInt16LE(10_001, end + 8); excessive.writeUInt16LE(10_001, end + 10);
  assert.equal((await extract("entries.docx", excessive)).reason, "SPACE_ANNOTATION_ARCHIVE_LIMIT");
  const encrypted = Buffer.from(valid); encrypted.writeUInt16LE(encrypted.readUInt16LE(central + 8) | 1, central + 8);
  assert.equal((await extract("encrypted.docx", encrypted)).reason, "SPACE_ANNOTATION_CONTENT_ENCRYPTED");
});

test("abort rejects both before worker creation and while extraction is in flight", async () => {
  const before = new AbortController(); before.abort();
  await assert.rejects(extract("never.txt", Buffer.from("synthetic"), before.signal), { code: "SPACE_ANNOTATION_CANCELED" });
  const current = new AbortController();
  const pending = extract("cancel.pdf", pdf(["synthetic"]), current.signal);
  current.abort();
  await assert.rejects(pending, { code: "SPACE_ANNOTATION_CANCELED" });
});

test("input limits and unsafe names never enter a parser", async () => {
  const large = await extract("large.txt", new Uint8Array(ANNOTATION_CONTENT_LIMITS.inputBytes + 1));
  assert.equal(large.mode, "unsupported");
  assert.equal(large.reason, "SPACE_ANNOTATION_CONTENT_TOO_LARGE");
  const path = await extract("../../secret.txt", Buffer.from("synthetic"));
  assert.equal(path.reason, "SPACE_ANNOTATION_CONTENT_INVALID_INPUT");
});
