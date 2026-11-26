import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Check, ChevronDown, CircleAlert, Download, FileText, History, Layers2,
  LoaderCircle, LockKeyhole, Network, Plus, X } from "lucide-react";
import claudeLogo from "../../assets/agent-logos/claude-code.svg";
import geminiLogo from "../../assets/model-logos/gemini.svg";
import openaiLogo from "../../assets/model-logos/openai.svg";
import { Modal } from "../../components/modal.js";
import { AgentSources } from "./wanx-agent-sources.js";
import type { MyAiRequest, TaskSources } from "./wanx-my-ai-model.js";
import "./wanx-my-ai-collaboration.css";

type Provider = "claude" | "gemini" | "gpt";
interface Recipient { id: Provider; name: string; destination: string; model: string | null; configured: boolean }
interface Config { available: boolean; boxReady: boolean; recipients: Recipient[] }
interface Selection { folderId?: string; warehouseId?: string; memoryAgent?: string }
interface Evidence {
  id: string; kind: "space" | "starlink" | "memory"; title: string; text: string;
  locator: { label?: string };
}
interface Claim { text: string; evidenceIds: string[] }
interface Analysis { recommendation: Claim; findings: Claim[]; questions: string[] }
type State = "researching" | "synthesizing" | "reviewing" | "revising" | "completed" | "needs-review" | "cancelled" | "failed" | "interrupted";
interface JobSummary { id: string; task: string; state: State; createdAt: number }
interface Job extends JobSummary {
  evidence: Evidence[]; selection: Selection; analyses: Partial<Record<Provider, Analysis>>;
  report?: Analysis & { disagreements: Claim[] };
  issues?: Array<{ severity: "blocking" | "advisory"; text: string }>;
  reviewRound?: number; failure?: string;
}
interface Preview { previewId: string; task: string; evidence: Evidence[]; notices: string[]; recipients: Recipient[]; expiresAt: number }

const logos = { claude: claudeLogo, gemini: geminiLogo, gpt: openaiLogo };
const roles = { claude: "主笔与汇总", gemini: "独立研究", gpt: "证据核对" };
const names = { space: "个人空间", starlink: "星图仓库", memory: "历史记忆" };
const statusText: Record<State, string> = {
  researching: "独立研究中", synthesizing: "正在汇总方案", reviewing: "正在核对证据", revising: "正在修订方案",
  completed: "已通过核证", "needs-review": "待你核对", cancelled: "已取消", failed: "任务未完成", interrupted: "已中断",
};
const phases = ["独立研究", "汇总方案", "核对证据"];
const active = (state: State) => ["researching", "synthesizing", "reviewing", "revising"].includes(state);
const date = new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
const emptySources: TaskSources = { memoryEnabled: false };

export function MyAiCollaboration({ request, onBack, initialTask = "", initialSources = emptySources, memoryNames }: {
  request: MyAiRequest; onBack: () => void; initialTask?: string; initialSources?: TaskSources; memoryNames?: Record<string, string>;
}) {
  const [config, setConfig] = useState<Config>();
  const [draft, setDraft] = useState(initialTask);
  const [sources, setSources] = useState(initialSources);
  const [ready, setReady] = useState(false);
  const [preview, setPreview] = useState<Preview>();
  const [approved, setApproved] = useState<string[]>([]);
  const [job, setJob] = useState<Job>();
  const [history, setHistory] = useState<JobSummary[]>([]);
  const [citation, setCitation] = useState<Evidence>();
  const [analysis, setAnalysis] = useState<Provider>();
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const lifecycle = useRef<AbortController | null>(null);
  const working = useRef(false);
  const retainedSources = useRef(initialSources);
  const lastJob = useRef<Job | undefined>(undefined);
  const heading = useRef<HTMLHeadingElement>(null);
  const precedingFocus = useRef<HTMLElement | null>(null);
  const page = job ? "job" : preview ? "preview" : "draft";
  const jobId = job?.id;
  const jobRunning = Boolean(job && active(job.state));

  const requestSources: MyAiRequest = useCallback(async <T,>(action: string, signal: AbortSignal, data?: object) => {
    const input = data as { kind?: string; parent?: string } | undefined;
    if (action === "agent-context/catalog")
      return request<T>("collaboration/catalog", signal, { kind: input?.kind, parent: input?.parent });
    if (action === "agent-context/status") return { boxReady: config?.boxReady === true } as T;
    const picked = retainedSources.current;
    return { selection: picked, resources: picked } as T;
  }, [request, config?.boxReady]);

  const fetchHistory = useCallback(async (signal: AbortSignal) => {
    const result = await request<{ jobs: JobSummary[] }>("collaboration/list", signal);
    if (!signal.aborted) setHistory(result.jobs);
    return result.jobs;
  }, [request]);

  useEffect(() => {
    const controller = new AbortController();
    lifecycle.current = controller;
    const { signal } = controller;
    void (async () => {
      const result = await request<Config>("collaboration/config", signal);
      if (signal.aborted) return;
      setConfig(result);
      if (result.boxReady) {
        const entries = await fetchHistory(signal);
        const running = entries.find(entry => active(entry.state));
        if (running && !working.current && !lastJob.current) {
          const current = await request<Job>("collaboration/status", signal, { id: running.id });
          if (!signal.aborted && !working.current && !lastJob.current) {
            lastJob.current = current;
            setJob(current);
          }
        }
      }
    })().catch(cause => {
      if (!signal.aborted) setError(cause instanceof Error ? cause.message : "协作任务暂不可用。");
    });
    return () => controller.abort();
  }, [request, fetchHistory]);

  const rememberJob = useCallback((next: Job) => {
    lastJob.current = next;
    setJob(next);
    const item = { id: next.id, task: next.task.slice(0, 160), state: next.state, createdAt: next.createdAt };
    setHistory(current => current.some(entry => entry.id === next.id)
      ? current.map(entry => entry.id === next.id ? item : entry) : [item, ...current]);
  }, []);

  useEffect(() => {
    if (!jobId || !jobRunning) return;
    const controller = new AbortController();
    let pending = false;
    const poll = async () => {
      if (pending || working.current) return;
      pending = true;
      try {
        const next = await request<Job>("collaboration/status", controller.signal, { id: jobId });
        if (!controller.signal.aborted && lastJob.current?.id === next.id && active(lastJob.current.state)) {
          rememberJob(next);
        }
      } catch (cause) {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "暂时无法读取任务进度。");
      } finally { pending = false; }
    };
    const timer = window.setInterval(() => void poll(), 850);
    return () => { window.clearInterval(timer); controller.abort(); };
  }, [jobId, jobRunning, request, rememberJob]);

  useEffect(() => { if (page !== "draft") heading.current?.focus(); }, [page]);

  async function doAction(action: string, perform: (signal: AbortSignal) => Promise<void>) {
    const signal = lifecycle.current?.signal;
    if (working.current || !signal || signal.aborted) return;
    working.current = true;
    setBusy(action);
    setError("");
    setMessage("");
    try { await perform(signal); }
    catch (cause) { if (!signal.aborted) setError(cause instanceof Error ? cause.message : "协作操作未完成。"); }
    finally { working.current = false; if (!signal.aborted) setBusy(""); }
  }

  function updateSources(value: TaskSources) {
    retainedSources.current = value;
    setSources(value);
  }

  function displayJob(value: Job) {
    rememberJob(value);
    setPreview(undefined);
  }

  function editTask(reset = false) {
    if (reset) { setDraft(initialTask); updateSources(initialSources); }
    lastJob.current = undefined;
    setJob(undefined);
    setPreview(undefined);
    setError("");
    setMessage("");
  }

  function retry() {
    if (!job) return;
    setDraft(job.task);
    updateSources({
      ...(job.selection.folderId && { folder: { id: job.selection.folderId, name: "上次选择的文件夹" } }),
      ...(job.selection.warehouseId && { warehouse: { id: job.selection.warehouseId, name: "上次选择的仓库" } }),
      memoryEnabled: Boolean(job.selection.memoryAgent), memoryAgent: job.selection.memoryAgent,
    });
    editTask();
  }

  function initialPreview() {
    void doAction("preview", async signal => {
      const value = await request<Preview>("collaboration/preview", signal, { task: draft, selection: {
        folderId: sources.folder?.id, warehouseId: sources.warehouse?.id,
        memoryAgent: sources.memoryEnabled ? sources.memoryAgent ?? undefined : undefined,
      } });
      if (!signal.aborted) {
        setPreview(value);
        setApproved([]);
      }
    });
  }

  function start() {
    if (!preview) return;
    void doAction("start", async signal => {
      const value = await request<Job>("collaboration/start", signal, { previewId: preview.previewId, evidenceIds: approved });
      if (!signal.aborted) displayJob(value);
    });
  }

  function openCitation(item: Evidence, target: HTMLElement) {
    precedingFocus.current = target;
    setCitation(item);
  }

  function closeDetail() {
    setCitation(undefined);
    setAnalysis(undefined);
    precedingFocus.current?.focus();
    precedingFocus.current = null;
  }

  function renderClaim(item: Claim) {
    return <>{item.text}{item.evidenceIds.map(ref => {
      const evidence = job?.evidence.find(row => row.id === ref);
      return evidence && <button key={ref} type="button" className="my-ai-collab-cite" aria-label={ref + " " + evidence.title}
        onClick={event => openCitation(evidence, event.currentTarget)}>{ref}</button>;
    })}</>;
  }

  const recipients = preview?.recipients ?? config?.recipients ?? [];
  const phaseIndex = job?.state === "researching" ? 0 : job?.state === "synthesizing" ? 1 : 2;
  const hasDraft = job?.report != null;
  const successful = job?.state === "completed";
  const analysisResult = analysis ? job?.analyses[analysis] : undefined;
  const activeHistory = history.find(item => active(item.state));

  return <div className="my-ai-workbench my-ai-collab">
    <aside className="my-ai-agents my-ai-collab-sidebar" aria-label="协作任务列表">
      <div className="my-ai-section-heading"><h2>协作任务</h2>
        <button className="my-ai-icon-button" type="button" title="新建协作" aria-label="新建协作"
          disabled={Boolean(busy) || jobRunning} onClick={() => editTask(true)}><Plus size={18} /></button>
      </div>
      <button className="my-ai-agent my-ai-collab-new" type="button" aria-pressed={!job} disabled={Boolean(busy) || jobRunning}
        onClick={() => editTask()}><span className="my-ai-agent-logo"><Network size={16} /></span>
        <span className="my-ai-agent-label"><strong>新建协作</strong><small>资料研究与方案</small></span></button>
      <h3>最近任务</h3>
      {history.length ? <div className="my-ai-agent-list">{history.map(item => (
        <button key={item.id} type="button" className="my-ai-agent" aria-pressed={job?.id === item.id}
          disabled={Boolean(busy)} onClick={() => void doAction("status", async signal => {
            const value = await request<Job>("collaboration/status", signal, { id: item.id });
            if (!signal.aborted) displayJob(value);
          })}>
          <span className="my-ai-agent-logo"><FileText size={16} /></span>
          <span className="my-ai-agent-label"><strong title={item.task}>{item.task}</strong><small>{statusText[item.state]} · {date.format(item.createdAt)}</small></span>
        </button>))}</div> : <p className="my-ai-help">暂无协作任务。</p>}
      <div className="my-ai-collab-scope"><LockKeyhole size={14} aria-hidden="true" /><span>每次任务单独确认资料</span></div>
    </aside>
    <section className="my-ai-task my-ai-collab-main" aria-labelledby="collab-page-title">
      {page === "draft" && <>
        <div className="my-ai-collab-title"><span className="my-ai-collab-mark"><Network size={20} /></span><div>
          <h2 id="collab-page-title">发起协作任务</h2>
          <p>独立研究、交叉核证，交付一份带出处的方案。</p>
        </div></div>
        <section className="my-ai-collab-section" aria-labelledby="collab-role-title">
          <h3 id="collab-role-title">参与智能体</h3>
          <div className="my-ai-collab-roles">{recipients.map(item => (
            <div className="my-ai-collab-role" key={item.id}>
              <span className="my-ai-agent-logo"><img src={logos[item.id]} alt="" /></span>
              <span><strong>{item.name}</strong><small>{roles[item.id]}</small></span>
              <span className="my-ai-collab-dot" data-ready={item.configured}
                title={item.configured ? "协作模型已配置" : "协作模型未配置"} aria-label={item.configured ? "协作模型已配置" : "协作模型未配置"} />
            </div>))}
          </div>
          {config && !config.available && <div className="my-ai-collab-notice" data-tone="warning">
            <CircleAlert size={16} /><span>{recipients.filter(row => !row.configured).map(row => row.name).join("、")} 的协作模型尚未配置。</span>
            <button type="button" className="my-ai-button" onClick={onBack}>使用单智能体</button>
          </div>}
        </section>
        <section className="my-ai-collab-section" aria-labelledby="collab-draft-title">
          <h3 id="collab-draft-title">任务目标</h3>
          <div className="my-ai-prompt-box my-ai-collab-composer">
            <label className="my-ai-text-field">
              <span className="sr-only">任务目标</span>
              <textarea rows={4} value={draft} maxLength={12000} placeholder="例如：结合发布清单、产品讨论和星图资料，拟一份首发试点方案。"
                disabled={Boolean(busy)} onChange={event => setDraft(event.target.value)} />
            </label>
            <AgentSources taskOnly request={requestSources} agent="collaboration" name="本次任务" refresh={0}
              sources={sources} memoryNames={memoryNames} onSourcesChange={updateSources} onReady={setReady} disabled={Boolean(busy) || !config} />
          </div>
        </section>
        <div className="my-ai-collab-footer">
          <p className="my-ai-help"><LockKeyhole size={14} />先在本机和盒子查找资料，下一步可核对将发送的片段。</p>
          <button type="button" className="my-ai-button primary" disabled={!draft.trim() || !ready || !config?.boxReady || Boolean(busy) || Boolean(activeHistory)}
            onClick={initialPreview}>{busy === "preview" ? "正在查找资料…" : "预览资料"} {busy === "preview" ? <LoaderCircle size={15} className="animate-spin" /> : <ArrowRight size={16} />}</button>
        </div>
        {activeHistory && <p className="my-ai-help">有一项协作正在运行，可在最近任务中查看。</p>}
      </>}
      {preview && !job && <>
        <button type="button" className="my-ai-button my-ai-collab-back" disabled={Boolean(busy)} onClick={() => editTask()}><ArrowLeft size={15} />返回编辑</button>
        <div className="my-ai-collab-title"><span className="my-ai-collab-mark"><LockKeyhole size={20} /></span><div>
          <h2 tabIndex={-1} ref={heading} id="collab-page-title">确认发送资料</h2>
          <p>勾选可发送的片段，任务原话也会一并发送。</p>
        </div></div>
        <div className="my-ai-collab-preview-body">
          <section className="my-ai-collab-section" aria-labelledby="collab-preview-title">
            <h3 id="collab-preview-title">任务原话</h3><p className="my-ai-collab-draft">{preview.task}</p>
            <h3>可用资料 <span className="my-ai-collab-count">{approved.length} / {preview.evidence.length} 已选</span></h3>
            {preview.notices.map(notice => <p key={notice} className="my-ai-help">{notice}</p>)}
            {!preview.evidence.length && <p className="my-ai-help">暂无可发送的片段，本次可仅发送任务原话。</p>}
            <div className="my-ai-collab-evidence">{preview.evidence.map(item => (
              <div key={item.id} className="my-ai-collab-evidence-item" data-checked={approved.includes(item.id)}>
                <label><input type="checkbox" disabled={Boolean(busy)} checked={approved.includes(item.id)}
                  onChange={event => setApproved(current => event.target.checked ? [...current, item.id] : current.filter(id => id !== item.id))} />
                  <span><strong>{item.title}</strong><small>{item.id} · {names[item.kind]}</small></span>
                </label>
                <details><summary><ChevronDown size={14} />原文片段</summary><p>{item.text}</p></details>
              </div>
            ))}</div>
          </section>
          <section className="my-ai-collab-section my-ai-collab-recipients" aria-labelledby="collab-recipient-title">
            <h3 id="collab-recipient-title">发送给谁</h3>
            {recipients.map(item => <div key={item.id} className="my-ai-collab-role">
              <span className="my-ai-agent-logo"><img src={logos[item.id]} alt="" /></span>
              <span><strong>{item.name} · {item.destination}</strong><small>{item.model ?? "协作模型未配置"}</small></span>
            </div>)}
            <p className="my-ai-help">Claude 和 Gemini 先独立出稿。Claude 会收到两份意见并汇总，GPT 会收到汇总稿和已选片段做核证，核证意见可回给 Claude 修订。</p>
          </section>
        </div>
        <div className="my-ai-collab-footer">
          <p className="my-ai-help"><LockKeyhole size={14} />仅授权本次任务。取消任务可停止后续发送。</p>
          <button type="button" className="my-ai-button primary" disabled={!config?.available || Boolean(busy)} onClick={start}>
            {busy === "start" ? "正在开始…" : "确认并开始"} <ArrowRight size={16} /></button>
        </div>
      </>}
      {job && <>
        <button type="button" className="my-ai-button my-ai-collab-back" onClick={() => editTask()} disabled={Boolean(busy) || jobRunning}><ArrowLeft size={15} />返回新建</button>
        <div className="my-ai-collab-title"><span className="my-ai-collab-mark"><FileText size={20} /></span><div>
          <h2 tabIndex={-1} ref={heading} id="collab-page-title">{jobRunning ? "协作进行中" : hasDraft ? "研究方案" : "协作任务详情"}</h2>
          <p>{job.task}</p>
        </div></div>
        <div className="my-ai-collab-jobbar">
          <span className="my-ai-collab-status" data-state={job.state} role="status">{jobRunning
            ? <LoaderCircle size={15} className="animate-spin" /> : successful ? <Check size={15} /> : <CircleAlert size={15} />}
            {statusText[job.state]}{job.reviewRound ? " · 第 " + job.reviewRound + " 轮" : ""}</span>
          {jobRunning ? <button type="button" className="my-ai-button" disabled={Boolean(busy)} onClick={() => void doAction("cancel", async signal => {
            const value = await request<Job>("collaboration/cancel", signal, { id: job.id });
            if (!signal.aborted) displayJob(value);
          })}>取消任务</button> : successful ? <button type="button" className="my-ai-button primary" disabled={Boolean(busy)}
            onClick={() => void doAction("export", async signal => {
              const value = await request<{ saved: boolean }>("collaboration/export", signal, { id: job.id });
              if (!signal.aborted && value.saved) setMessage("Markdown 已导出。");
            })}><Download size={15} />导出 Markdown</button> : <button className="my-ai-button" type="button" onClick={retry}>重新预览资料</button>}
        </div>
        {jobRunning && <>
          <ol className="my-ai-collab-phases" aria-label="协作进度">
            {phases.map((phase, index) => <li key={phase} data-state={index < phaseIndex ? "done" : index === phaseIndex ? "current" : "waiting"}
              aria-current={index === phaseIndex ? "step" : undefined}><span>{index < phaseIndex ? <Check size={14} /> : index + 1}</span>{phase}</li>)}
          </ol>
          <p className="my-ai-help">你可以切回单智能体，稍后从最近任务回来查看进度。</p>
        </>}
        {job.failure && <p className="my-ai-feedback error" role="alert">{job.failure}</p>}
        {job.issues?.length ? <div className="my-ai-collab-notice" data-tone={job.issues.some(issue => issue.severity === "blocking") ? "warning" : "info"}>
          <CircleAlert size={16} /><div><strong>{job.issues.some(issue => issue.severity === "blocking") ? "需要核对的疑点" : "核证建议"}</strong>
            <ul>{job.issues.map((issue, index) => <li key={index}>{issue.text}</li>)}</ul></div>
        </div> : null}
        {job.report && <div className="my-ai-collab-report">
          <section><h3>推荐方案</h3><p>{renderClaim(job.report.recommendation)}</p></section>
          {job.report.findings.length > 0 && <section><h3>证据与发现</h3><ul>{job.report.findings.map((item, index) => <li key={index}>{renderClaim(item)}</li>)}</ul></section>}
          {job.report.disagreements.length > 0 && <section><h3>方案分歧</h3><ul>{job.report.disagreements.map((item, index) => <li key={index}>{renderClaim(item)}</li>)}</ul></section>}
          {job.report.questions.length > 0 && <section><h3>待确认事项</h3><ul>{job.report.questions.map((item, index) => <li key={index}>{item}</li>)}</ul></section>}
        </div>}
        <section className="my-ai-collab-section" aria-labelledby="collab-analysis-title">
          <h3 id="collab-analysis-title"><Layers2 size={16} />独立研究</h3>
          <div className="my-ai-collab-roles my-ai-collab-analysis">{(["claude", "gemini"] as const).map(provider => (
            <button key={provider} type="button" className="my-ai-collab-role" disabled={!job.analyses[provider]}
              onClick={event => { precedingFocus.current = event.currentTarget; setAnalysis(provider); }}>
              <span className="my-ai-agent-logo"><img src={logos[provider]} alt="" /></span>
              <span><strong>{provider === "claude" ? "Claude" : "Gemini"}</strong><small>{job.analyses[provider] ? "查看研究意见" : jobRunning ? "正在研究" : "暂无阶段产出"}</small></span>
              {job.analyses[provider] ? <ArrowRight size={16} /> : jobRunning && <LoaderCircle size={16} className="animate-spin" />}
            </button>
          ))}</div>
        </section>
        <Modal open={Boolean(analysisResult)} title={(analysis === "claude" ? "Claude" : "Gemini") + " 的独立研究"}
          className="my-ai-app-chooser" closeLabel="关闭研究意见" closeContent={<X size={17} />} onClose={closeDetail}>
          {analysisResult && <div className="my-ai-collab-report"><section><h3>研究建议</h3><p>{analysisResult.recommendation.text}</p></section>
            {analysisResult.findings.length > 0 && <section><h3>发现</h3><ul>{analysisResult.findings.map((item, index) =>
              <li key={index}>{item.text} {item.evidenceIds.join(" · ")}</li>)}</ul></section>}
            {analysisResult.questions.length > 0 && <section><h3>待确认</h3><ul>{analysisResult.questions.map((item, index) => <li key={index}>{item}</li>)}</ul></section>}</div>}
        </Modal>
        <Modal open={Boolean(citation)} title={citation?.title ?? "证据出处"} subtitle={citation && citation.id + " · " + names[citation.kind]}
          backdropClassName="my-ai-collab-drawer-backdrop" className="my-ai-app-chooser my-ai-collab-drawer"
          closeLabel="关闭证据出处" closeContent={<X size={17} />} onClose={closeDetail} headerIcon={<FileText size={18} />}>
          {citation && <div className="my-ai-collab-report"><section><h3>已确认的原文片段</h3>
            {citation.locator.label && <p className="my-ai-help">{citation.locator.label}</p>}<blockquote>{citation.text}</blockquote></section></div>}
        </Modal>
      </>}
      {error && <p className="my-ai-feedback error" role="alert">{error}</p>}
      {message && <p className="my-ai-feedback" role="status">{message}</p>}
    </section>
  </div>;
}

export function MyAiModeTabs({ collaboration, onChange }: { collaboration: boolean; onChange: (value: boolean) => void }) {
  return <div className="my-ai-collab-tabs" role="group" aria-label="我的 AI 模式">
    <button className="my-ai-button" type="button" aria-pressed={!collaboration} onClick={() => onChange(false)}><History size={15} />单智能体</button>
    <button className="my-ai-button" type="button" aria-pressed={collaboration} onClick={() => onChange(true)}><Network size={15} />协作任务</button>
  </div>;
}
