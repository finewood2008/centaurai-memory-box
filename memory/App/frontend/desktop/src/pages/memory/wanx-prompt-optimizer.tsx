import { useEffect, useRef, useState } from "react";
import { ArrowRight, Check, Sparkles, X } from "lucide-react";
import { Modal } from "../../components/modal.js";
import type { Agent, MyAiRequest, TaskSelection } from "./wanx-my-ai-model.js";

interface Props {
  request: MyAiRequest; agent: Agent; mode?: string; initialDraft: string; selection: TaskSelection;
  onClose: () => void; onAdopt: (text: string, draft: string) => void;
}

export function PromptOptimizer({ request, agent, mode, initialDraft, selection, onClose, onAdopt }: Props) {
  const [draft, setDraft] = useState(initialDraft);
  const [output, setOutput] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const operation = useRef<AbortController | null>(null);

  useEffect(() => () => operation.current?.abort(), []);

  async function optimize() {
    if (operation.current || !draft.trim()) return;
    const controller = new AbortController();
    operation.current = controller;
    setBusy(true);
    setError("");
    try {
      const value = await request<{ text: string }>("optimize", controller.signal, {
        agent: agent.id, mode, draft: draft.trim(), agentContext: selection,
      });
      if (!controller.signal.aborted) setOutput(value.text);
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "优化未完成，请重试。");
    } finally {
      if (!controller.signal.aborted) {
        operation.current = null;
        setBusy(false);
      }
    }
  }

  function cancel() {
    operation.current?.abort();
    operation.current = null;
    setBusy(false);
  }

  return <Modal open title="优化提示词" subtitle={agent.name} headerIcon={<Sparkles size={19} />}
    className="my-ai-optimizer" closeLabel="关闭提示词优化" closeContent={<X size={17} />} closeDisabled={busy} onClose={onClose}
    footer={output === undefined ? <>
      {busy && <button type="button" className="my-ai-button" onClick={cancel}>取消优化</button>}
      <button type="button" className="my-ai-button primary" disabled={busy || !draft.trim()} onClick={() => void optimize()}>
        {busy ? "正在优化…" : "开始优化"}<ArrowRight size={15} aria-hidden="true" />
      </button>
    </> : <>
      <button type="button" className="my-ai-button" onClick={() => setOutput(undefined)}>返回草稿</button>
      <button type="button" className="my-ai-button primary" disabled={!output.trim() || output.length > 16000}
        onClick={() => onAdopt(output.trim(), draft)}><Check size={15} aria-hidden="true" />采用提示词</button>
    </>}>
    {output === undefined ? <>
      <label className="opt-field"><strong>任务原文</strong>
        <textarea rows={4} maxLength={12000} value={draft} disabled={busy} onChange={event => setDraft(event.target.value)} />
      </label>
      <p className="opt-note">使用盒子默认模型。若已选择星图，优化时会参考其相关片段。</p>
    </> : <label className="opt-field"><strong>优化稿</strong>
      <textarea aria-label="优化稿" rows={8} maxLength={16000} value={output} onChange={event => setOutput(event.target.value)} />
    </label>}
    {error && <p className="my-ai-feedback error" role="alert">{error}</p>}
  </Modal>;
}
