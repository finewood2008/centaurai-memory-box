import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

// Personal payloads are assembled from the tracked team source before packaging.
const usePersonal = process.env.STARLINK_GRAPH_TEST_EDITION === "personal";
const source = await readFile(
  new URL(usePersonal ? "../applications/starlink/ui/app.js" : "../../team-client/applications/starlink/ui/app.js", import.meta.url),
  "utf8",
);
const renderSource = source.slice(source.indexOf("function renderGraph() {"), source.indexOf("function renderDetails(g) {"));
const warehouseSource = source.slice(source.indexOf("function currentWarehouse() {"), source.indexOf("function warehouseStatus(w) {"));

function render({ warehouses = [], warehouseId = "selected", graphError = null, nodes = [] } = {}) {
  const elements = new Map();
  const $ = selector => {
    if (!elements.has(selector)) elements.set(selector, { value: "", classList: { toggle() {} } });
    return elements.get(selector);
  };
  const state = { warehouses, warehouseId, graphError, ready: true, graph: { nodes, edges: [] } };
  vm.runInNewContext(`${renderSource}\n${warehouseSource}\nrenderGraph();`, {
    state, $, visibleGraph: () => ({ nodes: [], edges: [] }),
    errorText: error => error.message, document: { querySelectorAll: () => [] },
    transformScene() {}, renderDetails() {},
  });
  return $("#graph-empty");
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
  assert.equal(empty.textContent, "知识图谱加载失败，请重试");
});

test("an unmatched graph filter stays distinct from knowledge not yet generated", () => {
  const empty = render({ warehouses: [{ id: "selected", document_count: 21 }], nodes: [{ id: "existing" }] });
  assert.equal(empty.textContent, "没有找到匹配的实体");
});
