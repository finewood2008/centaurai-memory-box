// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MemorySyncSummary } from "../wanx-memory-backup.js";
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); vi.useRealTimers(); });
it("keeps advanced controls folded and persists the single backup switch without a directory picker", async () => {
  let enabled = true;
  const actions: unknown[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
    if (init.method === "POST") { const body = JSON.parse(init.body); actions.push(body); enabled = body.action === "enable"; return Response.json({}); }
    return Response.json({ enabled, connected: false, context: "account-ticket" });
  }));
  await act(async () => root.render(<MemorySyncSummary sessionToken="session" count={3} automatic><div>来源管理</div></MemorySyncSummary>));
  const toggle = container.querySelector<HTMLButtonElement>('[role="switch"]')!;
  expect(toggle.getAttribute("aria-checked")).toBe("true");
  expect(container.querySelector("details")!.open).toBe(false);
  expect(container.textContent).toContain("连接盒子后自动备份");
  await act(async () => toggle.click());
  expect(actions).toEqual([{ action: "disable", context: "account-ticket" }]);
  expect(toggle.getAttribute("aria-checked")).toBe("false");
  expect(container.textContent).not.toContain("选择目录");
});
it("keeps the switch unchanged on failure and requires confirmation for the detected backup", async () => {
  const posts: object[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
    if (init.method === "POST") { posts.push(JSON.parse(init.body)); return Response.json({error:{message:"连接中断"}}, {status:400}); }
    return Response.json({ enabled:true, connected:true, context:"box-ticket", availableBackup:{id:"backup-id",modified:1} });
  }));
  await act(async () => root.render(<MemorySyncSummary sessionToken="session" count={2} automatic><div /></MemorySyncSummary>));
  const toggle = container.querySelector<HTMLButtonElement>('[role="switch"]')!;
  await act(async () => toggle.click());
  expect(toggle.getAttribute("aria-checked")).toBe("true");
  expect(container.querySelector('[role="alert"]')?.textContent).toBe("连接中断");
  const restore = [...container.querySelectorAll('button')].find(button => button.textContent === "从空间恢复")!;
  act(() => restore.click());
  expect(posts).toHaveLength(1);
  const confirm = [...container.querySelectorAll('button')].find(button => button.textContent === "确认恢复")!;
  await act(async () => confirm.click());
  expect(posts[1]).toEqual({action:"restore",context:"box-ticket",id:"backup-id"});
});

it("saves the chosen interval from automatic sync settings and reflects the persisted result", async () => {
  let intervalMinutes = 5;
  const requests: object[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
    if (init.method === "POST") { const data = JSON.parse(init.body); requests.push(data); intervalMinutes = data.intervalMinutes; return Response.json({}); }
    return Response.json({ enabled: true, connected: false, context: "account-ticket", intervalMinutes });
  }));
  await act(async () => root.render(<MemorySyncSummary sessionToken="session" count={2} automatic><div /></MemorySyncSummary>));
  expect(container.querySelector('summary')?.textContent).toBe("自动同步设置");
  const select = container.querySelector<HTMLSelectElement>('select')!;
  await act(async () => { select.value = "60"; select.dispatchEvent(new Event("change", { bubbles: true })); });
  expect(requests).toEqual([{action:"configure",context:"account-ticket",intervalMinutes:60}]);
  expect(select.value).toBe("60");
  expect(container.textContent).toContain("每 1 小时自动备份");
});
