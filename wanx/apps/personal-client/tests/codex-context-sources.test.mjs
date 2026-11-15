import assert from "node:assert/strict";
import test from "node:test";
import { createCodexContextSources } from "../shell/codex-context-sources.mjs";

const id = char => char.repeat(32);
const warehouseId = "12345678-1234-1234-1234-123456789abc";
const otherWarehouse = "87654321-1234-1234-1234-123456789abc";
const root = id("a");
const folder = id("b");
const nested = id("c");
const outside = id("d");
const target = id("e");
const otherFile = id("f");
const sample = "正文包含防抖验收口径，用于资料检索。";
const check = () => {};

function fixture({ rootId = root } = {}) {
  const previews = [];
  const spaceCalls = [];
  const starlinkCalls = [];
  const folders = {
    [folder]: { id: folder, name: "培训资料", parent: rootId, kind: "folder" },
    [nested]: { id: nested, name: "本周", parent: folder, kind: "folder" },
    [outside]: { id: outside, name: "未授权目录", parent: rootId, kind: "folder" },
  };
  const files = {
    [target]: { id: target, name: "notes.txt", parent: nested, kind: "file", version: 1, size: Buffer.byteLength(sample) },
    [otherFile]: { id: otherFile, name: "防抖验收口径.txt", parent: outside, kind: "file", version: 1, size: 4 },
  };
  const space = {
    async operation(action, input) {
      assert.equal(action, "list");
      assert.equal(input.space_id, "personal");
      const parent = input.parent || rootId;
      spaceCalls.push(parent);
      const breadcrumbs = [];
      let cursor = parent;
      while (cursor !== rootId) {
        const row = folders[cursor];
        if (!row) throw Error("fixture had no such folder");
        breadcrumbs.unshift({ id: row.id, name: row.name });
        cursor = row.parent;
      }
      const items = [...Object.values(folders), ...Object.values(files)].filter(row => row.parent === parent);
      return { space_id: "personal", root: rootId, parent, breadcrumbs,
        items: rootId === "" ? items.map(row => ({ ...row, space_id: "personal" })) : items };
    },
    async preview(fileId, options) {
      assert.equal(options.interactive, false);
      previews.push(fileId);
      return { type: "text/plain", name: files[fileId].name, data: Buffer.from(sample).toString("base64") };
    },
  };
  const sources = createCodexContextSources({ space, async starlink(action, input) {
    starlinkCalls.push({ action, input });
    if (action === "warehouses") return { items: [
      { id: warehouseId, name: "工程规范", state: "active" }, { id: otherWarehouse, state: "archived" },
    ] };
    assert.equal(input.warehouseId, warehouseId);
    if (action === "search") return { items: [
      { id: "evidence_1", title: "验收标准", text: "检索到的星图证据", warehouse_id: warehouseId },
      { id: "evidence_2", title: "其他仓", text: "其他仓内容", warehouse_id: otherWarehouse },
    ] };
    return { id: input.id, text: "星图原文", warehouse_id: input.id === "evidence_1" ? warehouseId : otherWarehouse };
  } });
  return { sources, space, files, previews, spaceCalls, starlinkCalls };
}

test("scoped Space search finds text in a selected subfolder and never fetches a sibling file", async () => {
  const { sources, previews } = fixture();
  const catalog = await sources.catalog(folder, check);
  assert.deepEqual(catalog.folder, { id: folder, name: "培训资料" });
  assert.deepEqual(catalog.folders, [{ id: nested, name: "本周" }]);
  await assert.rejects(sources.validate(root, warehouseId, check), { status: 400 });
  const selected = await sources.validate(folder, warehouseId, check);
  const result = await sources.call(selected, "space_search", { query: "防抖验收口径" }, check);
  assert.deepEqual(result.matches, [{ fileId: target, name: "notes.txt", path: "本周/notes.txt", version: 1, snippet: sample }]);
  assert.equal((await sources.call(selected, "space_read", { fileId: target }, check)).text, sample);
  await assert.rejects(sources.call(selected, "space_read", { fileId: otherFile }, check), { status: 403 });
  assert.deepEqual(previews, [target, target]);
});

test("Space accepts the empty root returned by a box and finds text below a selected child", async () => {
  const { sources, previews } = fixture({ rootId: "" });
  assert.deepEqual(await sources.catalog("", check, "space"), {
    folders: [{ id: folder, name: "培训资料" }, { id: outside, name: "未授权目录" }],
    parent: "", folder: { id: "", name: "个人空间" },
  });
  await assert.rejects(sources.validate("", null, check), { status: 400 });
  const selected = await sources.validate(folder, null, check);
  const result = await sources.call(selected, "space_search", { query: "防抖验收口径" }, check);
  assert.deepEqual(result.matches.map(({ fileId, path, snippet }) => ({ fileId, path, snippet })), [
    { fileId: target, path: "本周/notes.txt", snippet: sample },
  ]);
  const read = await sources.call(selected, "space_read", { fileId: target }, check);
  assert.equal(read.text, sample);
  await assert.rejects(sources.call(selected, "space_read", { fileId: otherFile }, check), { status: 403 });
  assert.deepEqual(previews, [target, target]);
});

test("Space rejects a wrong parent or a different space when the box uses an empty root", async () => {
  const { sources, space, previews } = fixture({ rootId: "" });
  const operation = space.operation;
  space.operation = async (...args) => ({ ...(await operation(...args)), parent: outside });
  await assert.rejects(sources.catalog("", check, "space"), { status: 403 });
  await assert.rejects(sources.validate(folder, null, check), { status: 403 });
  space.operation = async (...args) => ({ ...(await operation(...args)), space_id: outside });
  await assert.rejects(sources.catalog("", check, "space"), { status: 403 });
  await assert.rejects(sources.validate(folder, null, check), { status: 403 });
  assert.deepEqual(previews, []);
});

test("space read withholds content after a move outside the selected folder", async () => {
  const { sources, space, files } = fixture();
  const selected = await sources.validate(folder, warehouseId, check);
  const originalPreview = space.preview;
  space.preview = async (...args) => {
    const response = await originalPreview(...args);
    files[target].parent = outside;
    return response;
  };
  await assert.rejects(sources.call(selected, "space_read", { fileId: target }, check), { status: 403 });
});

test("Starlink uses the selected warehouse and rejects scope changes during a request", async () => {
  const { sources, starlinkCalls } = fixture();
  await assert.rejects(sources.validate(folder, otherWarehouse, check), { status: 403 });
  const selected = await sources.validate(folder, warehouseId, check);
  const result = await sources.call(selected, "starlink_search", { query: "验收", warehouseId: otherWarehouse }, check);
  assert.deepEqual(result.matches.map(row => row.evidenceId), ["evidence_1"]);
  assert.equal(starlinkCalls.at(-1).input.warehouseId, warehouseId);
  assert.equal((await sources.call(selected, "starlink_evidence", { evidenceId: "evidence_1" }, check)).text, "星图原文");
  await assert.rejects(sources.call(selected, "starlink_evidence", { evidenceId: "evidence_2" }, check), { status: 403 });
  let checks = 0;
  await assert.rejects(sources.call(selected, "starlink_evidence", { evidenceId: "evidence_1" }, () => {
    if (++checks === 3) throw Error("连接已切换");
  }), /连接已切换/);
});

test("single-source catalogs, validation and tools avoid the other source", async () => {
  const { sources, spaceCalls, starlinkCalls } = fixture();
  assert.deepEqual(await sources.catalog(folder, check, "space"), {
    folders: [{ id: nested, name: "本周" }], parent: "", folder: { id: folder, name: "培训资料" },
  });
  const spaceOnly = await sources.validate(folder, null, check);
  assert.deepEqual(spaceOnly, { folderId: folder, folderName: "培训资料" });
  assert.deepEqual((await sources.call(spaceOnly, "space_search", { query: "防抖验收口径" }, check)).matches.map(row => row.fileId), [target]);
  await assert.rejects(sources.call(spaceOnly, "starlink_evidence", { evidenceId: "evidence_1" }, check), { status: 403 });
  assert.deepEqual(starlinkCalls, []);

  const previousSpaceCalls = [...spaceCalls];
  assert.deepEqual(await sources.catalog("", check, "starlink"), { warehouses: [{ id: warehouseId, name: "工程规范" }] });
  const starlinkOnly = await sources.validate(null, warehouseId, check);
  assert.deepEqual(starlinkOnly, { warehouseId, warehouseName: "工程规范" });
  await assert.rejects(sources.call(starlinkOnly, "space_read", { fileId: target }, check), { status: 403 });
  assert.equal((await sources.call(starlinkOnly, "starlink_evidence", { evidenceId: "evidence_1" }, check)).text, "星图原文");
  assert.deepEqual(spaceCalls, previousSpaceCalls);
  await assert.rejects(sources.validate(null, null, check), { status: 400 });
  await assert.rejects(sources.validate(folder, "", check), { status: 400 });
});
