// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { AppStateProvider } from "../../../state/app-state.js";
import { I18nProvider } from "../../../i18n/i18n-provider.js";
import { MemoriesSubPage } from "../memories-sub-page.js";
import { clearMemoryPanelCache } from "../memory-panel-cache.js";
import { createMemoryRuntimeClientStub, memoryListItemFixture, panelItemsOutput } from "./fixtures.js";
import { createMockMemoryRuntimeClient } from "./memory-runtime-fixtures.js";

it("uses actual health configuration, refreshes a restored model, and treats failed health as unknown", async () => {
  vi.useFakeTimers();
  clearMemoryPanelCache();
  const container = document.createElement("div"), root = createRoot(container);
  const reference = await createMockMemoryRuntimeClient().health();
  let configured = false, unavailable = false;
  const health = vi.fn(async () => {
    if (unavailable) throw new Error("synthetic health unavailable");
    return { ...reference, models: { ...reference.models, summary: { ...reference.models.summary, configured } } };
  });
  const processing = { memoryId: memoryListItemFixture.id, state: "summary_pending" as const,
    stage: "summary" as const, attemptCount: 0, manualRetryCount: 0, retryAction: "retry" as const,
    updatedAt: "2026-11-17T00:00:00Z" };
  const client = createMemoryRuntimeClientStub({ health,
    listPanelItems: async () => panelItemsOutput([{ ...memoryListItemFixture, processing }]),
    getMemoryProcessingStatus: async () => ({ items: [processing], serverTime: processing.updatedAt })
  });
  try {
    await act(async () => root.render(<AppStateProvider><I18nProvider language="zh-CN"><MemoriesSubPage client={client} /></I18nProvider></AppStateProvider>));
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(container.textContent).toContain("等待配置记忆模型");
    expect(container.textContent).not.toContain("摘要总结中");
    configured = true;
    await act(async () => vi.advanceTimersByTimeAsync(2_000));
    expect(container.textContent).toContain("摘要总结中");
    expect(container.textContent).not.toContain("等待配置记忆模型");
    configured = false;
    await act(async () => vi.advanceTimersByTimeAsync(2_000));
    expect(container.textContent).toContain("等待配置记忆模型");
    unavailable = true;
    await act(async () => vi.advanceTimersByTimeAsync(2_000));
    expect(container.textContent).not.toContain("等待配置记忆模型");
    expect(container.textContent).toContain("摘要总结中");
  } finally {
    await act(async () => root.unmount());
    clearMemoryPanelCache();
    vi.useRealTimers();
  }
});
