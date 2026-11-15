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
it("requires explicit source, exact version and confirmation before a restore", async () => {
  const posts: object[] = [];
  const digest = "a".repeat(64);
  vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
    if (init.method === "POST") {
      const data = JSON.parse(init.body);
      posts.push(data);
      if (data.action === "catalog") return Response.json({ rollbackAvailable: true, sources: [
        { id: "v2-local", name: "Mac · A", current: true, snapshots: [{ id: "local", digest, modified: 3 }] },
        { id: "v2-remote", name: "Windows · B", current: false, snapshots: [
          { id: "latest", digest, modified: 2 }, { id: "older", digest, modified: 1 },
        ] },
      ] });
      return Response.json({ error: { message: "连接中断" } }, { status: 400 });
    }
    return Response.json({ enabled: true, connected: true, context: "box-ticket" });
  }));
  await act(async () => root.render(<MemorySyncSummary sessionToken="session" count={2} automatic><div /></MemorySyncSummary>));
  const toggle = container.querySelector<HTMLButtonElement>('[role="switch"]')!;
  await act(async () => toggle.click());
  expect(toggle.getAttribute("aria-checked")).toBe("true");
  expect(container.querySelector('[role="alert"]')?.textContent).toBe("连接中断");
  const button = (label: string) => [...container.querySelectorAll("button")].find(item => item.textContent === label)!;
  await act(async () => button("从备份恢复").click());
  const [source, snapshot] = container.querySelectorAll<HTMLSelectElement>('[aria-label="选择恢复来源"] select');
  const select = (element: HTMLSelectElement, value: string) => act(() => {
    element.value = value; element.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(snapshot.disabled).toBe(true);
  expect(button("查看恢复确认").disabled).toBe(true);
  select(source, "v2-remote");
  select(snapshot, "older");
  act(() => button("查看恢复确认").click());
  expect(posts).toHaveLength(2);
  expect(container.textContent).toContain("Windows · B 的快照");
  expect(container.textContent).toContain("先保留当前记忆库的本机副本");
  await act(async () => button("确认恢复").click());
  expect(posts[2]).toEqual({ action: "restore", context: "box-ticket", sourceId: "v2-remote", id: "older", digest });
});

it("saves the chosen backup interval", async () => {
  let intervalMinutes = 5;
  const requests: object[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
    if (init.method === "POST") { const data = JSON.parse(init.body); requests.push(data); intervalMinutes = data.intervalMinutes; return Response.json({}); }
    return Response.json({ enabled: true, connected: false, context: "account-ticket", intervalMinutes });
  }));
  await act(async () => root.render(<MemorySyncSummary sessionToken="session" count={2} automatic><div /></MemorySyncSummary>));
  expect(container.querySelector('summary')?.textContent).toBe("采集与备份设置");
  const select = container.querySelector<HTMLSelectElement>('#space-backup-interval')!;
  await act(async () => { select.value = "60"; select.dispatchEvent(new Event("change", { bubbles: true })); });
  expect(requests).toEqual([{action:"configure",context:"account-ticket",intervalMinutes:60}]);
  expect(select.value).toBe("60");
  expect(container.textContent).toContain("每 1 小时备份本机记忆库");
});

it("passes an unknown profile until server state arrives and fails closed after a status error", async () => {
  let finish: ((response: Response) => void) | undefined;
  let calls = 0;
  vi.stubGlobal("fetch", vi.fn(async () => {
    if (calls++ === 0) return new Promise<Response>(resolve => { finish = resolve; });
    if (calls === 2) throw new Error("status unavailable");
    return Response.json({ enabled: true, connected: false, context: "profile-context", library: { id: "legacy", name: "本机记忆库" } });
  }));
  await act(async () => root.render(<MemorySyncSummary sessionToken="session" count={8} automatic>
    {profile => <div data-testid="collection-profile">{profile?.id ?? "unknown"}</div>}
  </MemorySyncSummary>));
  expect(container.querySelector('[data-testid="collection-profile"]')?.textContent).toBe("unknown");
  expect(container.querySelector('.my-ai-sync-title')?.textContent).not.toContain("自动采集");
  await act(async () => finish!(Response.json({ enabled: true, connected: false, context: "profile-context", library: { id: "legacy", name: "本机记忆库" } })));
  expect(container.querySelector('[data-testid="collection-profile"]')?.textContent).toBe("legacy");
  expect(container.querySelector('.my-ai-sync-title')?.textContent).toContain("8 个来源 · 自动采集");
  await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
  expect(container.querySelector('[data-testid="collection-profile"]')?.textContent).toBe("unknown");
  await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
  expect(container.querySelector('[data-testid="collection-profile"]')?.textContent).toBe("legacy");
});

it("has one unified local collection mode without a per-agent library selector", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ enabled: true, connected: false, context: "local", library: { id: "legacy", name: "本机记忆库" } })));
  await act(async () => root.render(<MemorySyncSummary sessionToken="session" count={6} automatic><div /></MemorySyncSummary>));
  expect(container.textContent).toContain("统一采集到本机记忆库");
  expect(container.textContent).toContain("6 个来源 · 自动采集");
  expect(container.textContent).not.toContain("旧版混合库");
  expect([...container.querySelectorAll("select")].map(item => item.id)).toEqual(["space-backup-interval"]);
});
