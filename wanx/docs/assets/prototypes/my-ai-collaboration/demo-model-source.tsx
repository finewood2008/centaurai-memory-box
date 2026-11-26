import { useRef, useState } from "react";
import { ArrowUpRight, Box, CircleAlert, Clock3, X } from "lucide-react";
import codexLogo from "../../../../../memory/App/frontend/desktop/src/assets/agent-logos/codex.svg";
import claudeLogo from "../../../../../memory/App/frontend/desktop/src/assets/agent-logos/claude-code.svg";
import googleLogo from "../../../../../memory/App/frontend/desktop/src/assets/agent-logos/google.svg";
import { Modal } from "../../../../../memory/App/frontend/desktop/src/components/modal";

import { CloudSourceBar } from "../../../../../memory/App/frontend/desktop/src/pages/memory/wanx-my-ai-cloud-source";

const agents = [
  { id: "codex-desktop", name: "Codex 客户端", logo: codexLogo, account: "ChatGPT 账号" },
  { id: "codex", name: "Codex CLI", logo: codexLogo, account: "ChatGPT 账号" },
  { id: "claude", name: "Claude Code CLI", logo: claudeLogo, account: "Claude 账号" },
  { id: "google", name: "Google Antigravity", logo: googleLogo, account: "Google 账号" },
] as const;
const boxModels = [
  { id: "flash", name: "DeepSeek Flash", path: "由盒子转发至云端" },
  { id: "deepseek", name: "DeepSeek V4 Pro", path: "由盒子转发至云端" },
] as const;
type AgentId = typeof agents[number]["id"];
type ModelId = typeof boxModels[number]["id"];

interface Session {
  id: number;
  agent: AgentId;
  source: "盒端模型" | "原订阅";
  model: string;
  draft: string;
}

export function DemoModelSource({ connected }: { connected: boolean }) {
  const [agentId, setAgentId] = useState<AgentId>("codex-desktop");
  const [selected, setSelected] = useState<Partial<Record<AgentId, ModelId>>>({});
  const [picker, setPicker] = useState(false);
  const [choice, setChoice] = useState<ModelId>(boxModels[0].id);
  const [draft, setDraft] = useState("");
  const [sessions, setSessions] = useState<Session[]>([]);
  const [message, setMessage] = useState("");
  const bar = useRef<HTMLElement>(null);
  const feedback = useRef<HTMLDivElement>(null);
  const agent = agents.find(item => item.id === agentId)!;
  const model = boxModels.find(item => item.id === selected[agentId]);
  const history = sessions.filter(item => item.agent === agentId);

  function editModel() {
    setChoice(model?.id ?? boxModels[0].id);
    setPicker(true);
  }

  function closePicker() {
    setPicker(false);
    bar.current?.querySelector<HTMLButtonElement>('[aria-haspopup="dialog"]')?.focus();
  }

  function useBoxModel() {
    if (!connected) return;
    const chosen = boxModels.find(item => item.id === choice)!;
    setSelected(current => ({ ...current, [agentId]: chosen.id }));
    setMessage(agentId === "codex-desktop" ? "已模拟写入 Codex 模型配置，重新打开后使用 " + chosen.name + "。" :
      "已切换。下一次 " + agent.name + " 会话将使用 " + chosen.name + "。");
    closePicker();
  }

  function restoreSubscription() {
    setSelected(current => ({ ...current, [agentId]: undefined }));
    setMessage("已切回原订阅。下一次会话将使用 " + agent.account + " 的默认模型。");
    feedback.current?.focus();
  }

  function startSession() {
    if (model && !connected) return;
    const source = model ? "盒端模型" : "原订阅";
    const description = model?.name ?? agent.account + "默认模型";
    setSessions(current => [{ id: current.length + 1, agent: agentId, source, model: description, draft: draft.trim() }, ...current]);
    setMessage("已模拟启动 " + agent.name + " 新会话，使用" + source + "。");
    setDraft("");
  }

  return <div className="my-ai-workbench demo-model-workbench">
    <aside className="my-ai-agents demo-model-sidebar" aria-labelledby="demo-agent-heading">
      <div className="my-ai-section-heading"><h2 id="demo-agent-heading">智能体</h2></div>
      <div className="my-ai-agent-list">{agents.map(item => {
        const chosen = boxModels.find(candidate => candidate.id === selected[item.id]);
        return <button key={item.id} type="button" className="my-ai-agent" aria-pressed={item.id === agentId}
          aria-label={item.name} aria-description={chosen?.name ?? "原订阅"}
          onClick={() => { if (item.id !== agentId) { setAgentId(item.id); setDraft(""); setMessage(""); } }}>
          <span className="my-ai-agent-logo"><img src={item.logo} alt="" /></span>
          <span className="my-ai-agent-label"><strong>{item.name}</strong><small>{chosen?.name ?? "原订阅"}</small></span>
        </button>;
      })}</div>
    </aside>
    <section ref={bar} className="my-ai-task my-ai-collab-main" aria-labelledby="demo-current-agent">
      <div className="my-ai-collab-title">
        <span className="my-ai-agent-logo demo-model-agent-mark"><img src={agent.logo} alt="" /></span>
        <div><h2 id="demo-current-agent">{agent.name}</h2><p>{agent.account}已登录 · 演示</p></div>
      </div>
      <CloudSourceBar current={model?.name ?? "原订阅"} cloud={Boolean(model)}
        detail={model ? "盒子转发至云端 · 新会话支持文字问答" : "新会话沿用客户端登录与默认模型"}
        canChoose={connected} onChoose={editModel} onRestore={restoreSubscription}>
        {!connected && <p className="my-ai-collab-notice demo-model-warning" data-tone="warning" role="status">
          <CircleAlert size={16} />盒子未连接。{model ? "可手动切回原订阅后启动新会话。" : "连接盒子后可选用盒端模型。"}
        </p>}
      </CloudSourceBar>
      <section className="my-ai-collab-section demo-model-composer" aria-labelledby="demo-session-title">
        <h3 id="demo-session-title">发起一个任务</h3>
        <div className="my-ai-prompt-box">
          <label className="my-ai-text-field"><span className="sr-only">任务草稿</span>
            <textarea rows={2} value={draft} maxLength={12000} onChange={event => setDraft(event.target.value)}
              placeholder="输入任务草稿，或直接打开一个新会话。" /></label>
          <div className="demo-model-launch"><p className="my-ai-help">新会话将使用{model ? " " + model.name : agent.account + "的默认模型"}。</p>
            <button className="my-ai-button primary" type="button" disabled={Boolean(model && !connected)}
              onClick={startSession}>启动新会话 <ArrowUpRight size={15} /></button></div>
        </div>
      </section>
      <div role="status" className="demo-model-feedback" tabIndex={-1} ref={feedback}>{message}</div>
      <section className="my-ai-collab-section" aria-labelledby="demo-session-history">
        <h3 id="demo-session-history"><Clock3 size={15} />已启动的演示会话</h3>
        {history.length === 0 ? <p className="my-ai-help">启动后可在这里核对会话使用的模型。</p> :
          <ol className="demo-model-history">{history.map(item => <li key={item.id}>
            <span className="demo-model-history-name"><strong>会话 {item.id}</strong>{item.draft && <span>{item.draft}</span>}</span>
            <span className="demo-model-history-detail"><span className="demo-model-source-label" data-box={item.source === "盒端模型"}>{item.source}</span>{item.model}</span>
          </li>)}</ol>}
      </section>
      <Modal open={picker} title="选择记忆盒子模型" subtitle={agentId === "codex-desktop" ? "模拟自动修改 Codex 模型配置。Codex 桌面与 CLI 共用默认配置。" : "所选模型用于 " + agent.name + " 的下一次会话。"}
        headerIcon={<Box size={18} />} className="my-ai-app-chooser" onClose={closePicker}
        closeLabel="关闭模型选择" closeContent={<X size={17} />}
        footer={<><button className="my-ai-button" type="button" onClick={closePicker}>取消</button>
          <button className="my-ai-button primary" type="button" disabled={!connected} onClick={useBoxModel}>确认使用盒端模型</button></>}>
        <fieldset className="demo-model-picker">
          <legend className="sr-only">盒端模型列表</legend>
          {boxModels.map(item => <label key={item.id} data-selected={item.id === choice}>
            <input type="radio" name="demo-box-model" checked={choice === item.id} onChange={() => setChoice(item.id)} />
            <span><strong>{item.name}</strong><small>{item.path}</small></span>
          </label>)}
        </fieldset>
      </Modal>
    </section>
  </div>;
}
