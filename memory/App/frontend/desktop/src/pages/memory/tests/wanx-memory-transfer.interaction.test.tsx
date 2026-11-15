// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MemoryTransfer } from "../wanx-memory-transfer.js";

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
const button = (label: string) => [...container.querySelectorAll("button")].find(element => element.textContent === label)!;

it("previews before importing and reports server inserted and skipped counts", async () => {
  const calls: { action: string; data: object }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url, init) => {
    const action = String(url).split("/").at(-1)!;
    calls.push({ action, data: JSON.parse(init.body) });
    if (action === "status") return Response.json({ rollbackAvailable: false });
    if (action === "preview") return Response.json({ previewId: "synthetic-preview", name: "test.json", rows: 3, counts: { memories: 3 } });
    return Response.json({ imported: true, inserted: { memories: 2 }, skipped: { memories: 1 }, rollbackAvailable: true });
  }));
  await act(async () => root.render(<MemoryTransfer sessionToken="synthetic-session" />));
  await act(async () => button("选择记忆包").click());
  expect(container.textContent).toContain("test.json · 3 条数据记录");
  expect(calls.map(call => call.action)).toEqual(["status", "preview"]);
  await act(async () => button("确认导入").click());
  expect(calls[2]).toEqual({ action: "import", data: { previewId: "synthetic-preview" } });
  expect(container.textContent).toContain("新增 2 条数据记录，跳过 1 条重复记录");
  expect(container.querySelector('[aria-label="记忆包预览"]')).toBeNull();
});

it("requires confirmation for whole-library rollback and does not claim accepted restart has finished", async () => {
  let restoring = false;
  const actions: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url, init) => {
    const action = String(url).split("/").at(-1)!; actions.push(action);
    if (action === "rollback") {
      expect(JSON.parse(init.body)).toEqual({ confirm: true });
      restoring = true; return Response.json({ restoring: true, rollbackAvailable: false });
    }
    return Response.json(restoring ? { restored: true, rollbackAvailable: false } : { rollbackAvailable: true });
  }));
  await act(async () => root.render(<MemoryTransfer sessionToken="session" />));
  act(() => button("回滚上次导入").click());
  expect(actions).toEqual(["status"]);
  expect(container.textContent).toContain("导入后新增的本机记忆也会移出当前库");
  await act(async () => button("确认回滚").click());
  expect(container.textContent).toContain("正在恢复");
  expect(container.textContent).not.toContain("已恢复导入前");
  expect(button("导出记忆包").disabled).toBe(true);
  await act(async () => button("刷新传输状态").click());
  expect(container.textContent).toContain("已恢复导入前");
  expect(button("导出记忆包").disabled).toBe(false);
});

it("a rejected import retains preview and displays the actual service error", async () => {
  vi.stubGlobal("fetch", vi.fn(async (url) => {
    const action = String(url).split("/").at(-1);
    if (action === "preview") return Response.json({ previewId: "preview", name: "test.json", rows: 1, counts: {} });
    if (action === "import") return Response.json({ error: { message: "无法保留导入前副本" } }, { status: 400 });
    return Response.json({ rollbackAvailable: false });
  }));
  await act(async () => root.render(<MemoryTransfer sessionToken="session" />));
  await act(async () => button("选择记忆包").click());
  await act(async () => button("确认导入").click());
  expect(container.querySelector('[role="alert"]')?.textContent).toBe("无法保留导入前副本");
  expect(container.querySelector('[aria-label="记忆包预览"]')).not.toBeNull();
  expect(container.textContent).not.toContain("导入完成");
});
