import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../local-ui/renderer/space-annotation-workbench.js", import.meta.url), "utf8");
const spaceSource = await readFile(new URL("../local-ui/renderer/personal-space.js", import.meta.url), "utf8");
const tick = () => new Promise(resolve => setImmediate(resolve));
const id = index => index.toString(16).padStart(32, "0");
const rows = count => Array.from({ length: count }, (_, index) => ({ id: id(index + 1), name: `合成文件 ${index + 1}.txt`, path: `项目/合成文件 ${index + 1}.txt`, kind: "file", parent: id(9999), size: 10, writable: true, status: "unannotated", annotation: {
  tags: [index % 2 ? "共同标签" : "仅部分标签", "继承标签"], automatic: { tags: [index % 2 ? "共同标签" : "仅部分标签"], description: "自动说明" },
  manual: null, description: "有效说明", revision: 1, inherit: true, provenance: [{ tag: "继承标签", source: "inherited", itemId: id(9999), sourceName: "项目", sourcePath: "我的空间/项目" }],
} }));
function harness(t, options = {}) {
  const calls = [], document = { activeElement: null }, data = options.rows || rows(3);
  let closed = 0, changed = 0, snapshot = { job: { id: "synthetic-job", status: "ready", scanned: data.length, scanComplete: true, total: data.length }, items: data, total: data.length, filteredTotal: data.length, offset: 0,
    summary: { total: data.length, unannotated: data.length, tagCounts: [{ tag: "共同标签", count: 2 }] } };
  const window = {};
  vm.runInNewContext(source, { window, document, setTimeout, clearTimeout, URL, Blob, atob, TextDecoder, Uint8Array });
  const workbench = window.createSpaceAnnotationWorkbench({ changed: () => { changed++; }, onClose: () => { closed++; }, async call(input) {
    calls.push(structuredClone(input));
    const custom = await options.call?.(input);
    if (custom !== undefined) { if (custom.job && custom.items) snapshot = { ...snapshot, ...custom }; return custom; }
    if (input.op === "models") return { available: options.ai !== false, presets: [{ id: "synthetic-model", name: "测试模型", provider: "本机测试" }] };
    if (input.op === "schemes") return { items: [{ id: "synthetic-scheme", name: "客户资料", tags: ["客户"], instructions: "每份一句说明", inherit: true }], tags: options.savedTags || [] };
    if (input.op === "prepare") return { planId: "synthetic-plan", operationId: "synthetic-op", targetCount: input.selection.ids?.length || data.length, changeCount: 1, examples: [{ name: data[0].name, before: { tags: ["旧值"] }, after: { tags: ["新值"] } }], warnings: [] };
    if (input.op === "draft") return { saved: true };
    if (input.op === "preview") return { name: "合成预览", type: "text/plain", data: Buffer.from("<script>合成正文</script>").toString("base64"), truncated: true };
    return structuredClone(snapshot);
  } });
  t.after(() => workbench.reset());
  return { workbench, calls, data, document, get closed() { return closed; }, get changed() { return changed; }, setSnapshot(value) { snapshot = { ...snapshot, ...value }; } };
}
async function opened(t, options) { const h = harness(t, options); await h.workbench.open({ space_id: "personal", parent: id(9999), scopeName: "合成项目" }); await tick(); return h; }

test("tag input commits removable chips, deduplicates pasted labels and saves pending text", async t => {
  const h = await opened(t);
  h.workbench.input("item-tag-input", "合同");
  let prevented = false;
  await h.workbench.keydown({ key: "Enter", target: { dataset: { wbField: "item-tag-input" } }, preventDefault() { prevented = true; } });
  assert.equal(prevented, true); assert.match(h.workbench.render(), /class="awb-tag-token">合同<button/);
  h.workbench.input("item-tag-input", "合同，客户;Project;project");
  assert.equal((h.workbench.render().match(/class="awb-tag-token">合同<button/g) || []).length, 1);
  await h.workbench.action("tag-remove", { field: "item-tag-input", tag: "合同" });
  assert.doesNotMatch(h.workbench.render(), /class="awb-tag-token">合同<button/);
  h.workbench.input("item-tag-input", "未按回车的标签");
  await h.workbench.action("prepare");
  const draft = h.calls.filter(call => call.op === "draft").at(-1);
  assert.deepEqual(draft.patch.tags, ["仅部分标签", "客户", "project", "未按回车的标签"]);
  assert.equal(h.calls.some(call => call.op === "apply"), false);
});

test("tag editing respects IME, limits and read-only access", async t => {
  const h = await opened(t);
  h.workbench.composition(true); h.workbench.input("item-tag-input", "中文，标签");
  assert.equal(await h.workbench.keydown({ key: "Enter", isComposing: true }), false);
  assert.doesNotMatch(h.workbench.render(), /class="awb-tag-token">中文<button/);
  h.workbench.composition(false); h.workbench.input("item-tag-input", "中文，标签");
  assert.match(h.workbench.render(), /class="awb-tag-token">中文<button/);
  h.workbench.input("item-tag-input", "a".repeat(81)); await h.workbench.action("prepare");
  assert.match(h.workbench.render(), /每个标签最多 80 个字符/);
  assert.equal(h.calls.some(call => call.op === "prepare"), false);
  const data = rows(1); data[0].writable = false;
  const readOnly = await opened(t, { rows: data });
  readOnly.workbench.input("item-tag-input", "不得保存，");
  await readOnly.workbench.action("tag-remove", { field: "item-tag-input", tag: "仅部分标签" });
  assert.equal(readOnly.calls.some(call => call.op === "draft"), false);
});

test("saved labels are offered in a dropdown and reuse preserves the chosen batch mode", async t => {
  const h = await opened(t, { call: input => input.op === "schemes" ? { items: [], tags: ["上次添加", "<合成标签>"] } : undefined });
  assert.match(h.workbench.render(), /<select data-wb-field="tag-existing"[^>]*>.*<option value="上次添加">上次添加<\/option>/);
  assert.doesNotMatch(h.workbench.render(), /awb-quick-tags/);
  assert.match(h.workbench.render(), /&lt;合成标签&gt;/); assert.doesNotMatch(h.workbench.render(), /<合成标签>/);
  h.workbench.input("item-tag-input", "尚未确认的新标签");
  h.workbench.input("tag-existing", "上次添加");
  assert.match(h.workbench.render(), /class="awb-tag-token">上次添加<button/);
  assert.match(h.workbench.render(), /class="awb-tag-token">尚未确认的新标签<button/);
  assert.doesNotMatch(h.workbench.render(), /<option value="上次添加">/);
  await h.workbench.action("check", { id: h.data[0].id }); await h.workbench.action("check", { id: h.data[1].id });
  h.workbench.input("bulk-tagMode", "remove");
  h.workbench.input("tag-existing", "共同标签"); await h.workbench.action("prepare");
  const change = h.calls.find(call => call.op === "prepare").change;
  assert.equal(change.tagMode, "remove"); assert.deepEqual(change.tags, ["共同标签"]);
});

test("selecting a known label from the dropdown preserves its punctuation", async t => {
  const h = await opened(t, { call: input => input.op === "schemes" ? { items: [], tags: ["供应商，国内"] } : undefined });
  h.workbench.input("tag-existing", "供应商，国内");
  await h.workbench.action("prepare");
  assert.deepEqual(h.calls.find(call => call.op === "draft").patch.tags, ["仅部分标签", "供应商，国内"]);
});

test("a reusable tag scheme can be edited without selecting any files", async t => {
  const h = await opened(t, { rows: [] });
  await h.workbench.action("tab", { tab: "schemes" });
  h.workbench.input("scheme-name", "常用项目标签");
  h.workbench.input("bulk-tag-input", "项目，归档");
  await h.workbench.action("save-scheme");
  assert.deepEqual(h.calls.find(call => call.op === "save-scheme").scheme.tags, ["项目", "归档"]);
});

for (const transition of ['scope-folder', 'job', 'tab', 'page-select']) test(`pending tag input is preserved before changing ${transition}`, async t => {
  const h = await opened(t);
  h.workbench.input('item-tag-input', '尚未按回车');
  if (transition === 'job') { h.workbench.input('job', 'second-job'); await tick(); await tick(); }
  else if (transition === 'tab') await h.workbench.action('tab', { tab: 'schemes' });
  else await h.workbench.action(transition, { id: id(9998), name: '另一目录' });
  const draft = h.calls.find(call => call.op === 'draft');
  assert.ok(draft, 'context changes must not discard the input buffer');
  assert.equal(draft.jobId, 'synthetic-job'); assert.equal(draft.id, h.data[0].id);
  assert.ok(draft.patch.tags.includes('尚未按回车'));
});

test('applying a reusable scheme includes its pending tag input and preserves punctuation in saved labels', async t => {
  const h = await opened(t, { savedTags: ['供应商，国内'] });
  await h.workbench.action('tab', { tab: 'schemes' }); h.workbench.input('scheme', 'synthetic-scheme');
  h.workbench.input('bulk-tag-input', '补充标签'); await h.workbench.action('use-scheme');
  const draft = h.calls.filter(call => call.op === 'draft').at(-1);
  assert.deepEqual(draft.patch.tags, ['仅部分标签', '客户', '补充标签']);
  h.workbench.input('item-tag-input', '供应商，国内'); await h.workbench.action('prepare');
  assert.ok(h.calls.filter(call => call.op === 'draft').at(-1).patch.tags.includes('供应商，国内'));
});

test('a new file tag remains reusable when the saved tag catalogue is full', async t => {
  const h = await opened(t, { call: input => input.op === 'schemes' ? { items: [], tags: Array.from({ length: 500 }, (_, i) => `旧标签${i}`) } : undefined });
  h.workbench.input('item-tag-input', '本次新增，'); await h.workbench.action('next');
  assert.match(h.workbench.render(), /<option value="本次新增">/);
});

test('invalid pending tags keep the original editor and prevent scope changes', async t => {
  const h = await opened(t);
  h.workbench.input('item-tag-input', 'x'.repeat(81));
  await h.workbench.action('scope-folder', { id: id(9998), name: '另一目录' });
  assert.equal(h.calls.filter(call => call.op === 'open').length, 1);
  assert.match(h.workbench.render(), /每个标签最多 80 个字符/);
  assert.match(h.workbench.render(), /data-wb-field="item-tag-input"/);
});

test('invalid pending tags do not consume the parent scope history', async t => {
  const h = await opened(t);
  await h.workbench.action('scope-folder', { id: id(9998), name: '子目录' });
  h.workbench.input('item-tag-input', 'x'.repeat(81)); await h.workbench.action('scope-parent');
  assert.equal(h.calls.filter(call => call.op === 'open').length, 2);
  h.workbench.input('item-tag-input', '有效标签'); await h.workbench.action('scope-parent');
  assert.equal(h.calls.filter(call => call.op === 'open').at(-1).parent, id(9999));
});

test('an old close operation cannot reset a newly opened account context', async t => {
  const h = await opened(t);
  const closing = h.workbench.action('close');
  const opening = h.workbench.open({ space_id: 'personal', parent: id(9998), scopeName: '新账号上下文' });
  await Promise.all([closing, opening]);
  assert.equal(h.workbench.active(), true); assert.equal(h.closed, 0);
  assert.match(h.workbench.render(), /新账号上下文/);
});

test("scrolling a bounded page does not rerender or fetch the list", async t => {
  const h = await opened(t, { rows: rows(1000) });
  assert.equal((h.workbench.render().match(/class="awb-file /g) || []).length, 10);
  const renders = h.changed, requests = h.calls.length;
  h.workbench.onScroll(58 * 2);
  h.workbench.onScroll(58 * 5);
  assert.equal(h.changed, renders);
  assert.equal(h.calls.length, requests);
  const viewport = { scrollTop: 0 };
  h.workbench.mounted({ querySelector: () => viewport });
  assert.equal(viewport.scrollTop, 58 * 5);
});

test("whole-filter selection is revealed only after an explicit page selection", async t => {
  const paged = await opened(t, { rows: rows(200) });
  paged.setSnapshot({ total: 1000, filteredTotal: 1000, job: { id: "synthetic-job", status: "ready", scanned: 1000, scanComplete: true, total: 1000 } });
  await paged.workbench.refresh();
  assert.match(paged.workbench.render(), /aria-label="选择当前页"/);
  assert.doesNotMatch(paged.workbench.render(), /data-action="space-wb-matching-select"/);
  await paged.workbench.action("page-select");
  assert.match(paged.workbench.render(), /data-action="space-wb-matching-select"/);
  await paged.workbench.action("matching-select");
  await paged.workbench.action("prepare");
  const prepare = paged.calls.find(call => call.op === "prepare");
  assert.deepEqual(prepare.selection, { allMatching: { query: "", type: "", status: "" } });
  assert.match(paged.workbench.render(), /保存前核对/);
  assert.equal(paged.calls.some(call => call.op === "apply"), false, "preview does not mutate annotations");
  await paged.workbench.action("plan-apply");
  assert.equal(paged.calls.filter(call => call.op === "apply").length, 1);
});

test("an incomplete scan cannot silently select undiscovered files", async t => {
  const h = await opened(t);
  h.setSnapshot({ job: { id: "synthetic-job", status: "ready", scanned: 3, scanComplete: false } });
  await h.workbench.refresh();
  await h.workbench.action("matching-select");
  assert.match(h.workbench.render(), /目录仍在扫描/);
  await h.workbench.action("prepare");
  assert.deepEqual(h.calls.find(call => call.op === "prepare").selection.ids, [h.data[0].id]);
});

test("batch mixed fields remain keep until changed and own labels never materialize inherited tags", async t => {
  const h = await opened(t);
  await h.workbench.action("check", { id: h.data[0].id }); await h.workbench.action("check", { id: h.data[1].id });
  let html = h.workbench.render(); assert.match(html, /1\/2/); assert.match(html, /保持原值/);
  h.workbench.input("bulk-tagMode", "add"); h.workbench.input("bulk-tags", "客户，合同");
  await h.workbench.action("prepare");
  const change = h.calls.find(call => call.op === "prepare").change;
  assert.equal(change.tagMode, "add"); assert.deepEqual(change.tags, ["客户", "合同"]); assert.equal(change.descriptionMode, "keep");
  assert.equal(Object.hasOwn(change, "inherit"), false);
  await h.workbench.action("plan-close"); await h.workbench.action("clear"); await h.workbench.action("focus", { id: h.data[0].id });
  h.workbench.render(); // Mirror the actual editor render after changing focus.
  await h.workbench.action("save-next");
  const patch = h.calls.find(call => call.op === "draft").patch;
  assert.deepEqual(patch.tags, ["仅部分标签"]); assert.ok(!patch.tags.includes("继承标签"));
});

test("continuous editing flushes drafts before switching files and command-enter requires confirmation", async t => {
  const h = await opened(t);
  h.workbench.input("item-tags", "草稿标签"); h.workbench.input("item-description", "手工草稿");
  await h.workbench.keydown({ key: "ArrowDown", preventDefault() {}, target: { closest() { return false; } } });
  const draft = h.calls.find(call => call.op === "draft");
  assert.equal(draft.id, h.data[0].id); assert.equal(draft.patch.description, "手工草稿");
  await h.workbench.action("previous"); assert.match(h.workbench.render(), /class="awb-tag-token">草稿标签<button/);
  await h.workbench.keydown({ key: "Enter", ctrlKey: true, preventDefault() {}, target: { closest() { return true; } } });
  assert.match(h.workbench.render(), /确认保存并下一项/); assert.equal(h.calls.some(call => call.op === "apply"), false);
  await h.workbench.keydown({ key: "Enter", ctrlKey: true, preventDefault() {} });
  assert.equal(h.calls.filter(call => call.op === "apply").length, 1);
});

test("saved tags and schemes load on open and populate reusable manual batch additions without model or file scope", async t => {
  const h = await opened(t);
  assert.equal(h.calls.some(call => call.op === "schemes"), true);
  assert.equal(h.calls.some(call => call.op === "models"), false);
  await h.workbench.action("tab", { tab: "schemes" });
  assert.equal(h.calls.some(call => call.op === "schemes"), true);
  h.workbench.input("scheme", "synthetic-scheme");
  await h.workbench.action("save-scheme");
  const saved = h.calls.find(call => call.op === "save-scheme").scheme;
  assert.deepEqual(saved.tags, ["客户"]); assert.equal(saved.instructions, "每份一句说明");
  assert.equal(Object.hasOwn(saved, "modelPresetId"), false); assert.equal(Object.hasOwn(saved, "parent"), false);
  await h.workbench.action("tab", { tab: "edit" }); await h.workbench.action("check", { id: h.data[0].id }); await h.workbench.action("check", { id: h.data[1].id });
  assert.match(h.workbench.render(), /class="awb-tag-token">客户<button/);
  assert.equal(h.calls.some(call => ["models", "suggest", "apply"].includes(call.op)), false);
});

test("preview and annotation labels are escaped, while inherited sources display names rather than IDs", async t => {
  const data = rows(2); data[0].name = '<img src=x onerror="bad()">.txt';
  const h = await opened(t, { rows: data });
  assert.match(h.workbench.render(), /&lt;img/); assert.doesNotMatch(h.workbench.render(), /<img src=x/);
  assert.match(h.workbench.render(), /↗ 项目/);
  await h.workbench.action("preview");
  assert.match(h.workbench.render(), /&lt;script&gt;合成正文/); assert.match(h.workbench.render(), /部分内容/);
  assert.doesNotMatch(h.workbench.render(), /<script>合成正文/);
});

test("reset hides private jobs, clears draft timers and ignores late responses", async t => {
  let release;
  const h = await opened(t, { call: input => input.op === "preview" ? new Promise(resolve => { release = resolve; }) : undefined });
  const pending = h.workbench.action("preview"); await tick();
  h.workbench.input("item-description", "未完成的私密草稿"); h.workbench.reset();
  release({ type: "text/plain", data: Buffer.from("迟到正文").toString("base64") }); await pending;
  assert.equal(h.workbench.render(), "");
  await new Promise(resolve => setTimeout(resolve, 270));
  assert.equal(h.calls.some(call => call.op === "draft"), false);
  assert.equal(h.workbench.active(), false);
});

test("read-only rows can be inspected but cannot submit item drafts", async t => {
  const data = rows(1); data[0].writable = false;
  const h = await opened(t, { rows: data });
  assert.match(h.workbench.render(), /只读/); assert.match(h.workbench.render(), /data-wb-field="item-tag-input"[^>]*disabled/);
  h.workbench.input("item-tags", "不得保存"); await h.workbench.action("prepare");
  assert.equal(h.calls.some(call => ["draft", "prepare", "apply"].includes(call.op)), false);
});

test("manual workbench never loads models or generates suggestions, including calls to retired frontend actions", async t => {
  const h = await opened(t);
  await h.workbench.action("tab", { tab: "assistant" });
  await h.workbench.action("refresh-models");
  h.workbench.input("model", "rules");
  h.workbench.input("instructions", "retired synthetic AI request");
  await h.workbench.action("suggest");
  const html = h.workbench.render();
  assert.doesNotMatch(html, /AI 助手|辅助标注|使用模型|生成建议|data-tab="assistant"/);
  assert.equal(h.calls.some(call => ["models", "suggest", "apply"].includes(call.op)), false);
});

test("legacy suggestions distinguish name-only, unsupported and content analysis with readable reasons", async t => {
  const data = rows(3);
  data[0].suggestion = { tags: ["名称建议"], contentMode: "name-only", reason: "SPACE_ANNOTATION_IMAGE_NO_OCR" };
  data[1].suggestion = { tags: [], contentMode: "unsupported", reason: "SPACE_ANNOTATION_CONTENT_TOO_LARGE" };
  data[2].suggestion = { tags: [], contentMode: "content", truncated: true };
  const h = await opened(t, { rows: data });
  assert.match(h.workbench.render(), /仅分析名称 · 图片尚不支持文字识别/);
  assert.match(h.workbench.render(), /<details[^>]*>[\s\S]*?历史建议/);
  assert.doesNotMatch(h.workbench.render(), /<small>内容分析/);
  await h.workbench.action("next");
  assert.match(h.workbench.render(), /不支持内容分析 · 文件超出本次内容读取大小限制/);
  assert.doesNotMatch(h.workbench.render(), /SPACE_ANNOTATION_CONTENT_TOO_LARGE/);
  await h.workbench.action("next");
  assert.match(h.workbench.render(), /<small>内容分析 · 部分内容（每项最大 64 MB；文本型 PDF 最多读取前 200 页；每项最多分析 32768 个字符，此建议未覆盖全文）<\/small>/);
  await h.workbench.action("accept-suggestion");
  const dialog = h.workbench.render().split('aria-label="确认标注变更"')[1];
  assert.match(dialog, /内容读取边界：每项最大 64 MB；文本型 PDF 最多读取前 200 页；每项最多分析 32768 个字符/);
  assert.match(dialog, /标记“部分内容”的建议未覆盖全文/);
});

test("scheme names share the backend 80 character limit", async t => {
  const h = await opened(t);
  await h.workbench.action("tab", { tab: "schemes" });
  assert.match(h.workbench.render(), /data-wb-field="scheme-name" maxlength="80"/);
  h.workbench.input("scheme-name", "合".repeat(81)); await h.workbench.action("save-scheme");
  assert.equal(h.calls.some(call => call.op === "save-scheme"), false);
  assert.match(h.workbench.render(), /方案名称最多 80 个字符/);
});

test("confirmation describes description-only, empty and inheritance-only changes using own before values", async t => {
  const h = await opened(t, { call: input => input.op === "prepare" ? { planId: "diffs", targetCount: 3, changeCount: 3, examples: [
    { name: "说明项", before: { manual: { tags: ["人工标签"], description: "原说明" }, tags: ["人工标签", "继承标签"], inherit: true }, after: { description: "新说明" } },
    { name: "清空项", before: { automatic: { tags: [], description: "自动说明" }, inherit: false }, after: { description: "", inherit: true } },
    { name: "继承项", before: { manual: { tags: [], description: "" }, inherit: true }, after: { inherit: false } },
  ] } : undefined });
  await h.workbench.action("prepare"); const html = h.workbench.render();
  assert.match(html, /<del>本项标签：人工标签 · 本项说明：原说明 · 继承：开启<\/del>/);
  assert.match(html, /<ins>本项说明改为：新说明<\/ins>/);
  assert.match(html, /<ins>清空本项说明 · 开启继承<\/ins>/);
  assert.match(html, /<ins>关闭继承<\/ins>/);
  assert.doesNotMatch(html, /<del>[^<]*继承标签/);
  assert.doesNotMatch(html, /保持未修改字段/);
});

test("legacy suggestion acceptance has independent safe defaults and explicit keep or replace policies", async t => {
  const data = rows(3); data[0].suggestion = { tags: ["历史建议标签"], description: "历史建议", contentMode: "name-only" };
  const h = await opened(t, { rows: data });
  await h.workbench.action("page-select");
  h.workbench.input("bulk-tagMode", "remove"); h.workbench.input("bulk-tags", "已有人工标签");
  h.workbench.input("bulk-descriptionMode", "replace"); h.workbench.input("bulk-description", "上一轮统一说明"); h.workbench.input("bulk-inherit", "off");
  let html = h.workbench.render();
  assert.match(html, /历史建议/);
  assert.doesNotMatch(html, /data-tab="assistant"/);
  assert.match(html, /data-wb-field="suggestion-tags"[^>]*><option value="add" selected/);
  assert.match(html, /data-wb-field="suggestion-description"[^>]*><option value="fill-empty" selected/);
  await h.workbench.action("accept-suggestion");
  let request = h.calls.filter(call => call.op === "prepare").at(-1);
  assert.deepEqual(request.change, { tagMode: "add", descriptionMode: "fill-empty", tags: [], description: "" });
  assert.equal(request.acceptSuggestions, true); assert.equal(Object.hasOwn(request, "useDrafts"), false);
  assert.equal(h.calls.some(call => call.op === "apply"), false);
  await h.workbench.action("plan-close");
  h.workbench.input("suggestion-tags", "keep"); h.workbench.input("suggestion-description", "replace"); await h.workbench.action("accept-suggestion");
  request = h.calls.filter(call => call.op === "prepare").at(-1);
  assert.deepEqual(request.change, { tagMode: "keep", descriptionMode: "replace", tags: [], description: "" });
  await h.workbench.action("plan-close");
  h.workbench.input("suggestion-tags", "replace"); h.workbench.input("suggestion-description", "keep"); await h.workbench.action("accept-suggestion");
  request = h.calls.filter(call => call.op === "prepare").at(-1);
  assert.deepEqual(request.change, { tagMode: "replace", descriptionMode: "keep", tags: [], description: "" });
  assert.equal(Object.hasOwn(request.change, "inherit"), false);
});

test("item suggestion review is scoped to the current item even with a larger selection", async t => {
  const data = rows(3); data[0].suggestion = { tags: ["建议标签"], description: "单项建议", contentMode: "name-only" };
  const h = await opened(t, { rows: data }); await h.workbench.action("page-select");
  assert.match(h.workbench.render(), /接受建议的方式/); assert.match(h.workbench.render(), /审核此建议/);
  await h.workbench.action("accept-item-suggestion");
  const request = h.calls.find(call => call.op === "prepare");
  assert.deepEqual(request.selection, { ids: [data[0].id] });
  assert.equal(request.change.tagMode, "add"); assert.equal(request.change.descriptionMode, "fill-empty");
});

test("skipping item and selected suggestions persists without submitting annotations or drafts", async t => {
  const data = rows(3); for (const row of data) row.suggestion = { tags: ["待跳过"], description: "建议", contentMode: "name-only" };
  const annotations = structuredClone(data.map(row => row.annotation));
  const h = await opened(t, { rows: data, call(input) { if (input.op === "skip-suggestions") { const ids = new Set(input.selection.ids || data.map(row => row.id)); for (const row of data) if (ids.has(row.id)) delete row.suggestion; } } });
  await h.workbench.action("page-select");
  assert.match(h.workbench.render(), /跳过此建议/); await h.workbench.action("skip-item-suggestion");
  assert.deepEqual(h.calls.find(call => call.op === "skip-suggestions").selection, { ids: [data[0].id] });
  assert.equal(data[1].suggestion.tags[0], "待跳过"); assert.doesNotMatch(h.workbench.render(), /跳过此建议/);
  await h.workbench.action("skip-suggestions");
  assert.deepEqual(h.calls.filter(call => call.op === "skip-suggestions").at(-1).selection, { ids: data.map(row => row.id) });
  assert.deepEqual(data.map(row => row.annotation), annotations);
  assert.equal(h.calls.some(call => ["prepare", "apply", "draft"].includes(call.op)), false);
});

test("batch summaries count effective descriptions and inheritance across the explicit selection", async t => {
  const data = rows(4);
  data.forEach((row, index) => { row.annotation.description = index < 2 ? "继承的共同说明" : ""; row.annotation.inherit = index < 2; row.annotation.automatic.tags = ["所有项共有", `部分${index % 2}`]; });
  const h = await opened(t, { rows: data });
  await h.workbench.action("check", { id: data[0].id }); await h.workbench.action("check", { id: data[1].id });
  assert.match(h.workbench.render(), /说明共同值：继承的共同说明/);
  assert.match(h.workbench.render(), /空说明 0\/2 项 · 继承开启 2 项 \/ 关闭 0 项/);
  await h.workbench.action("page-select"); const html = h.workbench.render();
  assert.match(html, /title="全部共有">所有项共有 <small>4\/4/);
  assert.match(html, /title="部分文件已有">部分0 <small>2\/4/);
  assert.match(html, /说明为混合值，未修改时各项保留/);
  assert.match(html, /空说明 2\/4 项 · 继承开启 2 项 \/ 关闭 2 项/);
});

test("whole-filter summaries use complete backend statistics rather than the visible page", async t => {
  const h = await opened(t);
  h.setSnapshot({ total: 1000, filteredTotal: 1000, filteredSummary: { count: 1000, tagCounts: [{ tag: "整批标签", count: 990 }], commonDescription: null, emptyDescriptions: 777, inheritOn: 601, inheritOff: 399 } });
  await h.workbench.refresh(); await h.workbench.action("matching-select");
  const html = h.workbench.render();
  assert.match(html, /完整筛选范围统计/); assert.match(html, /整批标签 <small>990\/1000/);
  assert.match(html, /空说明 777\/1000 项 · 继承开启 601 项 \/ 关闭 399 项/);
  assert.equal(h.calls.some(call => call.op === "prepare"), false);
  h.setSnapshot({ filteredSummary: undefined }); await h.workbench.refresh();
  assert.match(h.workbench.render(), /完整筛选范围统计尚未就绪/);
  assert.doesNotMatch(h.workbench.render(), /空说明 0\/3 项/);
});

test("tag-only item edits preserve inherited descriptions and untouched inheritance settings", async t => {
  const data = rows(2); data[0].annotation.description = "父文件夹说明"; data[0].annotation.automatic.description = "";
  const h = await opened(t, { rows: data });
  assert.match(h.workbench.render(), /data-wb-field="item-description"[^>]*>父文件夹说明<\/textarea>/);
  h.workbench.input("item-tags", "子文件标签"); await h.workbench.action("save-next");
  assert.deepEqual(h.calls.find(call => call.op === "draft").patch, { tags: ["子文件标签"] });
  assert.equal(h.calls.find(call => call.op === "prepare").useDrafts, true);
  await h.workbench.action("plan-close"); await h.workbench.action("next"); await h.workbench.action("save-next");
  const untouched = h.calls.filter(call => call.op === "draft").at(-1).patch;
  assert.equal(Object.hasOwn(untouched, "description"), false); assert.equal(Object.hasOwn(untouched, "inherit"), false);
});

test("save-and-next skips already-matching annotations without submitting an empty batch", async t => {
  const h = await opened(t, { call(input) { if (input.op === "prepare") throw Object.assign(Error("same"), { code: "SPACE_ANNOTATION_NO_CHANGES" }); } });
  await h.workbench.action("save-next");
  assert.match(h.workbench.render(), /所选项目已与目标一致，没有需要保存的变更/);
  assert.match(h.workbench.render(), new RegExp(`awb-file is-current[^>]*data-id="${h.data[1].id}"`));
  assert.equal(h.calls.some(call => call.op === "apply"), false);
  await h.workbench.action("prepare");
  assert.match(h.workbench.render(), /所选项目已与目标一致，没有需要保存的变更/);
});

for (const operation of ["batch", "suggestion"]) test(`${operation} apply refreshes untouched item drafts before continuous save`, async t => {
  const data = rows(2), after = structuredClone(data);
  after[0].annotation = { ...after[0].annotation, tags: ["仅部分标签", "批次新标签", "继承标签"], description: "最新人工说明", manual: { tags: ["仅部分标签", "批次新标签"], description: "最新人工说明" }, revision: 2 };
  const h = await opened(t, { rows: data, call: input => input.op === "apply" ? { job: { id: "synthetic-job", status: "complete", scanComplete: true, applied: data.map(row => row.id) }, items: after, total: 2, filteredTotal: 2 } : undefined });
  h.workbench.render(); // Opening an item creates the untouched editor baseline.
  await h.workbench.action("page-select");
  if (operation === "batch") { h.workbench.input("bulk-tagMode", "add"); h.workbench.input("bulk-tags", "批次新标签"); }
  await h.workbench.action(operation === "batch" ? "prepare" : "accept-suggestion");
  await h.workbench.action("plan-apply"); await h.workbench.action("clear");
  assert.match(h.workbench.render(), /class="awb-tag-token">仅部分标签<button[\s\S]*class="awb-tag-token">批次新标签<button/);
  await h.workbench.keydown({ key: "Enter", ctrlKey: true, preventDefault() {} });
  const patch = h.calls.filter(call => call.op === "draft").at(-1).patch;
  assert.deepEqual(patch.tags, ["仅部分标签", "批次新标签"]);
  assert.equal(Object.hasOwn(patch, "description"), false, "unchanged descriptions stay out of the patch");
  assert.match(h.workbench.render(), /最新人工说明/);
});

test("cross-page apply reloads the current page instead of replacing it with the mutation receipt page", async t => {
  const data = rows(21); let applied = false;
  const view = (offset, limit = 100) => ({ job: { id: "synthetic-job", status: applied ? "complete" : "ready", scanComplete: true, applied: applied ? [data[10].id] : [] }, items: data.slice(offset, offset + limit), total: data.length, filteredTotal: data.length, offset });
  const h = await opened(t, { rows: data, call(input) {
    if (input.op === "open") return view(0);
    if (input.op === "list") return view(input.offset, input.limit);
    if (input.op === "apply") { applied = true; data[10].annotation = { ...data[10].annotation, revision: 2, manual: { tags: ["跨页保存标签"], description: "已更新" } }; return view(0, 100); }
  } });
  await h.workbench.action("next-page"); await h.workbench.action("focus", { id: data[10].id }); h.workbench.render();
  await h.workbench.action("page-select"); h.workbench.input("bulk-tagMode", "add"); h.workbench.input("bulk-tags", "跨页保存标签");
  await h.workbench.action("prepare"); await h.workbench.action("plan-apply"); await h.workbench.action("clear");
  assert.equal(h.calls.filter(call => call.op === "list").at(-1).offset, 10);
  assert.match(h.workbench.render(), /11–20 \/ 21/);
  assert.match(h.workbench.render(), /class="awb-tag-token">跨页保存标签<button/);
  await h.workbench.action("save-next");
  assert.deepEqual(h.calls.filter(call => call.op === "draft").at(-1).patch.tags, ["跨页保存标签"]);
});

test("21 files can be paged, selected across pages and displayed five at a time", async t => {
  const data = rows(21);
  const h = await opened(t, { rows: data, call(input) {
    if (input.op === "list") return { items: data.slice(input.offset, input.offset + input.limit), total: data.length, filteredTotal: data.length, offset: input.offset };
  } });
  assert.match(h.workbench.render(), /1–10 \/ 21.*第 1 \/ 3 页/);
  await h.workbench.action("check", { id: data[0].id });
  h.workbench.input("item-tag-input", "跨页草稿");
  await h.workbench.action("next-page");
  assert.ok(h.calls.find(call => call.op === "draft" && call.patch.tags.includes("跨页草稿")));
  assert.match(h.workbench.render(), /11–20 \/ 21.*第 2 \/ 3 页/);
  await h.workbench.action("check", { id: data[10].id });
  h.workbench.input("page-size", "5"); await tick();
  assert.match(h.workbench.render(), /11–15 \/ 21.*第 3 \/ 5 页/);
  assert.match(h.workbench.render(), /已选 2 项/);
  await h.workbench.action("next-page"); await h.workbench.action("next-page");
  assert.match(h.workbench.render(), /21–21 \/ 21.*第 5 \/ 5 页/);
  assert.match(h.workbench.render(), /data-action="space-wb-next-page"[^>]*disabled/);
  await h.workbench.action("prepare");
  assert.deepEqual(h.calls.find(call => call.op === "prepare").selection, { ids: [data[0].id, data[10].id] });
});

test("changing the filter edits only a visible file when there is no explicit selection", async t => {
  const data = rows(2);
  const h = await opened(t, { rows: data, call(input) {
    if (input.op !== "list") return;
    const items = input.status === "confirmed" ? [] : [data[1]];
    return { items, filteredTotal: items.length, total: 2, offset: 0 };
  } });
  h.workbench.input("status", "confirmed"); await tick();
  h.workbench.input("item-description", "不可保存"); await h.workbench.action("prepare");
  assert.equal(h.calls.some(call => call.op === "draft" || call.op === "prepare"), false);
  h.workbench.input("status", "unannotated"); await tick();
  h.workbench.input("item-description", "当前文件"); await h.workbench.action("prepare");
  assert.deepEqual(h.calls.find(call => call.op === "prepare").selection.ids, [data[1].id]);
});

test("clearing an off-page selection moves the editor to the visible page", async t => {
  const data = rows(11);
  const h = await opened(t, { rows: data, call(input) {
    if (input.op === "list") return { items: data.slice(input.offset, input.offset + input.limit),
      total: data.length, filteredTotal: data.length, offset: input.offset };
  } });
  await h.workbench.action("check", { id: data[0].id });
  await h.workbench.action("next-page");
  await h.workbench.action("clear");
  h.workbench.input("item-description", "第十一份文件"); await h.workbench.action("prepare");
  assert.deepEqual(h.calls.find(call => call.op === "prepare").selection.ids, [data[10].id]);
});

test("saving at the end of a page moves to the first file of the next page", async t => {
  const data = rows(21);
  const savedJob = { id: "synthetic-job", status: "complete", scanComplete: true, applied: [data[9].id] };
  const h = await opened(t, { rows: data, call(input) {
    if (input.op === "apply") return { job: savedJob, items: data };
    if (input.op === "list") return { items: data.slice(input.offset, input.offset + input.limit), total: data.length, filteredTotal: data.length, offset: input.offset };
  } });
  await h.workbench.action("focus", { id: data[9].id });
  h.workbench.input("item-tag-input", "这一页的最后一个");
  await h.workbench.action("save-next"); await h.workbench.action("plan-apply");
  assert.match(h.workbench.render(), /11–20 \/ 21.*第 2 \/ 3 页/);
  assert.match(h.workbench.render(), new RegExp(`class="awb-file is-current[^"]*"[^>]*data-id="${data[10].id}"`));
  await h.workbench.action("previous");
  assert.match(h.workbench.render(), new RegExp(`class="awb-file is-current[^"]*"[^>]*data-id="${data[9].id}"`));
});

test("save-and-next follows the current position when a saved file leaves the filter", async t => {
  const data = rows(4); let applied = false;
  const h = await opened(t, { rows: data, call(input) {
    if (input.op === "apply") {
      applied = true;
      return { job: { id: "synthetic-job", status: "complete", scanComplete: true, applied: [data[1].id] }, items: data };
    }
    if (input.op === "list" && applied) return { items: [data[0], data[2], data[3]], total: 4, filteredTotal: 3, offset: 0 };
  } });
  await h.workbench.action("focus", { id: data[1].id });
  h.workbench.input("item-tag-input", "保存后退出待标注列表");
  await h.workbench.action("save-next"); await h.workbench.action("plan-apply");
  assert.match(h.workbench.render(), new RegExp(`awb-file is-current[^>]*data-id="${data[2].id}"`));
});

test("an unsuccessful apply keeps the working draft on the same file", async t => {
  const data = rows(2);
  const h = await opened(t, { rows: data, call(input) {
    if (input.op === "apply") return { job: { id: "synthetic-job", status: "paused", scanComplete: true, applied: [],
      error: "SPACE_ANNOTATION_STORAGE_FAILED" }, items: data };
  } });
  h.workbench.input("item-tag-input", "尚待保存的标签");
  await h.workbench.action("save-next"); await h.workbench.action("plan-apply");
  assert.match(h.workbench.render(), new RegExp(`awb-file is-current[^>]*data-id="${data[0].id}"`));
  assert.match(h.workbench.render(), /草稿或标注未能保存/);
});

test("a persisted edited draft survives concurrent revisions and requires explicit conflict resolution", async t => {
  const h = await opened(t);
  h.workbench.input("item-tags", "待提交草稿"); await h.workbench.action("next");
  const after = structuredClone(h.data); after[0].annotation.revision = 2; after[0].annotation.manual = { tags: ["别处新标签"], description: "别处新说明" };
  h.setSnapshot({ items: after }); await h.workbench.refresh(); await h.workbench.action("previous");
  assert.match(h.workbench.render(), /class="awb-tag-token">待提交草稿<button/); assert.match(h.workbench.render(), /最新标签：别处新标签/);
  assert.match(h.workbench.render(), /data-action="space-wb-save-next"[^>]*disabled/);
  await h.workbench.keydown({ key: "Enter", ctrlKey: true, preventDefault() {} });
  assert.equal(h.calls.some(call => call.op === "prepare"), false);
  await h.workbench.action("discard-draft");
  assert.match(h.workbench.render(), /class="awb-tag-token">别处新标签<button/);
  assert.deepEqual(h.calls.find(call => call.op === "refresh-item"), { op: "refresh-item", jobId: "synthetic-job", id: h.data[0].id, discardDraft: true });
});

test("a successfully applied single draft does not become a conflict or return stale fields", async t => {
  const data = rows(2), after = structuredClone(data);
  after[0].annotation = { ...after[0].annotation, revision: 2, manual: { tags: ["单项新标签"], description: "单项新说明" } };
  const h = await opened(t, { rows: data, call: input => input.op === "apply" ? { job: { id: "synthetic-job", status: "complete", scanComplete: true, applied: [data[0].id] }, items: after, total: 2, filteredTotal: 2 } : undefined });
  h.workbench.input("item-tags", "单项新标签"); h.workbench.input("item-description", "单项新说明");
  await h.workbench.action("save-next"); await h.workbench.action("plan-apply"); await h.workbench.action("previous");
  assert.match(h.workbench.render(), /class="awb-tag-token">单项新标签<button/);
  assert.doesNotMatch(h.workbench.render(), /本项未提交草稿仍保留/);
});

test("restored drafts retain their source revision and expose conflicts after restart", async t => {
  const data = rows(1); data[0].annotation.revision = 3;
  data[0].draft = { tags: ["重启前草稿"], description: "旧稿", inherit: true }; data[0].draftRevision = 2;
  const h = await opened(t, { rows: data });
  assert.match(h.workbench.render(), /class="awb-tag-token">重启前草稿<button/);
  assert.match(h.workbench.render(), /本项未提交草稿仍保留/);
  await h.workbench.action("save-next");
  assert.equal(h.calls.some(call => call.op === "draft" || call.op === "prepare"), false);
});

test("switching recent jobs flushes drafts to their original job and isolates task editors", async t => {
  const next = rows(1); next[0].draft = { tags: ["其他任务草稿"], description: "另一任务", inherit: true };
  const h = await opened(t, { call: input => input.op === "list" && input.jobId === "other-job" ? { job: { id: "other-job", status: "ready", scanComplete: true }, items: next, total: 1, filteredTotal: 1 } : undefined });
  h.setSnapshot({ resumableJobs: [{ id: "other-job", total: 1, status: "paused" }] }); await h.workbench.refresh();
  await h.workbench.action("left");
  assert.match(h.workbench.render(), /当前任务 · 3 项/);
  h.workbench.input("item-tags", "原任务新草稿"); h.workbench.input("job", "other-job"); await tick(); await tick();
  const draft = h.calls.find(call => call.op === "draft");
  assert.equal(draft.jobId, "synthetic-job"); assert.deepEqual(draft.patch.tags, ["原任务新草稿"]);
  assert.match(h.workbench.render(), /data-workbench-job="other-job"/);
  assert.match(h.workbench.render(), /class="awb-tag-token">其他任务草稿<button/);
});

test("scope navigation flushes a draft and can return to the parent range", async t => {
  const data = rows(2); data[1].kind = "folder";
  const h = await opened(t, { rows: data });
  h.workbench.input("item-description", "切换目录前保留");
  await h.workbench.action("scope-folder", { id: data[1].id, name: "合成子目录" });
  assert.ok(h.calls.find(call => call.op === "draft" && call.patch.description === "切换目录前保留"));
  await h.workbench.action("left");
  assert.match(h.workbench.render(), /data-action="space-wb-scope-parent"/);
  assert.equal(h.calls.filter(call => call.op === "open").at(-1).parent, data[1].id);
  await h.workbench.action("scope-parent");
  assert.equal(h.calls.filter(call => call.op === "open").at(-1).parent, id(9999));
});

test("space integrates toolbar, multiselection and folder entry without changing the original navigation", async () => {
  const events = new Map(), opens = [], data = rows(2), root = { addEventListener(type, handler) { events.set(type, handler); }, focus() {} };
  const folder = { ...data[0], kind: "folder", name: "合成目录" };
  const wb = { active: () => false, open: async value => opens.push(value), reset() {}, render: () => "", retainEditor: () => false };
  const window = { createSpaceAnnotationWorkbench: () => wb, wanxClient: { async action(name) { return { ok: true, value: name === "space.refresh" ? { phase: "ready", tasks: [], annotationAvailable: true } : { items: [folder, data[1]], breadcrumbs: [] } }; }, onSpaceState() {} } };
  vm.runInNewContext(spaceSource, { window, document: { querySelector: () => root, querySelectorAll: () => [], addEventListener() {} }, setInterval() {}, setTimeout, requestAnimationFrame: () => 1, cancelAnimationFrame() {}, queueMicrotask, URL, Blob, atob, TextDecoder });
  const space = window.wanxSpace; space.bind({ notesInAssistant: true, render() {} }); space.hostState({ route: "applications", canLaunchApplications: true, account: { accountId: "synthetic" }, activeDeviceId: "box" }); space.activate(true); await tick();
  assert.match(space.headerActions(), /data-action="space-workbench"[^>]*>标注工作台/);
  assert.doesNotMatch(space.headerActions(), /clipboard-toggle/);
  assert.doesNotMatch(space.view(), /data-action="space-workbench"/);
  space.bind({ render() {} });
  assert.match(space.headerActions(), /data-action="clipboard-toggle"/);
  assert.match(space.view(), /data-action="space-workbench"/);
  space.bind({ notesInAssistant: true, render() {} });
  const click = (name, item = "") => events.get("click")({ target: { closest: () => ({ dataset: { action: `space-${name}`, id: item } }) } });
  await click("workbench"); assert.equal(opens[0].parent, "");
  await click("select", data[1].id); await click("workbench-selected"); assert.deepEqual(Array.from(opens[1].ids), [data[1].id]);
  await click("workbench-folder", folder.id); assert.deepEqual(Array.from(opens[2].ids), [folder.id]);
  assert.equal(opens[2].recursive, false); assert.match(space.view(), /合成目录/);
});

test("default layout keeps scope settings secondary and has no AI tool tab", async t => {
  const h = await opened(t);
  let html = h.workbench.render();
  assert.match(html, /class="annotation-workbench[^"]*is-left-hidden/);
  assert.doesNotMatch(html, /data-tab="assistant"|AI 助手/);
  await h.workbench.action("left");
  html = h.workbench.render();
  assert.doesNotMatch(html, /class="annotation-workbench[^"]*is-left-hidden/);
  await h.workbench.action("left");
  assert.match(h.workbench.render(), /class="annotation-workbench[^"]*is-left-hidden/);
});

test("checking one noncurrent row targets that row's manual editor and save", async t => {
  const h = await opened(t);
  const target = h.data[2];
  await h.workbench.action("check", { id: target.id });
  h.workbench.input("item-tags", "只标注勾选项");
  await h.workbench.action("prepare");
  assert.deepEqual(h.calls.find(call => call.op === "prepare").selection, { ids: [target.id] });
  const draft = h.calls.find(call => call.op === "draft");
  assert.equal(draft.id, target.id); assert.deepEqual(draft.patch.tags, ["只标注勾选项"]);
  assert.equal(h.calls.some(call => call.op === "apply"), false);
});

test("failed draft flush prevents checkbox selection from silently moving to another row", async t => {
  let fail = true;
  const h = await opened(t, { call(input) {
    if (input.op === "draft" && fail) throw Object.assign(Error("synthetic storage failure"), { code: "SPACE_ANNOTATION_STORAGE_FAILED" });
  } });
  h.workbench.input("item-description", "切换前未保存说明");
  await h.workbench.action("check", { id: h.data[1].id });
  assert.match(h.workbench.render(), new RegExp(`awb-file is-current[^>]*data-id="${h.data[0].id}"`));
  await h.workbench.action("prepare");
  assert.equal(h.calls.some(call => call.op === "prepare"), false);
  fail = false;
  await h.workbench.action("check", { id: h.data[1].id });
  h.workbench.input("item-tags", "第二项标签");
  await h.workbench.action("prepare");
  assert.deepEqual(h.calls.find(call => call.op === "prepare").selection, { ids: [h.data[1].id] });
  assert.match(h.workbench.render(), /保存前核对/);
});

test("changing files waits for an autosave already in flight", async t => {
  let enter, reject;
  const started = new Promise(resolve => { enter = resolve; });
  const saving = new Promise((_resolve, refuse) => { reject = refuse; });
  const h = await opened(t, { call(input) {
    if (input.op === "draft") { enter(); return saving; }
  } });
  h.workbench.input("item-description", "还在写入的说明");
  await started;
  const switching = h.workbench.action("next");
  await tick();
  assert.match(h.workbench.render(), new RegExp(`awb-file is-current[^>]*data-id="${h.data[0].id}"`));
  reject(Object.assign(Error("synthetic failure"), { code: "SPACE_ANNOTATION_STORAGE_FAILED" }));
  await switching;
  assert.match(h.workbench.render(), /还在写入的说明/);
  assert.equal(h.calls.find(call => call.op === "draft").expectedRevision, 1);
});

test("basic batch fields apply only changed values and Cmd-Enter prepares the whole selection", async t => {
  const h = await opened(t);
  await h.workbench.action("check", { id: h.data[0].id }); await h.workbench.action("check", { id: h.data[1].id });
  const html = h.workbench.render();
  assert.match(html, /data-wb-field="bulk-tag-input"/); assert.match(html, /data-wb-field="bulk-description"/);
  await h.workbench.action("prepare");
  assert.deepEqual(h.calls.find(call => call.op === "prepare").change, { tagMode: "keep", tags: [], descriptionMode: "keep", description: "" });
  await h.workbench.action("plan-close");
  h.workbench.input("bulk-tags", "新增共享标签"); h.workbench.input("bulk-description", "只填空说明");
  await h.workbench.keydown({ key: "Enter", metaKey: true, preventDefault() {}, target: { closest() { return true; } } });
  const prepared = h.calls.filter(call => call.op === "prepare").at(-1);
  assert.deepEqual(prepared.selection, { ids: [h.data[0].id, h.data[1].id] });
  assert.deepEqual(prepared.change, { tagMode: "add", tags: ["新增共享标签"], descriptionMode: "fill-empty", description: "只填空说明" });
  assert.equal(Object.hasOwn(prepared, "useDrafts"), false);
  assert.equal(h.calls.some(call => call.op === "apply"), false);
  await h.workbench.keydown({ key: "Enter", ctrlKey: true, preventDefault() {} });
  assert.equal(h.calls.filter(call => call.op === "apply").length, 1);
});

test("restoring a paused legacy generation job cannot resume AI through the manual workbench", async t => {
  const h = await opened(t);
  h.setSnapshot({ job: { id: "synthetic-job", status: "paused", activity: "suggest", scanned: 3, scanComplete: true, total: 3 } });
  await h.workbench.refresh();
  await h.workbench.action("resume");
  assert.equal(h.calls.some(call => ["models", "suggest", "resume"].includes(call.op)), false);
  assert.doesNotMatch(h.workbench.render(), /data-tab="assistant"|AI 助手/);
});


test("reducing a checked batch to one item retargets the editor and its save", async t => {
  const h = await opened(t);
  await h.workbench.action("check", { id: h.data[0].id });
  await h.workbench.action("check", { id: h.data[1].id });
  await h.workbench.action("check", { id: h.data[1].id });
  h.workbench.input("item-tags", "只修改剩余项");
  await h.workbench.action("prepare");
  assert.deepEqual(h.calls.find(call => call.op === "prepare").selection, { ids: [h.data[0].id] });
  assert.equal(h.calls.find(call => call.op === "draft").id, h.data[0].id);
});

test("the page checkbox clears whole-filter selection without silently keeping the visible page", async t => {
  const h = await opened(t);
  await h.workbench.action("matching-select");
  await h.workbench.action("check", { id: h.data[1].id });
  assert.match(h.workbench.render(), /已选全部筛选结果 3 项/);
  await h.workbench.action("page-select");
  assert.doesNotMatch(h.workbench.render(), /已选全部筛选结果|已选 3 项/);
  await h.workbench.action("prepare");
  assert.deepEqual(h.calls.find(call => call.op === "prepare").selection, { ids: [h.data[0].id] });
});

test("using a manual scheme adds tags to the current draft and never submits annotations", async t => {
  const h = await opened(t);
  await h.workbench.action("tab", { tab: "schemes" }); h.workbench.input("scheme", "synthetic-scheme");
  await h.workbench.action("use-scheme");
  const draft = h.calls.find(call => call.op === "draft");
  assert.equal(draft.id, h.data[0].id); assert.deepEqual(draft.patch.tags, ["仅部分标签", "客户"]);
  assert.equal(draft.patch.tags.includes("继承标签"), false);
  assert.equal(h.calls.some(call => ["apply", "suggest", "models"].includes(call.op)), false);
  assert.match(h.workbench.render(), /已带入方案/);
});


test("keyboard activation of buttons and details never toggles a file selection", async t => {
  const h = await opened(t);
  const handled = await h.workbench.keydown({ key: " ", preventDefault() { throw Error("native key was intercepted"); }, target: { closest(selector) { return selector.includes("summary"); } } });
  assert.equal(handled, false);
  assert.doesNotMatch(h.workbench.render(), /已选 1 项/);
});

test("switching restored jobs clears previous batch replacement modes and scheme inputs", async t => {
  const h = await opened(t);
  h.workbench.input("bulk-tagMode", "replace"); h.workbench.input("bulk-tags", "前一任务标签");
  h.workbench.input("bulk-descriptionMode", "replace"); h.workbench.input("bulk-description", "前一任务说明");
  await h.workbench.action("tab", { tab: "schemes" }); h.workbench.input("scheme", "synthetic-scheme");
  h.workbench.input("job", "another-job"); await tick();
  await h.workbench.action("page-select"); await h.workbench.action("prepare");
  assert.deepEqual(h.calls.find(call => call.op === "prepare").change, { tagMode: "keep", tags: [], descriptionMode: "keep", description: "" });
  assert.doesNotMatch(h.workbench.render(), /前一任务标签|前一任务说明/);
});

test("an already-running legacy generator can be stopped without reopening an assistant panel", async t => {
  const h = await opened(t);
  h.setSnapshot({ job: { id: "synthetic-job", status: "suggesting", activity: "suggest", scanComplete: true, scanned: 3 } });
  await h.workbench.refresh();
  assert.match(h.workbench.render(), /停止生成/);
  await h.workbench.action("cancel");
  assert.equal(h.calls.some(call => call.op === "cancel"), true);
  assert.equal(h.calls.some(call => ["models", "suggest"].includes(call.op)), false);
});
