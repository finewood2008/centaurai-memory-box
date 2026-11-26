import { useState } from "react";
import { createRoot } from "react-dom/client";
import { Bell, Box, ChevronDown } from "lucide-react";
import { DemoModelSource } from "./demo-model-source";
import brand from "../../../../apps/personal-client/local-ui/renderer/assets/centaurai-mark.png";
import myAiIcon from "../../../../apps/personal-client/local-ui/renderer/assets/section-icons-v2/my-ai.png";
import { MyAiCollaboration, MyAiModeTabs } from "../../../../../memory/App/frontend/desktop/src/pages/memory/wanx-my-ai-collaboration";
import type { MyAiRequest, TaskSources } from "../../../../../memory/App/frontend/desktop/src/pages/memory/wanx-my-ai-model";
import "../../../../../memory/App/frontend/desktop/src/styles.css";
import "../../../../../memory/App/frontend/desktop/src/wanx-memory.css";
import "./demo.css";

const task = "根据产品讨论、个人空间里的发布清单和星图仓库，给出记忆盒子首发试点方案。列出推荐范围、上线门槛和待确认事项。";
const catalog = {
  space: [{ id: "release", name: "记忆盒子 · 首发资料" }],
  starlink: [{ id: "product", name: "记忆盒子 · 产品星图" }],
  memory: [{ id: "product-team", name: "产品讨论" }],
};
const initialSources: TaskSources = { folder: catalog.space[0], warehouse: catalog.starlink[0], memoryEnabled: true, memoryAgent: catalog.memory[0].id };
const evidence = [
  { id: "E1", kind: "space", title: "首发发布清单.md", locator: { label: "首发资料 / 首发发布清单.md" },
    text: "对外邀请前，逐一验收个人空间、星图和历史记忆的授权、读取与撤销。试点期间每份研究结果须能回到原始片段；核证通过后可由体验者导出 Markdown。" },
  { id: "E2", kind: "starlink", title: "首发用户与使用场景", locator: { label: "产品星图 · 正文第 4 段" },
    text: "首批优先邀请已有盒子、经常跨多个资料来源做方案的用户。观察他们能否独立完成一次资料授权、结果复核和方案导出。" },
  { id: "E3", kind: "memory", title: "产品讨论 · 首发试点范围", locator: { label: "产品讨论 / 试点范围复盘" },
    text: "首批先验证 Mac 上的资料研究。讨论中提出 10 人与 20 人两个候选规模，具体邀请人数和观察期由产品负责人确认。" },
] as const;
const roles = [
  { id: "claude", name: "Claude", destination: "Anthropic", model: "Claude · 试点模型", configured: true },
  { id: "gemini", name: "Gemini", destination: "Google", model: "Gemini · 试点模型", configured: true },
  { id: "gpt", name: "GPT", destination: "OpenAI", model: "GPT · 试点模型", configured: true },
];

type Scenario = "success" | "conflict" | "unavailable";
interface Selection { folderId?: string; warehouseId?: string; memoryAgent?: string }
type Data = { kind?: string; parent?: string; id?: string; previewId?: string; task?: string; selection?: Selection; evidenceIds?: string[] };

function buildDemo(scenario: Scenario) {
  const recipients = roles.map(row => scenario === "unavailable" && row.id === "gemini"
    ? { ...row, model: null, configured: false } : row);
  const previous = new Map<string, ReturnType<typeof job>>();
  let currentPreview: { previewId: string; task: string; selection: Selection; evidence: typeof evidence[number][] } | undefined;
  const cancelled = new Set<string>();

  function job(id: string, task: string, selection: Selection, approved: typeof evidence[number][]) {
    let created = Date.now();
    return { id, task, selection, evidence: approved, createdAt: created };
  }

  function status(entry: ReturnType<typeof job>) {
    const elapsed = Date.now() - entry.createdAt;
    const cites = (id: string) => entry.evidence.some(item => item.id === id) ? [id] : [];
    const claim = (text: string, ids: string[]) => ({ text, evidenceIds: ids.flatMap(cites) });
    const findings = [
      claim("发布清单要求验证三类资料的授权、读取和撤销，报告中的引用应能回到原始片段。", ["E1"]),
      claim("优先邀请已有盒子、常做跨资料方案的用户，观察他们能否独立完成研究闭环。", ["E2"]),
    ].filter(item => item.evidenceIds.length);
    const questions = ["请产品负责人确认首批邀请人数、观察期和试点负责人。"];
    const report = {
      recommendation: claim(entry.evidence.length
        ? "先做小范围 Mac 试点。完成三类资料的权限验收后，邀请高频研究用户体验选资料、核对出处和导出报告。"
        : "先明确试点范围、验收条件和待确认事项。补充发布清单与用户研究资料后再确定邀请范围。", ["E1", "E2", "E3"]),
      findings,
      disagreements: cites("E3").length ? [claim("讨论中有 10 人和 20 人两个候选规模。建议从 10 人起步，确认使用频率与核证质量后再扩围。", ["E3"])] : [],
      questions,
    };
    const analyses = {
      ...(elapsed >= 1500 && { claude: { recommendation: claim("先完成资料权限和引用验收，再邀请首批用户。", ["E1"]), findings, questions } }),
      ...(elapsed >= 2500 && { gemini: { recommendation: claim("优先选择已有盒子且常做跨资料研究的用户。", ["E2"]), findings: findings.slice(-1), questions } }),
    };
    if (cancelled.has(entry.id)) return { ...entry, state: "cancelled", analyses };
    if (elapsed < 3200) return { ...entry, state: "researching", analyses };
    if (elapsed < 4700) return { ...entry, state: "synthesizing", analyses };
    if (elapsed < 6700) return { ...entry, state: "reviewing", reviewRound: 1, analyses, report };
    if (scenario === "conflict") {
      const issues = [{ severity: "blocking", text: "产品讨论只记录了两种试点规模，后续执行负责人和最终名单仍缺少确认。请核对新的决策记录。" }];
      if (elapsed < 8000) return { ...entry, state: "revising", reviewRound: 1, analyses, report, issues };
      if (elapsed < 9000) return { ...entry, state: "reviewing", reviewRound: 2, analyses, report, issues };
      return { ...entry, state: "needs-review", reviewRound: 2, analyses, report, issues };
    }
    return { ...entry, state: "completed", reviewRound: 1, analyses, report };
  }

  const request: MyAiRequest = async <T,>(action: string, signal: AbortSignal, raw?: object) => {
    signal.throwIfAborted();
    const data = raw as Data;
    let result: unknown;
    switch (action) {
      case "collaboration/config": result = { available: scenario !== "unavailable", boxReady: true, recipients }; break;
      case "collaboration/catalog": {
        result = data.kind === "space" ? { folders: data.parent ? [] : catalog.space }
          : data.kind === "starlink" ? { warehouses: catalog.starlink } : { agents: catalog.memory };
        break;
      }
      case "collaboration/list": result = { jobs: [...previous.values()].reverse().map(status) }; break;
      case "collaboration/preview": {
        const selection = data.selection ?? {};
        const snippets = evidence.filter(item => Boolean(selection[item.kind === "space" ? "folderId" : item.kind === "starlink" ? "warehouseId" : "memoryAgent"]));
        currentPreview = { previewId: crypto.randomUUID(), task: data.task ?? task, selection, evidence: snippets };
        result = { ...currentPreview, recipients, expiresAt: Date.now() + 600_000, notices: [] };
        break;
      }
      case "collaboration/start": {
        if (data.previewId !== currentPreview?.previewId || !currentPreview || scenario === "unavailable") throw Error("协作任务无法启动。");
        const selected = currentPreview.evidence.filter(item => data.evidenceIds?.includes(item.id));
        const entry = job(currentPreview.previewId, currentPreview.task, currentPreview.selection, selected);
        previous.set(entry.id, entry);
        result = status(entry);
        break;
      }
      case "collaboration/cancel":
      case "collaboration/status":
      case "collaboration/export": {
        const entry = previous.get(data.id ?? "");
        if (!entry) throw Error("任务不可用。");
        if (action === "collaboration/cancel") cancelled.add(entry.id);
        const snapshot = status(entry);
        if (action !== "collaboration/export") { result = snapshot; break; }
        if (snapshot.state !== "completed" || !snapshot.report) throw Error("核证通过后才能导出。");
        const citing = (claim: { text: string; evidenceIds: string[] }) => claim.text + claim.evidenceIds.map(id => " [" + id + "]").join("");
        const markdown = ["# 试点研究方案", entry.task, "## 推荐方案", citing(snapshot.report.recommendation),
          "## 证据与发现", ...snapshot.report.findings.map(citing),
          "## 方案分歧", ...snapshot.report.disagreements.map(citing),
          "## 待确认事项", ...snapshot.report.questions,
          "## 证据出处", ...entry.evidence.map(item => item.id + " " + item.title + "\n\n" + item.text)].join("\n\n");
        const link = document.createElement("a");
        link.href = URL.createObjectURL(new Blob([markdown], { type: "text/markdown" }));
        link.download = "记忆盒子首发试点研究方案.md";
        link.click();
        setTimeout(() => URL.revokeObjectURL(link.href), 500);
        result = { saved: true };
        break;
      }
      default: throw Error("无效的演示操作。");
    }
    return result as T;
  };
  return request;
}

function Demo() {
  const [scenario, setScenario] = useState<Scenario>("success");
  const [request, setRequest] = useState(() => buildDemo("success"));
  const [collaboration, setCollaboration] = useState(false);
  const [connected, setConnected] = useState(true);
  return <>
    <header className="demo-top">
      <div className="demo-brand"><img src={brand} alt="" /><div><strong>半人马AI记忆盒子</strong><small>MemoBox</small></div></div>
      <nav aria-label="管理导航">{["我的 AI", "记忆", "星图", "空间", "盒子", "配件"].map((item, i) =>
        <span key={item} aria-current={i === 0 ? "page" : undefined}>{item}</span>)}</nav>
      <div className="demo-account"><Bell size={17} aria-hidden="true" /><span>嘉</span><ChevronDown size={13} aria-hidden="true" /></div>
    </header>
    <header className="demo-banner">
      <div><img src={myAiIcon} alt="" /><div><h1>我的 AI</h1><p>为智能体选择本次任务的资料范围，管理会话记忆采集。</p></div></div>
      <p data-connected={connected || collaboration}><Box size={16} aria-hidden="true" />演示盒子 · {connected || collaboration ? "已连接" : "未连接"}</p>
    </header>
    <main className="wanx-memory-settings wanx-my-ai demo-workspace">
      <div className="demo-toolbar">
        <MyAiModeTabs collaboration={collaboration} onChange={setCollaboration} />
        {collaboration ? <label className="demo-select">演示场景<select value={scenario} onChange={event => {
          const next = event.target.value as Scenario;
          setScenario(next);
          setRequest(() => buildDemo(next));
          setCollaboration(true);
        }}><option value="success">核证通过</option><option value="conflict">证据冲突</option><option value="unavailable">模型不可用</option></select></label> :
          <label className="demo-select">演示盒子<select value={connected ? "on" : "off"}
            onChange={event => setConnected(event.target.value === "on")}>
            <option value="on">已连接</option><option value="off">未连接</option>
          </select></label>}
      </div>
      <div hidden={collaboration}><DemoModelSource connected={connected} /></div>
      {collaboration && <MyAiCollaboration key={scenario} request={request} onBack={() => setCollaboration(false)}
        initialTask={task} initialSources={initialSources} memoryNames={{ "product-team": "产品讨论" }} />}
      <p className="demo-disclosure">交互原型 · 使用虚构资料，模型与盒子状态为演示。</p>
    </main>
  </>;
}

createRoot(document.getElementById("root")!).render(<Demo />);
