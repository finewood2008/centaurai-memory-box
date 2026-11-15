import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
const window = {};
vm.runInNewContext(await readFile(new URL("../local-ui/renderer/help.js", import.meta.url), "utf8"), { window });
const content = () => ({ categories: [
  { id: 71, name: " 添加盒子、发现与配网 ", items: [{ id: 701, question: "扫描不到盒子", answer: "打开蓝牙" }] },
  { id: 93, name: "盒子连接与网络恢复", items: [{ id: 903, question: "无法连接", answer: "检查网络" }] },
] });
function setup(request = async () => ({ data: content() })) {
  const view = window.createHelpView({ request, changed() {} });
  view.visible(true); return view;
}
test("scene entry selects exact published name and runtime ID, clears search and opens the first answer", async () => {
  const view = setup(); view.open({ scene: "box_setup" }); await view.refresh();
  assert.match(view.render(), /data-id="71" aria-pressed="true"/);
  assert.match(view.render(), /id="faq-answer-701" >打开蓝牙/);
  assert.doesNotMatch(view.render(), /faq-answer-903/);
  view.action("help-search", { query: "不相关" });
  view.open({ scene: "box_connection" });
  assert.match(view.render(), /data-id="93" aria-pressed="true"/);
  assert.match(view.render(), /value="" placeholder="输入问题关键词/);
  view.open(); assert.match(view.render(), /data-id="all" aria-pressed="true"/);
});
test("missing, empty, ambiguous and renamed categories fall back to all without fuzzy matching", async () => {
  for (const categories of [[], [{ ...content().categories[0], items: [] }],
    [content().categories[0], { ...content().categories[0], id: 72 }],
    [{ ...content().categories[0], name: "添加盒子" }]]) {
    const view = setup(async () => ({ data: { categories } }));
    view.open({ scene: "box_setup" }); await view.refresh();
    assert.match(view.render(), /相关分类暂未提供，已展示全部问题/);
    assert.doesNotMatch(view.render(), /class="faq-category active" data-action="help-category" data-id="71"/);
  }
});
test("304 keeps scene selection, a new payload resolves changed IDs, and manual choice wins over late refresh", async () => {
  let reply = { data: content() };
  const view = setup(async () => reply);
  await view.refresh(); view.open({ scene: "box_setup" });
  reply = { notModified: true }; await view.refresh();
  assert.match(view.render(), /data-id="71" aria-pressed="true"/);
  reply = { data: content() }; reply.data.categories[0].id = 107;
  await view.refresh(); assert.match(view.render(), /data-id="107" aria-pressed="true"/);
  let release; reply = new Promise(resolve => { release = resolve; });
  const pending = view.refresh(); await Promise.resolve();
  view.action("help-category", { id: "93" });
  release({ data: content() }); await pending;
  assert.match(view.render(), /data-id="93" aria-pressed="true"/);
});
test("late responses after closing cannot replace the next scene or its result", async () => {
  let release;
  const view = setup(() => new Promise(resolve => { release = resolve; }));
  view.open({ scene: "box_setup" });
  const first = view.refresh(); await Promise.resolve(); const old = release;
  view.visible(false); view.visible(true); view.open({ scene: "box_connection" });
  const next = view.refresh(); await Promise.resolve(); release({ data: content() }); await next;
  old({ data: { categories: [] } }); await first;
  assert.match(view.render(), /data-id="93" aria-pressed="true"/);
});
test("drawer reuses feedback and draft, renders an escaped return label, and retains cached data on failure", async () => {
  let fail = false;
  const view = setup(async () => { if (fail) throw Error("FAQ_UNAVAILABLE"); return { data: content() }; });
  await view.refresh(); view.open({ scene: "box_setup" });
  view.action("help-feedback-open"); view.input("content", "仍有问题");
  assert.match(view.render({ drawer: true }), /关闭帮助/);
  assert.match(view.render({ drawer: true }), /仍有问题<\/textarea>/);
  fail = true; await view.refresh(); assert.match(view.render(), /扫描不到盒子/);
  view.open(); assert.match(view.render({ backLabel: "返回<盒子>" }), /返回&lt;盒子&gt;/);
  assert.match(view.render(), /仍有问题<\/textarea>/);
});
