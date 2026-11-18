import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(new URL("../ui/app.js", import.meta.url), "utf8");
const renderSource = source.slice(source.indexOf("function renderGraph() {"), source.indexOf("function renderDetails(g) {"));
const warehouseSource = source.slice(source.indexOf("function currentWarehouse() {"), source.indexOf("function warehouseStatus(w) {"));

function render({ warehouses = [], warehouseId = "selected", graphError = null, nodes = [], showIsolated = true } = {}) {
  const elements = new Map();
  const $ = selector => {
    if (!elements.has(selector)) elements.set(selector, { value: "", dataset: {}, classList: { toggle() {} } });
    return elements.get(selector);
  };
  const state = { warehouses, warehouseId, graphError, showIsolated, ready: true, graph: { nodes, edges: [] } };
  vm.runInNewContext(`${renderSource}\n${warehouseSource}\nrenderGraph();`, {
    state, $, visibleGraph: () => ({ nodes: [], edges: [] }),
    errorText: error => error.message, document: { querySelectorAll: () => [] },
    explorer: { enabled: () => false }, transformScene() {}, renderDetails() {}, canCreateWarehouse: () => true,
  });
  const empty = $("#graph-empty");
  const title = $("#graph-empty-title").textContent;
  const message = $("#graph-empty-message").textContent;
  const action = $("#graph-empty-action");
  assert.equal(action.hidden, !action.dataset.action);
  return { ...empty, title, message, textContent: [title, message, action.textContent].filter(Boolean).join(" ") };
}

test("native graph with imported materials explains missing knowledge and directs to processing tasks", () => {
  const empty = render({ warehouses: [{ id: "selected", document_count: 21, active_jobs: 0 }] });
  assert.equal(empty.hidden, false);
  assert.match(empty.textContent, /21 份材料/);
  assert.match(empty.textContent, /知识图谱尚未生成/);
  assert.match(empty.textContent, /任务中心/);
  assert.doesNotMatch(empty.textContent, /第一份|建立.*数据仓/);
});

test("native graph explains active processing without asking users to import again", () => {
  const empty = render({ warehouses: [{ id: "selected", document_count: 21, active_jobs: 2 }] });
  assert.match(empty.textContent, /21 份材料/);
  assert.match(empty.textContent, /正在处理/);
  assert.match(empty.textContent, /任务中心/);
  assert.doesNotMatch(empty.textContent, /第一份/);
});

test("native empty message uses only the selected warehouse's material count", () => {
  const empty = render({ warehouses: [
    { id: "other", document_count: 21 },
    { id: "selected", document_count: 0 },
  ] });
  assert.match(empty.textContent, /第一份资料/);
  assert.doesNotMatch(empty.textContent, /21/);
});

test("processing before material statistics arrive never suggests another first import", () => {
  const empty = render({ warehouses: [{ id: "selected", document_count: 0, active_jobs: 1 }] });
  assert.match(empty.textContent, /正在处理/);
  assert.doesNotMatch(empty.textContent, /第一份/);
});

test("unknown selected warehouse statistics never claim no materials", () => {
  const empty = render({ warehouses: [{ id: "other", document_count: 21 }] });
  assert.match(empty.textContent, /任务中心/);
  assert.doesNotMatch(empty.textContent, /第一份|21/);
});

test("native graph errors remain more specific than the material processing message", () => {
  const empty = render({ warehouses: [{ id: "selected", document_count: 21 }], graphError: { message: "知识图谱加载失败，请重试" } });
  assert.equal(empty.message, "知识图谱加载失败，请重试");
});

test("an unmatched graph filter stays distinct from knowledge not yet generated", () => {
  const empty = render({ warehouses: [{ id: "selected", document_count: 21 }], nodes: [{ id: "existing" }] });
  assert.equal(empty.title, "没有找到匹配的实体");
});

test("connected-only graph filtering keeps the new isolated-node guidance", () => {
  const empty = render({ warehouses: [{ id: "selected", document_count: 21 }], nodes: [{ id: "existing" }], showIsolated: false });
  assert.match(empty.textContent, /显示孤立节点/);
  assert.doesNotMatch(empty.textContent, /尚未生成|第一份/);
});
