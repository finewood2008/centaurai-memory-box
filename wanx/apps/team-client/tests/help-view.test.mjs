import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";

const window = {};
vm.runInNewContext(await readFile(new URL("../local-ui/renderer/help.js", import.meta.url), "utf8"), { window });
const content = () => ({ version: "faq-v1", updatedAt: null, categories: [
  { id: 1, name: "登录 <script>", items: [{ id: 11, question: '如何登录 <img src=x onerror="alert(1)">？', answer: '第一步\n第二步 <script>alert(1)</script>' }] },
  { id: 2, name: "设备", items: [{ id: 21, question: "如何连接盒子？", answer: "打开蓝牙。" }] },
] });
const flush = () => new Promise(resolve => setImmediate(resolve));
function setup(request) {
  const calls = [];
  const view = window.createHelpView({ changed() {}, request: async (action, input) => { calls.push({ action, input }); return request(calls.length, input); } });
  view.visible(true);
  return { view, calls };
}

test("escapes every server string, preserves plain-text newlines, filters locally", async () => {
  const { view, calls } = setup(() => ({ data: content(), etag: 'W/"faq-v1"' }));
  await view.refresh();
  const html = view.render();
  assert.doesNotMatch(html, /<script>|<img src=x/);
  assert.match(html, /&lt;script&gt;/); assert.match(html, /第一步\n第二步/);
  view.action("help-category", { id: "2" });
  assert.doesNotMatch(view.render(), /如何登录/); assert.match(view.render(), /如何连接盒子/);
  view.action("help-clear"); view.action("help-search", { query: "第一步" });
  assert.match(view.render(), /共 1 个问题/); assert.doesNotMatch(view.render(), /如何连接盒子/);
  view.action("help-question", { id: "11" });
  assert.match(view.render(), /id="faq-answer-11" hidden/);
  assert.equal(calls.length, 1);
});

test("refresh always requests, sends saved ETag and retains data on 304 and failure", async () => {
  const { view, calls } = setup(index => {
    if (index === 1) return { data: content(), etag: 'W/"faq-v1"' };
    if (index === 2) return { notModified: true, etag: null };
    throw Object.assign(new Error(), { code: "FAQ_RATE_LIMITED" });
  });
  await view.refresh(); await view.refresh();
  assert.equal(calls[1].input.etag, 'W/"faq-v1"');
  assert.match(view.render(), /如何登录/);
  await view.refresh();
  assert.match(view.render(), /查看得有些频繁/); assert.match(view.render(), /上次获取/);
  assert.match(view.render(), /如何登录/);
});

test("empty replacement clears old content and invalid response retains valid data", async () => {
  const { view } = setup(index => index === 1 ? { data: content() } : index === 2 ? { data: { categories: [null] } } : { data: { categories: [] } });
  await view.refresh(); await view.refresh();
  assert.match(view.render(), /如何登录/); assert.match(view.render(), /帮助内容暂时无法读取/);
  await view.refresh();
  assert.match(view.render(), /帮助内容正在整理中/); assert.doesNotMatch(view.render(), /如何登录/);
});

test("deduplicates refresh, ignores late responses after leaving and recovers an unexpected 304", async () => {
  let resolve;
  const { view, calls } = setup(index => index === 1 ? new Promise(done => { resolve = done; }) : index === 2 ? { notModified: true } : { data: content() });
  const first = view.refresh(); view.refresh(); await flush();
  assert.equal(calls.length, 1);
  view.visible(false); view.visible(true);
  await view.refresh();
  assert.equal(calls.length, 3); assert.match(view.render(), /如何登录/);
  resolve({ data: { categories: [] } }); await first;
  assert.match(view.render(), /如何登录/);
});

test("initial network error has no fictional offline content", async () => {
  const { view } = setup(() => { throw Object.assign(new Error(), { code: "ACCOUNT_NETWORK_ERROR" }); });
  await view.refresh();
  assert.match(view.render(), /检查电脑网络/); assert.doesNotMatch(view.render(), /上次获取/);
});
