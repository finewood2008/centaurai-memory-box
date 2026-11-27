import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, Clipboard, Sparkles } from "lucide-react";
import { Modal } from "../../components/modal.js";
import { AgentSources } from "./wanx-agent-sources.js";
import { PromptOptimizer } from "./wanx-prompt-optimizer.js";
import { modeCapabilities, type Agent, type MyAiRequest, type TaskSelection, type TaskSources } from "./wanx-my-ai-model.js";

interface TaskInput { agent: string; mode?: string; text: string; agentContext: TaskSelection }
interface Review { confirmation: string; context: { agentName: string; model: string; sources: TaskSources }; input: TaskInput }
interface Props {
  request: MyAiRequest; agent: Agent; mode?: string; online: boolean; sourceRefresh: number;
  supportsSources: boolean; memoryNames: Record<string, string>; goal: string; onGoalChange: (value: string) => void;
}
const emptySources = (): TaskSources => ({ memoryEnabled: false });
const hasSources = (source: TaskSources) => Boolean(source.folder || source.warehouse || source.memoryEnabled);
const selection = (source: TaskSources): TaskSelection => ({
  folderId: source.folder?.id,
  warehouseId: source.warehouse?.id,
  memoryEnabled: source.memoryEnabled === true,
  ...(source.memoryEnabled && source.memoryAgent !== undefined && { memoryAgent: source.memoryAgent }),
});

function sourceSummary(sources: TaskSources, memoryNames: Record<string, string>) {
  return [
    sources.warehouse && "星图 · " + sources.warehouse.name,
    sources.folder && "空间 · " + sources.folder.name,
    sources.memoryEnabled && ("记忆 · " + (sources.memoryAgent ? memoryNames[sources.memoryAgent] ?? sources.memoryAgent
      : sources.memoryAgent === null ? "全部智能体" : "默认范围")),
  ].filter(Boolean).join(" / ") || "未授权检索资料";
}

export function MyAiTaskLaunch({ request, agent, mode, online, sourceRefresh, supportsSources, memoryNames, goal, onGoalChange }: Props) {
  const [sources, setSources] = useState<TaskSources>(emptySources);
  const [prompt, setPrompt] = useState<string | null>(null);
  const [review, setReview] = useState<Review>();
  const [optimizer, setOptimizer] = useState(false);
  const [operation, setOperation] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const lifecycle = useRef<AbortController | null>(null);
  const working = useRef(false);
  useEffect(() => {
    const controller = new AbortController();
    lifecycle.current = controller;
    return () => controller.abort();
  }, [request]);

  const canPick = online && supportsSources;
  const blocked = hasSources(sources) && !canPick;
  const text = (prompt ?? goal).trim();
  const terminal = modeCapabilities(agent, mode ?? "chat")?.delivery === "terminal-confirm";

  function editSources(value: TaskSources) {
    setSources(value);
    setPrompt(null);
    setError("");
    setMessage("");
  }

  async function run(label: string, perform: (signal: AbortSignal) => Promise<void>) {
    const signal = lifecycle.current?.signal;
    if (!signal || signal.aborted || working.current) return;
    working.current = true;
    setOperation(label);
    setError("");
    setMessage("");
    try { await perform(signal); }
    catch (cause) { if (!signal.aborted) setError(cause instanceof Error ? cause.message : "操作未完成，请重试。"); }
    finally {
      if (!signal.aborted) { working.current = false; setOperation(""); }
    }
  }

  function reviewTask() {
    void run("正在核对", async signal => {
      const input = { agent: agent.id, mode, text, agentContext: selection(sources) };
      const approval = await request<Omit<Review, "input">>("review-handoff", signal, input);
      if (!signal.aborted) setReview({ ...approval, input });
    });
  }

  function deliver(action: "handoff" | "copy") {
    if (!review) return;
    void run("正在交接", async signal => {
      setReview(undefined);
      const reply = await request<{ opened?: boolean; prepared?: boolean; copied?: boolean }>(action, signal, {
        ...review.input, confirmation: review.confirmation,
      });
      if (signal.aborted) return;
      if (reply.prepared) setMessage("终端待核对。请核对提示词和资料范围，按回车开始。");
      else if (reply.copied) setMessage(reply.opened
        ? "已复制提示词并请求打开应用。请在智能体客户端粘贴后发送。"
        : "已复制提示词。请在智能体客户端粘贴后发送。");
      else if (reply.opened) setMessage("已请求打开草稿。请在智能体客户端核对后发送。");
      else setError("暂时无法确认交接结果。请先检查智能体客户端，再决定是否重试。");
    });
  }

  return <section className="my-ai-composer" aria-labelledby="my-ai-task-title">
    <h3 id="my-ai-task-title">发起任务</h3>
    <div className="my-ai-task-card">
      <label className="my-ai-text-field">任务草稿
        <textarea value={goal} rows={4} maxLength={12000} placeholder="例如：整理发布清单，列出待办事项。" disabled={Boolean(operation)}
          onChange={event => { onGoalChange(event.target.value); setPrompt(null); setError(""); setMessage(""); }} />
      </label>
      {canPick && <AgentSources request={request} agent={agent.id} mode={mode} name={agent.name}
        refresh={sourceRefresh} sources={sources} memoryNames={memoryNames} taskOnly allowAllMemory
        onSourcesChange={editSources} onReady={() => {}} disabled={Boolean(operation)} />}
      {supportsSources && !online && <p className="my-ai-help">连接盒子后可以选择任务资料。</p>}
      {(canPick || hasSources(sources)) && <div className="my-ai-actions">
        {canPick && <button type="button" className="my-ai-button" disabled={Boolean(operation)} onClick={() => void run("正在读取资料范围", async signal => {
          const value = await request<{ selection: TaskSelection; resources: TaskSources; warning?: string }>(
            "agent-context/selection", signal, { agent: agent.id, mode },
          );
          if (value.warning) throw new Error(value.warning);
          if (!signal.aborted) editSources({ ...value.resources, memoryEnabled: value.selection.memoryEnabled, memoryAgent: value.selection.memoryAgent });
        })}>沿用智能体默认范围</button>}
        {hasSources(sources) && <button type="button" className="my-ai-button" disabled={Boolean(operation)}
          onClick={() => editSources(emptySources())}>清空本次资料</button>}
      </div>}
      {prompt !== null && <label className="my-ai-text-field">优化后的提示词
        <textarea value={prompt} rows={5} maxLength={16000} disabled={Boolean(operation)}
          onChange={event => { setPrompt(event.target.value); setError(""); setMessage(""); }} />
      </label>}
      <div className="my-ai-actions my-ai-task-footer">
        <button type="button" className="my-ai-button" disabled={Boolean(operation) || !goal.trim() || !online || blocked}
          onClick={() => setOptimizer(true)}><Sparkles size={15} aria-hidden="true" />优化提示词</button>
        <button type="button" className="my-ai-button primary" disabled={Boolean(operation) || !text || blocked}
          onClick={reviewTask}>核对交接</button>
      </div>
    </div>
    {(operation || message) && <p className="my-ai-feedback" role="status">{operation ? operation + "…" : message}</p>}
    {error && <p className="my-ai-feedback error" role="alert">{error}</p>}
    {review && <Modal open title="核对交接" subtitle={review.context.agentName} closeLabel="关闭核对"
      onClose={() => setReview(undefined)} closeDisabled={Boolean(operation)}
      footer={<>
        <button type="button" className="my-ai-button" disabled={Boolean(operation)} onClick={() => deliver("copy")}><Clipboard size={15} aria-hidden="true" />复制提示词</button>
        <button type="button" className="my-ai-button primary" disabled={Boolean(operation) || !agent.installed} onClick={() => deliver("handoff")}>
          {terminal ? "在终端核对任务" : "交给 " + review.context.agentName}<ArrowUpRight size={15} aria-hidden="true" />
        </button>
      </>}>
      <div className="my-ai-task-confirm">
        <dl><dt>模型来源</dt><dd>{review.context.model}</dd><dt>本次资料</dt><dd>{sourceSummary(review.context.sources, memoryNames)}</dd></dl>
        <label className="my-ai-text-field">最终提示词<textarea readOnly rows={7} value={review.input.text} /></label>
        <p className="my-ai-help">{terminal ? "在终端核对后，由你确认开始。" : "在智能体客户端核对后，由你发送。"}</p>
      </div>
    </Modal>}
    {optimizer && <PromptOptimizer request={request} agent={agent} mode={mode} initialDraft={goal}
      selection={selection(sources)} onClose={() => setOptimizer(false)} onAdopt={(output, original) => {
        onGoalChange(original);
        setPrompt(output);
        setError("");
        setMessage("");
        setOptimizer(false);
      }} />}
  </section>;
}
