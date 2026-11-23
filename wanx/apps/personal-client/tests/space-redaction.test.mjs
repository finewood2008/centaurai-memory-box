import assert from "node:assert/strict";
import test from "node:test";
import JSZip from "jszip";
import { defaultRedactionRules, normalizeRedactionRules, redactSpaceFile, redactionSource } from "../shell/space-redaction.mjs";

function redact(name, text, rules = defaultRedactionRules(), options = {}) {
  const bytes = Buffer.from(text), entry = { kind: "file", name, size: bytes.length };
  return redactSpaceFile({ entry, source: redactionSource(entry), bytes, rules, ...options });
}

test("built-ins redact all matching personal information while preserving other text", async () => {
  const original = "\uFEFF邮箱 qa.user+tag@example.invalid\r\n手机 +86 138-0013-8000\r\n编号 11010119900101001X\r\n保留这行\r\n";
  const result = await redact("合成材料.MD", original);
  assert.equal(result.name, "合成材料-脱敏.MD");
  assert.equal(result.matches, 3);
  assert.equal(result.bytes.toString(), "\uFEFF邮箱 ****\r\n手机 ****\r\n编号 ****\r\n保留这行\r\n");
});

test("custom rules are literal and case-sensitive and overlapping ranges cannot leak partial matches", async () => {
  const policy = defaultRedactionRules();
  policy.customRules = [{ name: "内部称呼", value: "X[A]" }, { name: "重复片段", value: "aba" }, { name: "重叠地址片段", value: "qa.user" }];
  const result = await redact("日志.log", "X[A] x[a]\nababa\nqa.user@example.invalid\n11010119900101001X@example.invalid", policy);
  assert.equal(result.matches, 4);
  assert.equal(result.bytes.toString(), "**** x[a]\n****\n****\n****");
});

test("rules validate names, enabled values, capacity and duplicates without sharing defaults", () => {
  const rules = defaultRedactionRules();
  const [email] = rules.builtins;
  email.enabled = false;
  email.label = "derived label";
  rules.customRules = [{ name: " 自定义 ", value: " literal " }];
  const normalized = normalizeRedactionRules(rules);
  assert.deepEqual(normalized.builtins[0], { ...defaultRedactionRules().builtins[0], enabled: false });
  assert.deepEqual(normalized.customRules, [{ name: "自定义", value: " literal " }]);
  for (const customRules of [[{ name: "", value: "x" }], [{ name: "规则", value: "  " }],
    [{ name: "规则", value: "W".repeat(201) }], [{ name: "W".repeat(61), value: "x" }],
    [{ name: "same", value: "one" }, { name: "SAME", value: "two" }],
    [{ name: "一", value: "same" }, { name: "二", value: "same" }],
    new Array(1), Array.from({ length: 31 }, (_, index) => ({ name: `规则 ${index}`, value: `值 ${index}` }))]) {
    assert.throws(() => normalizeRedactionRules({ ...rules, customRules }), { code: "SPACE_REDACTION_RULES_INVALID" });
  }
  rules.builtins[1].enabled = "true";
  assert.throws(() => normalizeRedactionRules(rules), { code: "SPACE_REDACTION_RULES_INVALID" });
});

test("JSON uses decoded strings and exact numeric lexemes and exports a text file", async () => {
  const rules = defaultRedactionRules();
  rules.customRules = [{ name: "精确编号", value: "9370012345612345678" }];
  const result = await redact("合成数据.json", '{"email":"qa.user\\u0040example.invalid","literal":"q\\\"\\\\","number":9370012345612345678,"keep":9223372036854775807}', rules);
  assert.equal(result.name, "合成数据-脱敏.txt");
  assert.equal(result.matches, 2);
  assert.match(result.bytes.toString(), /"email":"\*{4}"/);
  assert.match(result.bytes.toString(), /"number":\*{4},"keep":9223372036854775807/);
  await assert.rejects(redact("破损.json", '{"email":"qa@example.invalid"'), { code: "SPACE_REDACTION_FORMAT_INVALID" });
});

test("CSV and TSV produce text extracts and long names are truncated on Unicode boundaries", async () => {
  for (const extension of ["csv", "tsv"]) {
    const name = "😀".repeat(59) + "." + extension;
    const result = await redact(name, "qa@example.invalid");
    assert.ok(Buffer.byteLength(result.name) <= 240);
    assert.match(result.name, /^(?:😀)+-脱敏\.txt$/u);
    assert.equal(result.bytes.toString(), "****");
  }
});

test("the original is never returned as a copy when no rule matches", async () => {
  const rules = defaultRedactionRules();
  rules.builtins[0].enabled = false;
  const result = await redact("没有命中.txt", "qa@example.invalid", rules);
  assert.equal(result.matches, 0);
  assert.equal(result.bytes.length, 0);
  rules.builtins.forEach(rule => { rule.enabled = false; });
  await assert.rejects(redact("无规则.txt", "qa@example.invalid", rules), { code: "SPACE_REDACTION_NO_RULES" });
});

test("large batches preserve Unicode and every match across output chunks", async () => {
  const rules = defaultRedactionRules();
  rules.customRules = [{ name: "规则", value: "a" }];
  const result = await redact("many.txt", "🙂a".repeat(5000), rules);
  assert.equal(result.matches, 5000);
  assert.equal(result.bytes.toString(), "🙂****".repeat(5000));
});

test("folder, unsupported types, excessive length and invalid text fail before returning bytes", async () => {
  assert.throws(() => redactionSource({ kind: "folder", name: "文件夹.txt", size: 0 }), { code: "SPACE_REDACTION_UNSUPPORTED" });
  assert.throws(() => redactionSource({ kind: "file", name: "图像.png", size: 1 }), { code: "SPACE_REDACTION_UNSUPPORTED" });
  assert.throws(() => redactionSource({ kind: "file", name: "大文件.txt", size: 4 * 1024 * 1024 + 1 }), { code: "SPACE_REDACTION_TOO_LARGE" });
  await assert.rejects(redact("错误编码.txt", [0xff]), { code: "SPACE_REDACTION_FORMAT_INVALID" });
  await assert.rejects(redact("读入不全.txt", "原文", undefined, { bytes: Buffer.from("丢失了内容") }), { code: "SPACE_REDACTION_READ_FAILED" });
});

test("DOCX uses only readable body text and refuses truncated and empty extraction", async () => {
  async function document(body) {
    const zip = new JSZip();
    zip.file("word/document.xml", `<w:document xmlns:w="urn:w"><w:p><w:r><w:t>${body}</w:t></w:r></w:p></w:document>`);
    zip.file("word/header1.xml", "<w:t>private header</w:t>");
    return zip.generateAsync({ type: "nodebuffer" });
  }
  const result = await redact("文档.docx", await document("测试用户 qa@example.invalid"));
  assert.equal(result.name, "文档-脱敏.txt");
  assert.equal(result.bytes.toString(), "测试用户 ****");
  await assert.rejects(redact("大正文.docx", await document("x".repeat(33_000))), { code: "SPACE_REDACTION_TOO_LARGE" });
  await assert.rejects(redact("无文本.docx", await document("")), { code: "SPACE_REDACTION_FORMAT_INVALID" });
});
