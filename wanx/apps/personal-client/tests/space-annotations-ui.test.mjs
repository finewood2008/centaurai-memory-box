import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../local-ui/renderer/personal-space.js", import.meta.url), "utf8");
const tick = () => new Promise(resolve => setImmediate(resolve));
const file = { id: "a".repeat(32), parent: "", name: "neutral.txt", kind: "file", size: 10, modified: 0 };
const folder = { id: "b".repeat(32), parent: "", name: "Project", kind: "folder", size: 0, modified: 0 };
const annotation = { revision: 3, tags: ["manual-topic", "inherited-topic"], description: "Effective description", inherit: true,
  automatic: { tags: ["automatic-topic"], description: "Rule description" }, manual: { tags: ["manual-topic"], description: "Reviewed description" },
  provenance: [{ tag: "inherited-topic", source: "inherited", itemId: folder.id }], needsReview: true };
const connected = box => ({ route: "applications", canLaunchApplications: true, account: { accountId: "owner" }, activeDeviceId: box });
const ok = value => ({ ok: true, value });
function harness(options = {}) {
  const events = new Map(), calls = []; let onState;
  const root = { focus() {}, addEventListener: (type, handler) => events.set(type, handler) };
  const window = { wanxClient: {
    async action(action, input) {
      calls.push([action, input]);
      const custom = await options.action?.(action, input);
      if (custom !== undefined) return custom;
      if (action === "space.refresh") return ok({ phase: "ready", tasks: [] });
      if (action === "space.annotation") return ok(structuredClone(annotation));
      if (action === "space.set-annotation" || action === "space.auto-annotate") return ok({ ...annotation, revision: 4, needsReview: false });
      return ok({ items: [{ ...file, annotation }, folder], breadcrumbs: [] });
    },
    onSpaceState: handler => { onState = handler; },
  }, ...(options.readOnly ? { wanxWorkspaces: {
    current: () => ({ writable: false, name: "Read only" }), root: () => "", spaces: () => [], blocked: () => false,
    storageScope() {}, refresh: async () => {}, reconcile: async value => value, observe: async () => {}, reset() {},
    sidebar: () => "", footerNavigation: () => "", navigation: () => "", menuView: () => "", dialogView: () => "", bind() {},
  } } : {}) };
  vm.runInNewContext(source, { window, document: {
    querySelector: selector => options.nodes?.get(selector) || root, querySelectorAll: () => [], addEventListener() {},
  }, setInterval() {}, setTimeout, requestAnimationFrame: () => 1, cancelAnimationFrame() {}, queueMicrotask, URL, Blob, atob, TextDecoder });
  const space = window.wanxSpace; space.bind({ render() {} });
  return { space, calls, emit: value => onState(value),
    event: (type, value) => events.get(type)(value),
    click: (kind, id = "", extra = {}) => events.get("click")({ target: { closest: () => ({ dataset: { action: `space-${kind}`, id, ...extra } }) } }),
    input: (id, value) => events.get("input")({ target: { id, value } }),
    submit: () => events.get("submit")({ preventDefault() {}, target: { dataset: { form: "space-annotation" } } }),
  };
}
async function ready(options) {
  const h = harness(options); h.space.hostState(connected("box")); h.space.activate(true); await tick(); return h;
}

test("annotation dialog exposes own fields, inheritance source and review status for files and folders", async () => {
  const h = await ready();
  await h.click("annotation", file.id);
  let html = h.space.view();
  assert.match(html, /本项标签/); assert.match(html, /value="manual-topic"/);
  assert.doesNotMatch(html, /value="manual-topic，inherited-topic"/);
  assert.match(html, /automatic-topic/); assert.match(html, /规则分析/);
  assert.match(html, /继承来源/); assert.match(html, new RegExp(folder.id));
  assert.match(html, /确认复核并保存/);
  await h.click("dialog-close"); await h.click("annotation", folder.id);
  assert.match(h.space.view(), /标签与说明 · Project/);
});

test("manual save submits observed revision, explicit empty tags and inheritance preference", async () => {
  const h = await ready(); await h.click("annotation", file.id);
  h.input("space-annotation-tags", ""); h.input("space-annotation-description", "Human description");
  h.event("change", { target: { id: "space-annotation-inherit", checked: false } });
  h.submit(); await tick();
  const input = h.calls.find(([action]) => action === "space.set-annotation")[1];
  assert.equal(input.id, file.id); assert.equal(input.expectedRevision, 3); assert.equal(input.space_id, "personal");
  assert.deepEqual(Array.from(input.tags), []); assert.equal(input.description, "Human description");
  assert.equal(input.inherit, false); assert.equal(input.reviewed, true);
});

test("concurrent and disconnected saves retain drafts and require explicit reload", async () => {
  let fail = "SPACE_ANNOTATION_CONFLICT";
  const h = await ready({ action: action => action === "space.set-annotation" ? { ok: false, code: fail } : undefined });
  await h.click("annotation", file.id); h.input("space-annotation-tags", "unsaved-value");
  h.submit(); await tick();
  assert.match(h.space.view(), /标注已被其他操作更新/); assert.match(h.space.view(), /value="unsaved-value"/);
  fail = "ECONNRESET"; h.submit(); await tick();
  assert.match(h.space.view(), /网络连接中断/); assert.match(h.space.view(), /value="unsaved-value"/);
  assert.equal(h.calls.filter(([action]) => action === "space.annotation").length, 1);
  await h.click("annotation-reload");
  assert.match(h.space.view(), /value="manual-topic"/);
});

test("rerunning automatic annotation preserves unsaved human fields and reset is explicit", async () => {
  const h = await ready(); await h.click("annotation", file.id);
  h.input("space-annotation-tags", "work-in-progress");
  await h.click("annotation-auto");
  assert.match(h.space.view(), /value="work-in-progress"/);
  await h.click("annotation-reset");
  const reset = h.calls.find(([action]) => action === "space.set-annotation")[1];
  assert.equal(reset.reset, true); assert.equal(reset.expectedRevision, 4);
});

test("read-only spaces can inspect annotations but cannot submit edits or automation", async () => {
  const h = await ready({ readOnly: true }); await h.click("annotation", file.id);
  const html = h.space.view();
  assert.match(html, /此空间为只读/); assert.match(html, /id="space-annotation-tags"[^>]*disabled/);
  assert.doesNotMatch(html, /data-action="space-annotation-auto"|data-action="space-annotation-reset"|type="submit"/);
  h.submit(); await tick(); await h.click("annotation-auto");
  assert.equal(h.calls.some(([action]) => ["space.set-annotation", "space.auto-annotate"].includes(action)), false);
});

test("explicitly unavailable annotation capability hides file menus and subtree search without calling unknown IPC", async () => {
  for (const readOnly of [false, true]) {
    const h = await ready({ readOnly, action: action => action === "space.refresh" ? ok({ phase: "ready", tasks: [], annotationAvailable: false }) : undefined });
    await h.click("more", file.id);
    assert.doesNotMatch(h.space.view(), /data-action="space-annotation"/);
    h.input("space-search", "topic");
    assert.doesNotMatch(h.space.view(), /data-action="space-annotation-search"/);
    await h.click("annotation", file.id); await h.click("annotation-search");
    assert.equal(h.calls.some(([action]) => ["space.annotation", "space.search-annotations"].includes(action)), false);
  }
});

test("losing annotation capability closes an existing editor and blocks further writes", async () => {
  const h = await ready(); await h.click("annotation", file.id);
  h.emit({ accountId: "owner", boxId: "box", phase: "ready", tasks: [], annotationAvailable: false });
  assert.doesNotMatch(h.space.view(), /id="space-annotation-form"/);
  h.submit(); await tick();
  assert.equal(h.calls.some(([action]) => action === "space.set-annotation"), false);
});

test("list filtering consumes tags and descriptions while subtree search reports limits", async () => {
  const h = await ready({ action: action => action === "space.search-annotations" ? ok({ items: [{ ...file, name: "nested-file.txt", annotation }], scanned: 1200, truncated: true }) : undefined });
  h.input("space-search", "inherited-topic");
  assert.match(h.space.view(), /neutral.txt/); assert.doesNotMatch(h.space.view(), /data-entry-id="bbbb/);
  h.input("space-search", "Effective description"); assert.match(h.space.view(), /neutral.txt/);
  await h.click("annotation-search");
  const html = h.space.view();
  assert.match(html, /搜索当前目录及子文件夹/); assert.match(html, /未覆盖全部内容/); assert.match(html, /nested-file.txt/);
  const input = h.calls.find(([action]) => action === "space.search-annotations")[1];
  assert.equal(input.query, "Effective description"); assert.equal(input.parent, "");
});

test("annotation text is escaped and late account responses cannot reopen private dialogs", async () => {
  let finish;
  const h = await ready({ action: action => action === "space.annotation" ? new Promise(resolve => { finish = resolve; }) : undefined });
  const opening = h.click("annotation", file.id); await tick();
  h.space.hostState({ ...connected("box-b"), account: { accountId: "another" } });
  finish(ok({ ...annotation, manual: { tags: ['"><img src=x>'], description: "<script>private</script>" } }));
  await opening;
  assert.doesNotMatch(h.space.view(), /private|<script>|标签与说明 · neutral/);
  const escaped = await ready({ action: action => action === "space.annotation" ? ok({ ...annotation, manual: { tags: ['"><img src=x>'], description: "<script>private</script>" } }) : undefined });
  await escaped.click("annotation", file.id);
  assert.match(escaped.space.view(), /&lt;script&gt;private&lt;\/script&gt;/); assert.doesNotMatch(escaped.space.view(), /<script>|<img src=x>/);
});

test("annotation form preserves IME composition and keeps its editor mounted on broadcasts", async () => {
  const nodes = new Map([["#space-annotation-tags", { dataset: { editorKey: `annotation:${file.id}:3` } }]]);
  const h = await ready({ nodes }); await h.click("annotation", file.id);
  assert.equal(h.space.retainEditor(), true);
  h.emit({ accountId: "owner", boxId: "box", phase: "ready", tasks: [] });
  assert.equal(h.space.retainEditor(), true);
  h.event("compositionstart", { target: { id: "space-annotation-tags" } });
  h.input("space-annotation-tags", "draft"); h.submit(); await tick();
  assert.equal(h.calls.some(([action]) => action === "space.set-annotation"), false);
  h.event("compositionend", { target: { id: "space-annotation-tags", value: "完成标签" } });
  h.submit(); await tick();
  assert.equal(h.calls.find(([action]) => action === "space.set-annotation")[1].tags[0], "完成标签");
});

test("completed uploads with pending annotation stay visible and retry through the transfer operation", async () => {
  const h = await ready();
  const task = { id: "c".repeat(32), name: "uploaded.txt", kind: "file", direction: "upload", phase: "complete", offset: 10, size: 10,
    annotationPending: true, annotationError: "SPACE_ANNOTATION_READ_ONLY", annotationRetryAt: Date.now() + 15000 };
  h.emit({ accountId: "owner", boxId: "box", phase: "ready", tasks: [task] });
  let html = h.space.view();
  assert.match(html, /文件已上传，标注待完成/); assert.match(html, /此空间为只读，不能修改标注/);
  assert.match(html, /秒后自动重试/); assert.match(html, /data-command="retry-annotations"/);
  assert.match(html, /1 项待完成/); assert.doesNotMatch(html, /class="space-transfer is-complete"/);
  await h.click("transfers-toggle"); html = h.space.view();
  assert.match(html, />传输 · 标注待完成</);
  await h.click("transfers-toggle"); await h.click("transfer", task.id, { command: "retry-annotations" });
  const retry = h.calls.find(([action]) => action === "space.transfer")[1];
  assert.equal(retry.action, "retry-annotations"); assert.equal(retry.id, task.id);
  h.emit({ accountId: "owner", boxId: "box", phase: "ready", tasks: [{ ...task, annotationPending: false, annotationError: null, annotationRetryAt: null }] });
  assert.doesNotMatch(h.space.view(), /文件已上传，标注待完成|data-command="retry-annotations"|传输 · 标注待完成/);
});
