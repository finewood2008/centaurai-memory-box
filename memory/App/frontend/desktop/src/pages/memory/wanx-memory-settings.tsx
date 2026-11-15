import type { AppSettingsDto, MemoryTokenBudgetDto } from "@memmy/local-api-contracts";
import { useEffect, useState } from "react";
import { useApiClients } from "../../app/providers.js";
import { appActions } from "../../state/app-actions.js";
import { useAppState } from "../../state/app-state.js";
import { ModelWorkspaceSection } from "../model-workspace-section.js";
import { MemoryTokenBudgetCard } from "../settings-page.js";

export default function MemorySettings({ section, sessionToken }: {
  section: "models" | "budget";
  sessionToken: string;
}) {
  return <main className="wanx-memory-settings">
    {section === "budget" && <MemoryBudgetSettings />}
    {section === "models" && <MemoryModelSettings sessionToken={sessionToken} />}
  </main>;
}

type MemoryModelSource = "wanx" | "custom";
type WanxTextRole = "memory_summary" | "memory_evolution";
type WanxOptionalRole = "agent" | "asr" | "image_generation";
type WanxOtherRole = "embedding" | WanxOptionalRole;
interface WanxModel {
  ref: string;
  model: string;
  provider: string;
  name: string;
}
interface WanxRole {
  selectedRef: string | null;
  models: WanxModel[];
  ready: boolean;
  effective: WanxModel | null;
  supportsSelection: boolean;
}
interface MemoryModelSettingsView {
  mode: MemoryModelSource;
  roles?: Record<WanxTextRole, WanxRole>;
  inventory?: Record<WanxOtherRole, {
    models: WanxModel[];
    defaultModel: WanxModel | null;
    reported: boolean;
    selectedRef: string | null;
  }>;
  error?: string;
}
const modelErrors: Record<string, string> = {
  MEMORY_MODEL_BOX_DISCONNECTED: "请连接万象盒子。",
  MEMORY_MODEL_BOX_UPDATE_REQUIRED: "当前万象盒端版本尚未提供记忆模型接口。",
  MEMORY_MODEL_NOT_CONFIGURED: "请在万象盒端设置默认模型。",
};
const wanxTextRoles: ReadonlyArray<readonly [WanxTextRole, string]> = [
  ["memory_summary", "记忆摘要"],
  ["memory_evolution", "技能进化"],
];
const wanxOptionalRoles: ReadonlyArray<readonly [WanxOptionalRole, string]> = [
  ["agent", "对话模型"],
  ["asr", "语音转录模型"],
  ["image_generation", "图片生成模型"],
];

function boxInventoryLabel(item: NonNullable<MemoryModelSettingsView["inventory"]>[WanxOtherRole] | undefined) {
  if (item?.defaultModel) return `盒端默认 ${item.defaultModel.provider} · ${item.defaultModel.name}`;
  if (item?.models.length) return `盒端目录提供 ${item.models.length} 个候选，等待确认默认模型。`;
  if (item?.reported) return "盒端暂无可用模型。";
  return "盒端暂未提供此能力的模型清单。";
}

function MemoryModelSettings({ sessionToken }: { sessionToken: string }) {
  const { clients } = useApiClients();
  const { state, dispatch } = useAppState();
  const [settings, setSettings] = useState<MemoryModelSettingsView | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  async function load(changes?: { mode: MemoryModelSource } | { role: WanxTextRole | WanxOptionalRole; modelRef: string | null }, signal?: AbortSignal) {
    setPending(true);
    setError("");
    try {
      const response = await fetch("wanx-memory://local/api/wanx-memory/model-settings", {
        method: changes ? "PUT" : "GET",
        headers: { "x-memmy-local-token": sessionToken, "content-type": "application/json" },
        ...(changes && { body: JSON.stringify(changes) }),
        signal,
      });
      if (!response.ok) throw new Error();
      const result = await response.json() as MemoryModelSettingsView;
      if (!signal?.aborted) setSettings(result);
    } catch {
      if (!signal?.aborted) setError(changes ? "未能保存记忆模型设置，请刷新盒端状态后重试。" : "暂时无法读取记忆模型设置。");
    } finally {
      if (!signal?.aborted) setPending(false);
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    void load(undefined, controller.signal);
    return () => controller.abort();
  }, [sessionToken]);

  return <>
    <section className="mb-5 rounded-card-lg border-content-panel bg-background-paper p-5">
      <label className="flex flex-wrap items-center justify-between gap-3 text-sm">
        <span className="font-semibold">记忆模型来源</span>
        <select className="rounded-btn border border-border-stone bg-background-paper px-3 py-2"
          value={settings?.mode ?? "wanx"} disabled={pending || !settings}
          onChange={event => void load({ mode: event.currentTarget.value as MemoryModelSource })}>
          <option value="wanx">使用万象盒端模型（默认）</option>
          <option value="custom">使用本机模型配置</option>
        </select>
      </label>
      {settings?.mode === "wanx" && settings.error && <p className="mt-2 text-xs text-text-ink/65" role="status">
        {modelErrors[settings.error] ?? "暂时无法读取盒端记忆推理状态。"}
      </p>}
      {settings?.mode === "wanx" && <div className="mt-4 grid gap-3">
        {wanxTextRoles.map(([role, label]) => {
          const item = settings.roles?.[role];
          const choices = item?.models ?? [];
          const selectedRef = item?.selectedRef ?? "";
          return <div key={role}>
            <label className="flex flex-wrap items-center justify-between gap-3 text-sm">
              <span>{label}</span>
              <select className="max-w-full rounded-btn border border-border-stone bg-background-paper px-3 py-2"
                value={selectedRef} disabled={pending || (!choices.length && !selectedRef)}
                onChange={event => void load({ role, modelRef: event.currentTarget.value || null })}>
                <option value="">跟随盒端默认模型</option>
                {selectedRef && !choices.some(model => model.ref === selectedRef) &&
                  <option value={selectedRef} disabled>{selectedRef}（目录中暂不可用）</option>}
                {choices.map(model => <option key={model.ref} value={model.ref}>{model.provider} · {model.name}</option>)}
              </select>
            </label>
            <p className="mt-1 text-xs text-text-ink/65">
              {item?.ready && item.effective ? `当前使用 ${item.effective.name}`
                : selectedRef && !item?.supportsSelection ? "选型已保存，等待盒端开放按任务调用。"
                  : item?.supportsSelection ? "等待盒端配置此任务的可用模型。"
                    : "等待盒端开放记忆推理。"}
            </p>
          </div>;
        })}
        <div className="text-sm">
          <p>向量检索</p>
          <p className="mt-1 text-xs text-text-ink/65">{boxInventoryLabel(settings.inventory?.embedding)}</p>
          <p className="mt-1 text-xs text-text-ink/65">当前使用本机嵌入配置。切换到盒端前需验证现有索引。</p>
        </div>
        <fieldset className="mt-2 grid gap-3 border-t border-border-stone pt-3">
          <legend className="pr-2 text-sm font-semibold">非必配模型</legend>
          {wanxOptionalRoles.map(([role, label]) => {
            const item = settings.inventory?.[role];
            const choices = item?.models ?? [];
            const selectedRef = item?.selectedRef ?? "";
            return <div key={role}>
              <label className="flex flex-wrap items-center justify-between gap-3 text-sm">
                <span>{label}</span>
                <select className="max-w-full rounded-btn border border-border-stone bg-background-paper px-3 py-2"
                  value={selectedRef} disabled={pending || (!choices.length && !selectedRef)}
                  onChange={event => void load({ role, modelRef: event.currentTarget.value || null })}>
                  <option value="">未设置</option>
                  {selectedRef && !choices.some(model => model.ref === selectedRef) &&
                    <option value={selectedRef} disabled>{selectedRef}（目录中暂不可用）</option>}
                  {choices.map(model => <option key={model.ref} value={model.ref}>{model.provider} · {model.name}</option>)}
                </select>
              </label>
              <p className="mt-1 text-xs text-text-ink/65">
                {selectedRef ? "选型已保存，等待对应功能接入。" : boxInventoryLabel(item)}
              </p>
            </div>;
          })}
        </fieldset>
      </div>}
      {error && <p className="mt-2 text-xs text-status-error" role="alert">{error}</p>}
      {(!settings || settings.mode === "wanx") &&
        <button type="button" disabled={pending} onClick={() => void load()}
          className="mt-2 text-xs text-action-sky">刷新状态</button>}
    </section>
    {settings && clients && <ModelWorkspaceSection
      memoryOnly
      embeddingOnly={settings.mode === "wanx"}
      mode={state.bootstrap?.app.userMode === "account" ? "account" : "byok"}
      configClient={clients.config}
      onConfigSaved={config => dispatch(appActions.modelConfigUpdated(config))}
    />}
  </>;
}

function MemoryBudgetSettings() {
  const { clients } = useApiClients();
  const { state, dispatch } = useAppState();
  const settings = state.bootstrap?.app;
  const [budget, setBudget] = useState<MemoryTokenBudgetDto | null>(null);
  const [daily, setDaily] = useState(String(settings?.memoryByokDailyLimitM ?? 10));
  const [total, setTotal] = useState(String(settings?.memoryByokTotalLimitM ?? 500));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void clients?.byokTokenUsage.getMemoryBudget().then(value => {
      if (active) setBudget(value);
    }).catch(() => { if (active) setError("暂时无法读取记忆用量。"); });
    return () => { active = false; };
  }, [clients]);

  async function save(patch: Partial<AppSettingsDto>) {
    if (!clients) return;
    setError(null);
    try {
      await clients.config.updateSettings(patch);
      setBudget(await clients.byokTokenUsage.getMemoryBudget());
    } catch {
      setError("未能确认记忆预算已保存，请重试。");
    }
  }

  async function saveServicePreference(enabled: boolean) {
    if (!clients) return;
    setError(null);
    try {
      const saved = await clients.config.updateSettings({ stopMemoryServiceOnExit: enabled });
      dispatch(appActions.settingsUpdated(saved));
    } catch {
      setError("未能保存记忆服务设置，请重试。");
    }
  }

  return <>
    <MemoryTokenBudgetCard
      budget={budget}
      fallbackDailyLimitM={settings?.memoryByokDailyLimitM ?? 10}
      fallbackTotalLimitM={settings?.memoryByokTotalLimitM ?? 500}
      dailyLimitDraft={daily}
      totalLimitDraft={total}
      onDailyDraftChange={setDaily}
      onTotalDraftChange={setTotal}
      onCommitDaily={value => void save({ memoryByokDailyLimitM: value })}
      onCommitTotal={value => void save({ memoryByokTotalLimitM: value })}
      saveError={error}
    />
    <label className="mt-4 flex items-center gap-2">
      <input type="checkbox" checked={settings?.stopMemoryServiceOnExit ?? false}
        onChange={event => void saveServicePreference(event.currentTarget.checked)} />
        退出本机记忆应用时停止记忆服务
    </label>
  </>;
}
