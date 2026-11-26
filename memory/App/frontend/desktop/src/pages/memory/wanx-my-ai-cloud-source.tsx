import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check, ChevronDown, Cloud, SlidersHorizontal, UserRound, X } from "lucide-react";
import { Modal } from "../../components/modal.js";
import type { Agent, MyAiRequest } from "./wanx-my-ai-model.js";

interface Model { ref: string; name: string; model: string }
interface Source {
  selected: Model | null;
  connected: boolean;
  recoveryError?: string;
  desktopDefault?: string;
  gateway?: { base: string; helper: string; receivedAt: string | null };
}

export function CloudSourceBar({ current, detail, cloud = false, disabled = false, canChoose = true,
  onChoose, onRestore, children, subscriptionLabel = "原订阅" }: {
  current: string; detail: string; cloud?: boolean; disabled?: boolean; canChoose?: boolean;
  subscriptionLabel?: string; onChoose?: () => void; onRestore?: () => void; children?: ReactNode;
}) {
  return <section className="my-ai-cloud-source" aria-label="模型来源" data-cloud={cloud}>
    <div className="my-ai-cloud-row">
      <div className="my-ai-cloud-info">
        <h3><SlidersHorizontal size={13} aria-hidden="true"/>模型来源</h3>
        <strong title={detail}>{current}</strong>
      </div>
      {onChoose && <div className="my-ai-cloud-actions" role="group" aria-label="选择模型来源">
        <button type="button" aria-label={cloud ? "切回" + subscriptionLabel : subscriptionLabel} aria-pressed={!cloud}
          disabled={disabled} onClick={cloud ? onRestore : undefined}>
          <UserRound aria-hidden="true" size={15}/><span>{subscriptionLabel}</span>{!cloud && <Check size={12} aria-hidden="true"/>}
        </button>
        <button type="button" aria-label={cloud ? "更换盒端模型" : "使用记忆盒子模型"}
          aria-pressed={cloud} aria-haspopup="dialog" disabled={disabled || !canChoose} onClick={onChoose}>
          <Cloud size={16} aria-hidden="true"/><span>盒子云模型</span><ChevronDown size={12} aria-hidden="true"/>
        </button>
      </div>}
    </div>{children}
  </section>;
}

export function MyAiCloudSource({ agent, request }: { agent: Agent; request: MyAiRequest }) {
  const [source, setSource] = useState<Source>();
  const [models, setModels] = useState<Model[]>([]);
  const [choice, setChoice] = useState("");
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const life = useRef<AbortController | null>(null);
  useEffect(() => {
    const ctrl = new AbortController();
    life.current = ctrl;
    request<Source>("model-source/status",ctrl.signal,{agent:agent.id}).then(v => {
      if (!ctrl.signal.aborted) setSource(v);
    }).catch(() => { if (!ctrl.signal.aborted) setNotice("读取模型来源失败，请重新打开此智能体。"); });
    return () => ctrl.abort();
  }, [agent.id,request]);

  const desktop = agent.id === "codex";
  const gateway = source?.gateway;
  const watchStatus = Boolean(source && (desktop || agent.id === "codex_cli" || !source.connected));
  useEffect(() => {
    if (!watchStatus) return;
    const ctrl = new AbortController();
    let reading = false;
    const timer = setInterval(async () => {
      if (reading) return;
      reading = true;
      try {
        const next = await request<Source>("model-source/status",ctrl.signal,{agent:agent.id});
        if (!ctrl.signal.aborted) setSource(next);
      } catch { /* Keep the last verified receipt until the next refresh. */ }
      finally { reading = false; }
    }, 3000);
    return () => { ctrl.abort(); clearInterval(timer); };
  }, [agent.id,request,watchStatus,gateway?.helper]);

  async function perform(pick: boolean, ref: string | null = null) {
    const signal = life.current?.signal;
    if (busy || !signal || signal.aborted) return;
    setBusy(true); setNotice("");
    try {
      if (pick) {
        const result = await request<{models:Model[]}>("model-source/catalog",signal,{agent:agent.id});
        if (signal.aborted) return;
        setModels(result.models);
        setChoice(result.models.find(m => m.ref === source?.selected?.ref)?.ref ?? result.models[0]?.ref ?? "");
        setOpen(true);
      } else {
        const result = await request<Source>("model-source/select",signal,{agent:agent.id,ref});
        if (signal.aborted) return;
        setSource(result); setOpen(false);
        setNotice(desktop ? (result.selected ? "" : "已恢复 Codex 原模型配置。重新打开 Codex 后，新对话将沿用原设置。") : result.selected ? "下次打开新会话时使用 " + result.selected.model + "。" : result.desktopDefault ? "已切回 Codex 共用的默认模型。" : "已切回原订阅，下次启动将沿用客户端原有设置。");
      }
    } catch (e) {
      if (!signal.aborted) setNotice(e instanceof Error ? e.message : "切换失败，请重试。");
      if (desktop && !signal.aborted) {
        const status = await request<Source>("model-source/status",signal,{agent:agent.id}).catch(() => undefined);
        if (status && !signal.aborted) setSource(status);
      }
    }
    finally { if (!signal.aborted) setBusy(false); }
  }
  return <CloudSourceBar current={source ? source.selected?.model ?? source.desktopDefault ?? (desktop ? "Codex 当前提供方" : "原订阅") : "读取中"} cloud={Boolean(source?.selected)}
    detail={source?.selected ? "盒子转发至云端 · 新会话支持文字问答" : "新会话沿用客户端登录与默认模型"}
    subscriptionLabel={source?.desktopDefault ? "Codex 默认" : "原订阅"} disabled={!source || busy} canChoose={Boolean(source?.connected)}
    onChoose={() => void perform(true)} onRestore={() => void perform(false)}>
    {source?.recoveryError && <p className="my-ai-feedback" role="alert">{source.recoveryError}
      <button type="button" className="my-ai-button" disabled={busy} onClick={() => void perform(false)}>恢复原模型配置</button></p>}
    {source && !source.connected && <p className="my-ai-feedback" role="status">连接盒子后可选择云模型。</p>}
    {gateway && <div className="my-ai-native-gateway">
      <p role="status">{gateway.receivedAt
        ? "最近云端回执 · " + new Date(gateway.receivedAt).toLocaleTimeString() + " · " + source?.selected?.model
        : "已写入 Codex 模型配置。重新打开 Codex 后发起新对话，云端回执将在这里显示。"}</p>
    </div>}
    {!open && notice && <p role="status" className="my-ai-feedback">{notice}</p>}
    <Modal open={open} title="选择记忆盒子云模型" subtitle={desktop ? "确认后自动修改 Codex 模型配置。Codex 桌面与 CLI 共用此默认值，切回原订阅会恢复切换前的设置。" : agent.name + " 的新会话将通过盒子发送至所选云服务。"}
      onClose={() => { if (!busy) setOpen(false); }} closeLabel="关闭模型选择" closeContent={<X size={16}/>}
      footer={<><button className="my-ai-button" disabled={busy} onClick={() => setOpen(false)}>取消</button>
        <button className="my-ai-button primary" disabled={!choice || busy} onClick={() => void perform(false,choice)}>确认使用盒端模型</button></>}>
      {models.length ? <fieldset className="my-ai-cloud-picker"><legend className="sr-only">已授权的云端模型</legend>
        {models.map(m => <label key={m.ref}><input type="radio" checked={choice===m.ref} onChange={() => setChoice(m.ref)}/>
          <span><strong>{m.name}</strong><small>{m.ref}</small></span></label>)}</fieldset> : <p>当前盒子没有已授权的云端文字模型。</p>}
      {notice && <p role="alert">{notice}</p>}
    </Modal>
  </CloudSourceBar>;
}
