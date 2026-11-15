import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";

const window = {};
vm.runInNewContext(await readFile(new URL("../local-ui/renderer/help.js", import.meta.url), "utf8"), { window });
const data = { categories: [{ id: 1, name: "账号", items: [{ id: 11, question: "如何登录 <script>？", answer: "第一步" }] }] };
function setup(reply = async () => ({ received: true })) {
  const calls = [];
  const view = window.createHelpView({ changed() {}, request: async (action, input) => {
    calls.push({ action, input }); return action === "help.faq" ? { data } : reply(action, input);
  } });
  return { view, calls };
}

test("feedback entry exists before loading, on empty FAQ, on GET failure and search with no results", async () => {
  for (const reply of [async () => ({ data }), async () => ({ data: { categories: [] } }),
    async () => { throw Object.assign(new Error(), { code: "FAQ_UNAVAILABLE" }); }]) {
    const view = window.createHelpView({ changed() {}, request: reply });
    assert.match(view.render(), /data-action="help-feedback-open"/);
    view.visible(true); await view.refresh(); view.action("help-search", { query: "没有匹配的搜索词" });
    view.action("help-feedback-open");
    assert.match(view.render(), /data-form="help-feedback"/); assert.match(view.render(), /请勿填写密码/);
  }
});

test("feedback text/contact survive filtering, refresh, close/open, while search never becomes submitted text", async () => {
  const { view, calls } = setup(); view.visible(true); await view.refresh();
  view.action("help-feedback-open", { id: "11" });
  view.input("content", '仍然失败 <img src=x onerror="alert(1)">'); view.input("contact", "me@example.test");
  view.action("help-search", { query: "搜索词不上传" }); view.action("help-category", { id: "1" });
  await view.refresh(); view.visible(false); view.visible(true); view.action("help-feedback-close"); view.action("help-feedback-open");
  const html = view.render();
  assert.match(html, /&lt;img src=x/); assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /me@example.test/); assert.match(html, /关联问题：如何登录 &lt;script&gt;/);
  await view.action("help-feedback-submit");
  const sent = calls.find(row => row.action === "help.feedback").input;
  assert.equal(sent.content, '仍然失败 <img src=x onerror="alert(1)">'); assert.equal(sent.itemId, 11);
  assert.deepEqual(Object.keys(sent).sort(), ["categoryId", "contact", "content", "itemId"]);
  assert.doesNotMatch(JSON.stringify(sent), /搜索词不上传|questionSnapshot|client|account/);
  assert.match(view.render(), /反馈已收到/); assert.doesNotMatch(view.render(), /data-form="help-feedback"/);
  view.action("help-feedback-open"); assert.doesNotMatch(view.render(), /me@example.test/);
});

test("association can be removed without discarding draft content", async () => {
  const { view, calls } = setup(); view.visible(true); await view.refresh();
  view.action("help-feedback-open", { id: "11" }); view.input("content", "这个问题还没有解决");
  view.action("help-feedback-unlink");
  assert.doesNotMatch(view.render(), /关联问题：/);
  await view.action("help-feedback-submit");
  assert.equal(calls.at(-1).input.itemId, null); assert.equal(calls.at(-1).input.categoryId, null);
});

test("only one POST is issued while pending; an edited new draft survives the old success", async () => {
  let finish;
  const { view, calls } = setup(() => new Promise(resolve => { finish = resolve; }));
  view.action("help-feedback-open"); view.input("content", "第一条");
  const pending = view.action("help-feedback-submit"); view.action("help-feedback-submit");
  assert.match(view.render(), /aria-busy="true" disabled/);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 1);
  view.input("content", "新问题 <script>"); view.input("contact", "新联系方式");
  finish({ received: true }); await pending;
  assert.match(view.render(), /上一条反馈已收到/); assert.match(view.render(), /新问题 &lt;script&gt;/);
  assert.match(view.render(), /新联系方式/); assert.match(view.render(), /data-form="help-feedback"/);
});

for (const [code, expected] of [["FAQ_FEEDBACK_RATE_LIMITED", "倒计时结束后再试"], ["FAQ_FEEDBACK_UNAVAILABLE", "内容已保留"],
  ["FAQ_FEEDBACK_IDEMPOTENCY_CONFLICT", "重新提交"], ["FAQ_FEEDBACK_TOO_LARGE", "精简后重试"],
  ["FAQ_FEEDBACK_INVALID_RESPONSE", "返回结果无法确认"], ["ACCOUNT_NETWORK_ERROR", "检查电脑网络"]]) {
  test(`${code} keeps draft open and uses a fixed safe message`, async () => {
    const { view } = setup(() => { throw Object.assign(new Error("private detail"), { code }); });
    view.action("help-feedback-open"); view.input("content", "尚未解决的内容");
    await view.action("help-feedback-submit");
    assert.match(view.render(), new RegExp(expected)); assert.match(view.render(), /尚未解决的内容/);
    assert.match(view.render(), /data-form="help-feedback"/); assert.doesNotMatch(view.render(), /private detail/);
  });
}

test("invalid success cannot clear a draft; empty/oversize input never sends", async () => {
  const { view, calls } = setup(() => ({})); view.action("help-feedback-open");
  await view.action("help-feedback-submit"); assert.equal(calls.length, 0);
  view.input("content", "x".repeat(2001)); await view.action("help-feedback-submit"); assert.equal(calls.length, 0);
  view.input("content", "有效草稿"); await view.action("help-feedback-submit");
  assert.match(view.render(), /返回结果无法确认/); assert.match(view.render(), /有效草稿/);
});
