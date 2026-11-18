import { embeddedHost, bridgeHosted, type OntologyAction, type OntologyCategory, type OntologySection } from "./nativeHost.ts";
import {graphUrl, readGraphSources, type GraphSources} from './graphTransport';
import "./starlink-theme.css";
import { Component, StrictMode, Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import SigmaGraph, { type GraphEdgeData, type GraphNodeData } from "./components/SigmaGraph";
import GraphDetails from "./components/GraphDetails";
import { DeleteIndexNotice, KnowledgeOutcome, MergedScanInfo } from "./components/ProcessingStatus";
import { isMergedScan, jobExecutionLabel, knowledgeStage, type DeleteResult, type KnowledgeSummary } from "./processing";
import { edgeId, nodeId, relationLabel, detectionNotice, sourceLabel, withoutIsolatedNodes, type GraphDetection, type GraphEdge, type GraphNode } from "./graph";
import "./styles.css";
import "./workbench.css";
import { DesignIcon, WorkbenchDrawer, type IconName } from "./components/WorkbenchUI";
import { requestJson } from "./request";
import { loadCorrectionSegments, type CorrectionSource } from './sourceCorrection';
import { readDocumentLibrary } from "./documentLibrary";
import { startVisiblePolling, taskPollDelay } from "./polling";
import OntologyEditor, {ConfigurationDrawer, type OntologyEditRequest} from "./components/OntologyEditor";
import OntologyChangeSummary from './components/OntologyChangeSummary';
import OntologyCatalog from "./components/OntologyCatalog";
import OntologyVersionSummary from './components/OntologyVersionSummary';
import SearchTypeFilter from "./components/SearchTypeFilter";
import SearchSourceDetails, { type IndexSource } from "./components/SearchSourceDetails";
import OntologySuggestions from "./components/OntologySuggestions";
import MaterialOntologyNotice, { useMaterialOntology, materialOntologyLabel } from './components/MaterialOntologyNotice';
import MaterialMaintenance, {useMaterialMaintenance,needsMaterialAttention} from './components/MaterialMaintenance';
import KnowledgeReleases from "./components/KnowledgeReleases";
import OntologyUpdates from './components/OntologyUpdates';
import type { SuggestionPreview } from './ontologySuggestions';
import { newOntologyOperationId, type OntologyTypeChange } from './ontologySuggestions';
import { ontologyIssues, type OntologyDefinition } from "./ontology";
import type {SelectedKnowledgeSource} from './corrections';
const SkillWorkbench = lazy(() => import("./components/SkillPackages"));
const DocumentKnowledgeCorrections = lazy(() => import("./components/DocumentKnowledgeCorrections"));

class WorkbenchErrorBoundary extends Component<{children: ReactNode}, {failed: boolean}> {
  state = {failed: false};
  static getDerivedStateFromError() { return {failed: true}; }
  render() {
    if (this.state.failed) return <main className="workbench-app"><section className="knowledge-card" role="alert" style={{gridColumn: '1 / -1', margin: 32}}>
      <h1>页面加载失败</h1><p>工作台资源可能已更新，请重新加载后继续。</p>
      <button type="button" onClick={() => window.location.reload()}>重新加载工作台</button>
    </section></main>;
    return this.props.children;
  }
}

type Status = {
  native_owner_management?: boolean;
  integration_mode?: "standalone" | "managed";
  local_data_gate_mode?: "legacy" | "required";
  version: string;
  phase: string;
  knowledge_auto_pipeline: boolean;
  knowledge_auto_pipeline_ready: boolean;
  job_history_retention_days: number;
  job_auto_retry_enabled?: boolean;
  job_auto_retry_delays_seconds?: number[];
  mcp_enabled: boolean;
  mcp_port: number;
  mcp_path: string;
  mcp_authentication: boolean;
  llm_provider: string;
  llm_configured: boolean;
  embedding_provider: string;
  embedding_configured: boolean;
  local_models: Record<string, boolean>;
  neo4j_configured: boolean;
  document_formats: string[];
  document_max_bytes: number;
  document_max_image_pixels: number;
  ocr_render_dpi: number;
  asr_max_duration_seconds: number;
};

type DocumentItem = {
  id: string;
  original_name: string;
  document_format: string;
  size_bytes: number;
  status: string;
  job_id: string | null;
  job_status: string | null;
  segment_count: number;
  created_at: string;
  original_url: string;
};

type JobMetrics = Record<string, unknown> & {
  processing_seconds?: number;
  total_processing_seconds?: number;
  started_at?: string;
  execution_active?: boolean;
  cache_reused_fields?: number;
  cross_revision_reused_texts?: number;
  detection_failures?: Array<{ text_hash: string; text_length: number; reason: string }>;
  vectors_reused?: number;
  vectors_generated?: number;
  index_chunks_reused?: number;
  index_chunks_generated?: number;
  index_chunking_seconds?: number;
  index_persisting_seconds?: number;
  embedding_seconds?: number;
  embedding_load_seconds?: number;
  fields?: number;
  pending_texts?: number;
  new_detected_texts?: number;
  replacement_job_id?: string;
  extraction_batches_reused?: number;
  failed_batches?: number;
  extraction_failures?: Array<{ batch_index: number; reason: string }>;
  auto_retry?: { state: string; attempts: number; max_attempts?: number; manual_retries?: number;
    next_retry_at?: string | null; last_error_message?: string };
};

function autoRetryText(job: Job): string | null {
  const retry = job.metrics?.auto_retry;
  if (!retry) return null;
  const attempts = `自动重试 ${retry.attempts ?? 0}/${retry.max_attempts ?? "—"} 次`;
  if (job.status === "succeeded") return retry.attempts ? `${attempts} · 已完成` : null;
  if (job.status === "cancelled") return `${attempts} · 已取消，不会自动恢复`;
  if (job.status === "failed" && retry.state === "waiting")
    return `${attempts} · 下次 ${jobTime(retry.next_retry_at ?? undefined)} · 可立即重试或取消自动重试`;
  if (job.status === "queued" || job.status === "running")
    return `${attempts} · ${retry.state === "manual" ? "手工重试" : "已安排"}${retry.last_error_message ? ` · 上次：${retry.last_error_message}` : ""}`;
  const states: Record<string, string> = { exhausted: "已达重试上限，请检查原因后手工重试",
    not_retryable: "需要人工检查配置或错误原因", disabled: "自动重试已关闭", superseded: "处理范围已变化，旧任务不再自动重试" };
  return `${attempts} · ${states[retry.state] ?? "等待安排"}`;
}

function processingSeconds(metrics: JobMetrics, status: string): string {
  const elapsed = status === "running" && metrics.execution_active && metrics.started_at
    ? Math.max(0, (Date.now() - Date.parse(metrics.started_at)) / 1000)
    : metrics.processing_seconds;
  return elapsed == null ? "—" : elapsed.toFixed(1);
}

function scanCounts(metrics: JobMetrics): string {
  const reasons: Record<string, string> = {
    value_not_located: "模型命中无法定位到原文", invalid_match: "模型匹配项无效",
    invalid_batch: "批量回复不完整", invalid_json: "模型回复不是有效 JSON",
    context_budget: "模型上下文不足", invalid_model_response: "模型回复校验失败",
    empty_match_value: "模型返回空的敏感内容", invalid_match_value: "模型命中内容格式无效",
    invalid_locator: "模型定位信息无效", invalid_batch_ids: "批量回复遗漏或重复文本编号",
    output_truncated: "模型回复被截断",
    prompt_example_echo: "模型照抄提示词示例",
  };
  const failureCounts = new Map<string, number>();
  for (const failure of metrics.detection_failures ?? []) {
    const label = reasons[failure.reason] ?? "检测异常";
    failureCounts.set(label, (failureCounts.get(label) ?? 0) + 1);
  }
  const failureText = failureCounts.size
    ? ` · 未完成 ${[...failureCounts].map(([label, total]) => `${label} ${total} 种`).join("、")}` : "";
  return `覆盖 ${metrics.fields ?? "—"} 个字段 · 复用 ${metrics.cache_reused_fields ?? 0} 个字段（跨配置 ${metrics.cross_revision_reused_texts ?? 0} 种文本） · 本轮待检测 ${metrics.pending_texts ?? "—"} 种文本 · 已新增检测 ${metrics.new_detected_texts ?? 0} 种文本${failureText}`;
}

type Job = {
  id: string;
  kind: string;
  document_id: string | null;
  document_name?: string | null;
  document_deleted_at?: string | null;
  status: string;
  stage: string;
  completed_units: number;
  total_units: number | null;
  attempt: number;
  error_code: string | null;
  error_message: string | null;
  cancel_requested: boolean;
  created_at: string;
  updated_at: string;
  metrics?: JobMetrics;
  knowledge_summary?: KnowledgeSummary;
};

type JobActivity = {
  foreground_count: number;
  sensitive_job: Pick<Job, "id" | "status" | "metrics"> | null;
};

type JobPageResult = {
  items: Job[];
  total: number;
  limit: number;
  offset: number;
  activity: JobActivity;
};

const jobTimeFormatter = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
});

function jobTime(timestamp?: string): string {
  if (!timestamp) return "—";
  const date = new Date(timestamp);
  return Number.isFinite(date.getTime()) ? jobTimeFormatter.format(date) : "—";
}

type Segment = CorrectionSource & {
  id: string;
  kind: string;
  text: string;
  source_locator: Record<string, unknown>;
  preview_url?: string;
  source_refs?: { segment_id: string; locator: Record<string, unknown>; source_char_start?:number; source_char_end?:number; block_char_start?:number; block_char_end?:number }[];
};

type Detail = {
  document: DocumentItem;
  version: null | {
    id: string;
    version_number: number;
    parser_version: string;
    version_kind: "parsed" | "corrected";
    parent_version_id: string | null;
    metadata: Record<string, unknown>;
  };
  segments: Segment[];
  blocks?: Segment[];
  block_count?: number;
  processing?: { text_ready: boolean; index_ready: boolean; graph_status: string; delivery_status: string; knowledge_summary?: KnowledgeSummary | null };
};

type Ontology = {
  id: string;
  name: string;
  version_number: number;
  status: string;
  schema: OntologyDefinition;
};

type KnowledgeRun = {
  id: string;
  document_id: string;
  document_version_id: string;
  ontology_version_id: string;
  extraction_job_id: string;
  publication_job_id: string | null;
  status: string;
  provider: string;
  model: string;
  prompt_version: string;
  candidate_counts: Record<string, number>;
  error_message: string | null;
};

type Candidate = {
  id: string;
  run_id: string;
  kind: "entity" | "relation";
  candidate_key: string;
  status: string;
  payload: Record<string, unknown>;
  validation_errors: string[];
  evidence: Array<{
    segment_id: string;
    locator: Record<string, unknown>;
    excerpt: string;
  }>;
};

type SearchIndex = {
  id: string;
  version_number: number;
  status: string;
  provider: string;
  model: string;
  dimension: number | null;
  indexed_segments: number;
  job_status?: string;
  job_stage?: string;
};

type SearchIndexStatus = {
  embedding_configured: boolean;
  active: SearchIndex | null;
  compatible: boolean;
  fresh: boolean;
  publishable_segments: number;
  items: SearchIndex[];
};

type SearchHit = {
  id: string;
  document_id: string;
  document_version_id: string;
  segment_id: string;
  text: string;
  locator: Record<string, unknown>;
  entity_types: string[];
  original_name: string;
  score: number;
  channels: string[];
  matched_entities: string[];
  original_url: string;
  preview_url: string | null;
};

type SearchResult = {
  query: string;
  items: SearchHit[];
  graph: { nodes: GraphNode[]; edges: GraphEdge[] };
  next_action?: string;
  message?: string;
  retrieval_status?: string;
  graph_warning: string | null;
  sensitive?: { enabled: boolean; withheld: number; confirmation_count: number; confirmation_token: string | null };
};

type SensitiveRule = {
  id: string;
  name: string;
  kind: "regex" | "semantic";
  source: "built_in" | "custom";
  protected?: boolean;
  enabled: boolean;
  mode: "mask" | "block" | "confirm";
  mask: string;
  masking: { strategy: "full" | "fixed" | "keep_edges"; prefix_characters: number; suffix_characters: number; replacement: string };
  allow_original_after_confirm: boolean;
  description: string;
  examples: string[];
  counter_examples: string[];
};

type SensitiveSettings = {
  revision: number;
  enabled: boolean;
  semantic_enabled: boolean;
  rules: SensitiveRule[];
  builtin_defaults: SensitiveRule[];
  rule_capacity: { custom_count: number; max_custom: number; prompt_used: number; prompt_limit: number };
  llm_provider: string;
  llm_model: string;
  llm_configured: boolean;
  scan: { status: string; completed_units?: number; total_units?: number | null; error_code?: string | null; error_message?: string | null; id?: string; metrics?: JobMetrics };
};

type LLMSettings = {
  revision: number;
  llm_provider: "openai_compatible" | "ollama";
  openai_base_url: string;
  openai_model: string;
  ollama_base_url: string;
  ollama_model: string;
  model_timeout_seconds: number;
  openai_api_key_configured: boolean;
  llm_configured: boolean;
  extraction_strategy: "two_stage" | "joint";
  knowledge_cross_page_batches: boolean;
  llm_concurrency: number;
  llm_context_tokens: number;
  llm_extraction_input_tokens: number;
  llm_extraction_output_tokens: number;
  llm_sensitive_input_tokens: number;
  llm_sensitive_output_tokens: number;
  llm_sensitive_batch_size: number;
  openai_sensitive_batch_size: number;
  openai_sensitive_input_tokens: number;
  openai_sensitive_context_tokens: number;
  ollama_keep_alive: string;
  ollama_think: "auto" | "off" | "on";
  openai_think: "auto" | "off" | "on";
  openai_thinking_format: "auto" | "thinking" | "enable_thinking" | "reasoning_effort";
  openai_structured_output: "text" | "json_object" | "json_schema";
};

const workspaceId = "default";
const segmentPageSize = 200;
const activeStatuses = new Set(["queued", "running"]);
const statusText: Record<string, string> = {
  queued: "等待处理",
  processing: "处理中",
  running: "处理中",
  ready: "可查看",
  succeeded: "已完成",
  failed: "失败",
  cancelled: "已取消",
};
const jobStageText: Record<string, string> = {
  accepted: "等待执行",
  retry_queued: "等待重试",
  extracting: "知识抽取中",
  extracting_entities: "识别实体（等待模型响应）",
  extracting_relations: "识别关系（等待模型响应）",
  extracting_joint: "联合识别实体与关系（等待模型响应）",
  extracting_parallel: "并行识别知识（等待模型响应）",
  review_ready: "抽取完成",
  suggestions_ready: "抽取建议待核对",
  publishing: "知识入图中",
  published: "已入图",
  purged: "已彻底清理",
  retracting_graph: "撤回图证据",
  purging_material: "清理材料与索引",
  cancellation_requested: "正在取消当前任务",
  detecting: "敏感信息识别中",
  waiting_for_foreground: "等待材料处理",
  loading_embedding: "加载向量模型",
  chunking: "准备索引分块",
  embedding: "计算新增向量",
  persisting: "写入处理结果",
  activating_index: "切换活动索引",
};
const jobKindText: Record<string, string> = {
  document_parse: "正文解析", knowledge_extract: "知识抽取",
  knowledge_publish: "知识入图", knowledge_retract: "图谱撤回",
  search_index: "索引构建", sensitive_scan: "脱敏扫描",
};

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / 1024 / 1024).toFixed(1)} MiB`;
}

function highlightStyle(segment: Segment | null) {
  if (!segment) return undefined;
  const locator = segment.source_locator;
  const bbox = locator.bbox;
  if (!Array.isArray(bbox) || bbox.length !== 4) return undefined;
  const width = Number(locator.image_width ?? locator.page_width);
  const height = Number(locator.image_height ?? locator.page_height);
  if (!width || !height) return undefined;
  const [left, top, right, bottom] = bbox.map(Number);
  return {
    left: `${(left / width) * 100}%`,
    top: `${(top / height) * 100}%`,
    width: `${((right - left) / width) * 100}%`,
    height: `${((bottom - top) / height) * 100}%`,
  };
}

const starterOntology: OntologyDefinition =
  {
    entity_types: [
      { name: "PERSON", label: "人物", properties: [] },
      { name: "ORG", label: "组织", properties: [] },
    ],
    relation_types: [
      {
        name: "WORKS_AT",
        label: "任职于",
        source_types: ["PERSON"],
        target_types: ["ORG"],
        properties: [],
      },
    ],
  };

function OntologyView({ report: onReport, onLeaveStateChange, initialPreview, onImport, navigation, onNavigationHandled }: {
  report: (message: string, error?: boolean) => void;
  onLeaveStateChange: (value: { dirty: boolean; busy: boolean }) => void;
  initialPreview?: SuggestionPreview;
  onImport:(documentId?:string)=>void;
  navigation?: { action: OntologyAction };
  onNavigationHandled: () => void;
}) {
  const [items, setItems] = useState<Ontology[]>([]);
  const [configOpen, setConfigOpen] = useState(Boolean(initialPreview));
  const [draftKind, setDraftKind] = useState<'entity' | 'relation'>('entity');
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [versionFeedback, setVersionFeedback] = useState<{text: string; failed: boolean} | null>(null);
  const report = useCallback((text: string, failed = false) => { setVersionFeedback({text, failed}); onReport(text, failed); }, [onReport]);
  const [name, setName] = useState("业务本体");
  const [definition, setDefinition] = useState(starterOntology);
  const [editRequest, setEditRequest] = useState<OntologyEditRequest>();
  const [pageSelection, setPageSelection] = useState<{kind:'entity'|'relation';index:number|null}|null>(null);
  const [pageApplied, setPageApplied] = useState<{kind:'entity'|'relation';name:string}|null>(null);
  const [operationBusy, setBusy] = useState(false);
  const [impactBusy, setImpactBusy] = useState(false);
  const [drawerDirty,setDrawerDirty]=useState(false);
  const busy=operationBusy||impactBusy;
  const [loaded, setLoaded] = useState(false);
  const initialized = useRef(false);
  const loadSequence = useRef(0);
  const operationPending = useRef(false);
  const [savedConfiguration, setSavedConfiguration] = useState('');
  const configuration = JSON.stringify({ name, definition });
  const dirty = loaded && configuration !== savedConfiguration;
  const [createdConfiguration, setCreatedConfiguration] = useState<string | null>(null);
  const [createdVersionId,setCreatedVersionId]=useState<string>();
  const editorBaselineId=useRef<string|undefined>(undefined);
  const editorState=useRef({dirty,createdVersionId});
  editorState.current={dirty:dirty||drawerDirty,createdVersionId};
  const [rowPublication,setRowPublication]=useState<string>();
  const created = createdConfiguration === configuration;
  const [suggestionPreviewIds, setSuggestionPreviewIds] = useState<string[]>([]);
  const [impact,setImpact]=useState<{ id:string; fromHistory?:boolean }>();
  const suggestionReviews = useRef<Record<string, boolean>>({});
  const recordSuggestionReview = useCallback((id: string, complete: boolean) => { suggestionReviews.current[id] = complete; }, []);
  const [suggestionEpoch, setSuggestionEpoch] = useState(0);
  const [suggestionFocus, setSuggestionFocus] = useState(0);
  const [suggestedMaterials, setSuggestedMaterials] = useState(false);
  const [suggestionTypeChanges, setSuggestionTypeChanges] = useState<OntologyTypeChange[]>([]);
  const suggestionSave = useRef<{ fingerprint: string; operationId: string } | null>(null);
  const issues = ontologyIssues(definition);
  const currentOntology = items.find(item=>item.status==='published');
  const pageEditorBase = !configOpen && !dirty && !created && currentOntology ? currentOntology.schema : definition;
  const consumedNavigation = useRef<typeof navigation>(undefined);
  const host = embeddedHost();
  const adding = pageSelection?.index === null;
  const category: OntologyCategory = configOpen ? 'drafts' : 'published';
  const section: OntologySection = adding ? (pageSelection.kind === 'entity' ? 'add-entity' : 'add-relation') : category;
  const showSection = !host || (!versionsOpen && !impact);
  const showPublished = showSection && (!host || section === 'published');
  const showDrafts = showSection && (!host ? configOpen || !currentOntology : section === 'drafts');
  const savedDrafts = items.filter(item => item.status === 'draft');
  const draftCount = savedDrafts.length;

  useEffect(() => {
    host?.ontologySectionChanged?.(window, section, category);
    if (host) document.querySelector('.app-content')?.scrollTo({ top: 0 });
  }, [host, section, category, versionsOpen, impact]);

  function navigateRules(action:OntologyAction) {
    if (busy) {
      report('本体操作正在处理中，请等待完成后再试。', true);
      return;
    }
    if (action === section && showSection) return;
    if (drawerDirty && !window.confirm('放弃尚未加入草稿的手动编辑？')) return;
    setPageSelection(null);
    setVersionsOpen(false);
    setImpact(undefined);
    if (versionFeedback) { setVersionFeedback(null); onReport(''); }
    switch (action) {
      case 'published': setConfigOpen(false); break;
      case 'drafts': setConfigOpen(true); break;
      case 'suggestions': setConfigOpen(true); setSuggestionFocus(value => value + 1); break;
    }
  }
  useEffect(() => {
    if (!loaded || !navigation || consumedNavigation.current === navigation) return;
    consumedNavigation.current = navigation;
    onNavigationHandled();
    navigateRules(navigation.action);
  });

  useEffect(()=>{
    if(!configOpen||!pageApplied)return;
    const frame=requestAnimationFrame(()=>{
      const row=[...document.querySelectorAll<HTMLElement>('.ontology-editor [data-type-name]')]
        .find(item=>item.dataset.typeKind===pageApplied.kind&&item.dataset.typeName===pageApplied.name);
      row?.scrollIntoView({block:'center'});
      row?.focus({preventScroll:true});
      setPageApplied(null);
    });
    return()=>cancelAnimationFrame(frame);
  },[configOpen,pageApplied]);

  function openTypeEditor(kind:'entity'|'relation', typeName?:string) {
    if(busy||!loaded)return;
    const base=!configOpen?pageEditorBase:definition;
    const list=kind==='entity'?base.entity_types:base.relation_types;
    if(typeName&&!list.some(item=>item.name===typeName)){
      setConfigOpen(true);report('此类型已在待发布配置中更名或删除，请从修改列表选择对应条目。',true);return;
    }
    if(!typeName&&list.length>=(kind==='entity'?100:200)){report('已达到类型数量上限，请先整理现有定义。',true);return;}
    if(host || (!configOpen&&currentOntology)){
      setPageSelection({kind,index:typeName?list.findIndex(item=>item.name===typeName):null});
      return;
    }
    if(base!==definition&&currentOntology){
      const nextName=`${currentOntology.name}（修订）`.slice(0,120);
      setDefinition(structuredClone(base));setName(nextName);
      setSavedConfiguration(JSON.stringify({name:nextName,definition:base}));
      setCreatedConfiguration(null);clearSuggestions();
    }
    setConfigOpen(true);
    setEditRequest({kind,name:typeName,sequence:Date.now()});
  }

  useEffect(() => {
    onLeaveStateChange({ dirty:dirty||drawerDirty, busy });
    if (!dirty && !drawerDirty && !busy) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty, drawerDirty, busy, onLeaveStateChange]);
  useEffect(() => () => {
    loadSequence.current++;
    onLeaveStateChange({ dirty: false, busy: false });
  }, [onLeaveStateChange]);

  function editDefinition(value: OntologyDefinition, change?: OntologyTypeChange) {
    if (JSON.stringify(value) === JSON.stringify(definition)) return;
    setDefinition(value);
    if (change) setSuggestionTypeChanges(previous => [...previous, change]);
  }

  function applyPageTypeEdit(value: OntologyDefinition, change?: OntologyTypeChange) {
    if(pageSelection){
      const list=pageSelection.kind==='entity'?value.entity_types:value.relation_types;
      setDraftKind(pageSelection.kind);
      setPageApplied({kind:pageSelection.kind,name:list[pageSelection.index??list.length-1].name});
    }
    if(pageEditorBase!==definition&&currentOntology){
      const nextName=`${currentOntology.name}（修订）`.slice(0,120);
      setName(nextName);
      setSavedConfiguration(JSON.stringify({name:nextName,definition:pageEditorBase}));
      setCreatedConfiguration(null);
      clearSuggestions();
    }
    editDefinition(value,change);
    setPageSelection(null);
    setConfigOpen(true);
  }

  function clearSuggestions() {
    suggestionReviews.current = {};
    setSuggestionPreviewIds([]);
    setSuggestionTypeChanges([]);
    setSuggestionEpoch(previous => previous + 1);
    setSuggestedMaterials(false);
    suggestionSave.current = null;
  }

  function resetUnsavedConfiguration() {
    if (busy || !savedConfiguration || !window.confirm('撤销全部未保存的配置修改，并清除临时建议？将恢复到本页面最近保存或加载的配置，已保存版本不受影响。')) return;
    const saved = JSON.parse(savedConfiguration) as { name: string; definition: OntologyDefinition };
    setName(saved.name);
    setDefinition(saved.definition);
    clearSuggestions();
    report('已恢复最近保存或加载的配置，可以重新选择材料生成建议。');
  }

  function copyVersion(item: Ontology) {
    if (dirty && !window.confirm('当前未保存的配置将被替换，是否继续？')) return;
    setConfigOpen(true); setVersionsOpen(false);
    editDefinition(structuredClone(item.schema));
    setCreatedConfiguration(null);
    clearSuggestions();
    setName(`${item.name}（修订）`.slice(0, 120));
    report(`已复制 v${item.version_number} 到配置表单，保存时将创建新草稿。`);
  }

  function resumeVersion(item: Ontology) {
    if(busy||item.status!=='draft')return;
    if(dirty&&!window.confirm('放弃当前未保存修改，继续处理这个已保存的规则草稿？'))return;
    const fingerprint=JSON.stringify({name:item.name,definition:item.schema});
    clearSuggestions();setName(item.name);setDefinition(structuredClone(item.schema));
    setSavedConfiguration(fingerprint);setCreatedConfiguration(fingerprint);setCreatedVersionId(item.id);
    setConfigOpen(true);setVersionsOpen(false);setRowPublication(undefined);setVersionFeedback(null);
  }

  const load = useCallback(async () => {
    const sequence = ++loadSequence.current;
    let result: { items: Ontology[] };
    try {
      result = await requestJson<{ items: Ontology[] }>(`/api/ontologies?workspace_id=${workspaceId}`);
    } catch (reason) {
      if (sequence !== loadSequence.current) return;
      throw reason;
    }
    if (sequence !== loadSequence.current) return;
    setItems(result.items);
    const current = result.items.find(item => item.status === 'published');
    const selectedDraft=result.items.some(item=>item.id===editorState.current.createdVersionId&&item.status==='draft');
    // Only rebase an untouched editor. A selected private version remains independent.
    if (!initialized.current || current && current.id!==editorBaselineId.current && !editorState.current.dirty && !selectedDraft) {
      if (current) {
        setDefinition(structuredClone(current.schema));
        setName(`${current.name}（修订）`.slice(0, 120));
      }
      setSavedConfiguration(JSON.stringify({ name: current ? `${current.name}（修订）`.slice(0, 120) : '业务本体', definition: current?.schema ?? starterOntology }));
      if(initialized.current){
        setCreatedConfiguration(null);setCreatedVersionId(undefined);
        setPageSelection(null);setPageApplied(null);setEditRequest(undefined);clearSuggestions();
      }
      editorBaselineId.current=current?.id;
      initialized.current = true;
    }
    setLoaded(true);
  }, []);

  useEffect(() => {
    load().catch((reason: Error) => report(reason.message, true));
  }, [load, report]);

  async function createVersion(openHistory=true) {
    if (!loaded || busy || operationPending.current || created || issues.length || !name.trim()) return;
    operationPending.current = true;
    loadSequence.current++;
    setBusy(true);
    try {
      const body = { workspace_id: workspaceId, name, schema: definition,
        ...(suggestionPreviewIds.length ? { preview_ids: suggestionPreviewIds,
          reviewed_preview_ids: suggestionPreviewIds.filter(id => suggestionReviews.current[id]) } : {}) };
      if (suggestionPreviewIds.length && suggestionSave.current?.fingerprint !== JSON.stringify(body)) {
        suggestionSave.current = { fingerprint: JSON.stringify(body), operationId: newOntologyOperationId() };
      }
      const saved = await requestJson<Ontology>(suggestionPreviewIds.length ? '/api/ontology-suggestions/draft' : '/api/ontologies', {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...body, ...(suggestionPreviewIds.length ? { operation_id: suggestionSave.current!.operationId } : {}) }),
      });
      setItems(previous => [saved, ...previous.filter(item => item.id !== saved.id)]);
      setSavedConfiguration(JSON.stringify({ name, definition }));
      setCreatedConfiguration(configuration);
      setCreatedVersionId(saved.id);
      setVersionsOpen(openHistory);
      setSuggestionPreviewIds([]);
      report("本体草稿版本已创建，请核对后发布。");
      await load().catch(() => report('本体草稿已创建，但版本列表刷新失败；请点击“刷新列表”，无需重复创建。', true));
    } catch (reason) {
      report(reason instanceof Error ? reason.message : "创建本体失败", true);
    } finally {
      operationPending.current = false;
      setBusy(false);
    }
  }

  async function publish(id: string) {
    if (busy || operationPending.current || dirty) return;
    const target = items.find(item => item.id === id);
    if (!target || !window.confirm(`确认发布 v${target.version_number}「${target.name}」？后续抽取将使用此本体版本，已有知识不会自动重建。`)) return;
    operationPending.current = true;
    loadSequence.current++;
    setBusy(true);
    try {
      const published = await requestJson<Ontology>(`/api/ontologies/${id}/publish`, { method: "POST" });
      setItems(previous => previous.map(item => item.id === id ? published : item.status === 'published' ? { ...item, status: 'superseded' } : item));
      const nextName=`${published.name}（修订）`.slice(0,120);
      setDefinition(structuredClone(published.schema));
      setName(nextName);
      setSavedConfiguration(JSON.stringify({name:nextName,definition:published.schema}));
      editorBaselineId.current=published.id;
      setCreatedConfiguration(null);
      setCreatedVersionId(undefined);
      clearSuggestions();
      report("本体版本已发布，后续抽取会固定引用该版本。");
      setRowPublication(undefined);
      setVersionsOpen(false);
      setImpact(undefined);
      setConfigOpen(false);
      await load().catch(() => report('本体版本已发布，但版本列表刷新失败；请点击“刷新列表”，无需重复发布。', true));
    } catch (reason) {
      report(reason instanceof Error ? reason.message : "发布本体失败", true);
    } finally {
      operationPending.current = false;
      setBusy(false);
    }
  }

  return (
    <div className="ontology-page">
      {!host && <div className="ontology-page-actions"><button className="primary" disabled={busy||!loaded} onClick={()=>openTypeEditor('entity')}><DesignIcon name="plus" />添加实体类型</button>
        <button disabled={busy||!loaded} onClick={()=>openTypeEditor('relation')}><DesignIcon name="plus" />添加关系类型</button>
        <button disabled={busy||!loaded} onClick={()=>setConfigOpen(!configOpen)}>{configOpen&&currentOntology?'查看当前生效定义':'管理待发布修改'}{dirty?'（未保存）':''}</button></div>}
      {host && !loaded && <section className="knowledge-card ontology-page-state">
        {versionFeedback?.failed ? <><p role="alert">{versionFeedback.text}</p><button onClick={() => void load().catch((reason: Error) => report(reason.message, true))}>重新读取规则</button></>
          : <p role="status">正在读取本体规则…</p>}
      </section>}
      {host && loaded && showSection && !adding && <div className="rules-workspace-header">
        <div className="rules-workspace-top">
          <nav className="rules-workspace-tabs" aria-label="本体与关系">
            <button type="button" aria-current={category==='published'?'page':undefined} disabled={busy} onClick={()=>navigateRules('published')}>规则总览</button>
          </nav>
          <div className="rules-workspace-version">
            {currentOntology&&<><strong>{currentOntology.name}</strong><span className="badge published">v{currentOntology.version_number} · 生效</span>
              <button type="button" disabled={busy} onClick={()=>setVersionsOpen(true)}>版本与影响</button></>}
            {draftCount===0 && <button type="button" aria-current={category==='drafts'?'page':undefined} disabled={busy} onClick={()=>navigateRules('drafts')}>待发布草稿</button>}
          </div>
        </div>
        {draftCount>0 && <div className="rules-draft-banner" aria-label="未发布规则">
          <div><strong>{draftCount} 份待发布草稿</strong>{currentOntology && <span>当前生效 v{currentOntology.version_number}</span>}</div>
          <button type="button" aria-current={category==='drafts'?'page':undefined} disabled={busy} onClick={()=>navigateRules('drafts')}>查看草稿</button>
        </div>}
      </div>}
      {!host && showPublished && currentOntology && <section className="knowledge-card ontology-current">
        <div><h2>{currentOntology.name} <span className="badge published">v{currentOntology.version_number} · 当前生效</span></h2><p>新导入材料按这套规则提取知识。</p></div>
        <button disabled={busy} onClick={() => setVersionsOpen(true)}>{host ? '版本与影响' : '查看版本历史'}</button>
      </section>}
      {!host && <p className="ontology-notice"><DesignIcon name="info" /> 规则更新仅影响后续材料抽取。历史材料不会自动重做，需要在规则发布后另行选择更新。</p>}
      {host && loaded && showPublished && !currentOntology && <section className="knowledge-card ontology-page-state">
        <h2>当前数据仓还没有生效规则</h2><p>核对实体和关系后，可以发布首个版本。</p>
        <button type="button" onClick={() => setConfigOpen(true)}>查看待发布草稿</button>
      </section>}
      {(host ? showDrafts && loaded && savedDrafts.length > 0 : savedDrafts.length > 0) && <section className="workflow-next ontology-saved-drafts" aria-label="手动编辑草稿">
        <div className="ontology-saved-heading"><h2>{host?'手动编辑草稿':'已保存的草稿'} <span className="badge">{savedDrafts.length}</span></h2>
          {host && <button type="button" disabled={busy} onClick={() => setVersionsOpen(true)}>查看版本历史</button>}
        </div>
        {savedDrafts.map(item=><div className="workflow-draft-row" key={item.id}><span>v{item.version_number} · {item.name}</span><button disabled={busy} onClick={()=>resumeVersion(item)}>继续核对此版本</button></div>)}
      </section>}
      {currentOntology&&(host||showPublished&&!configOpen)&&<div hidden={!!host&&(!showPublished||configOpen)}>
        <OntologyCatalog schema={currentOntology.schema} active={showPublished&&!configOpen} onAdd={host ? openTypeEditor : undefined} onEdit={openTypeEditor} disabled={busy||!loaded} />
      </div>}
      {pageSelection&&(host||currentOntology)&&<ConfigurationDrawer inline={Boolean(host) && adding} key={`${pageSelection.kind}:${pageSelection.index}`} value={pageEditorBase} selection={pageSelection}
        disabled={busy} onDirtyChange={setDrawerDirty} onApply={applyPageTypeEdit} onClose={()=>setPageSelection(null)}
        applyLabel={host ? "加入待发布修改" : undefined} hint="应用后进入待发布修改，核对并保存，再确认发布。" />}
      <div className="ontology-layout">
      <section hidden={!showDrafts || (Boolean(host) && !loaded)} className="knowledge-card ontology-editor">
        <div className="section-title">
          <h2>类型与关系修改</h2>
          {dirty && <span>有未保存的修改</span>}
          {host && !savedDrafts.length && <button type="button" disabled={busy} onClick={() => setVersionsOpen(true)}>查看版本历史</button>}
        </div>
        <div className="form-body">
          <label>
            版本名称
            <input value={name} disabled={busy || !loaded} maxLength={120} onChange={(event) => setName(event.target.value)} />
          </label>
          <OntologyChangeSummary before={currentOntology?.schema} after={definition} />
          <OntologySuggestions key={suggestionEpoch} schema={definition} baseOntologyId={items.find(item => item.status === 'published')?.id}
            focusRequest={suggestionFocus}
            initialPreview={suggestionEpoch===0?initialPreview:undefined}
            onReviewState={recordSuggestionReview}
            disabled={busy || !loaded || issues.length > 0} previewIds={suggestionPreviewIds} typeChanges={suggestionTypeChanges} onBusy={setBusy}
            onAdopt={(schema, previewId) => { editDefinition(schema); setSuggestionPreviewIds(previous => [...new Set([...previous, previewId])]); setSuggestedMaterials(true); }} />
          <OntologyEditor value={definition} onChange={editDefinition} onDraftChange={setDrawerDirty} disabled={busy || !loaded} editRequest={editRequest} creationPlacement="page" onAddType={host ? openTypeEditor : undefined}
            activeKind={host ? draftKind : undefined} onKindChange={setDraftKind}
            published={currentOntology?.schema} saved={created} onPublish={(kind,typeName)=>{setVersionFeedback(null);setRowPublication(`${kind==='entity'?'实体类型':'关系类型'}：${typeName}`);}} />
          {issues.length > 0 && <ul className="ontology-issues" aria-live="polite">{issues.map((issue, index) => <li key={index}>{issue}</li>)}</ul>}
          {suggestedMaterials && <p className="ontology-notice">发布后，仅新抽取使用新规则。提供建议的材料及同类业务材料可能需要补充抽取；请返回“对话整理材料”逐份确认目标与处理计划，不会自动全库重跑。</p>}
          <div className="ontology-draft-actions">
            {suggestionPreviewIds.length > 0 && <button type="button" disabled={busy} onClick={resetUnsavedConfiguration}>撤销未保存配置并清除建议</button>}
            {created && items.some(item => item.id === createdVersionId && item.status === 'draft')
              ? <button className="primary" type="button" disabled={busy} onClick={() => {setVersionFeedback(null);setRowPublication('当前待发布规则版本');}}>核对并发布</button>
              : <button className="primary" type="button" disabled={!loaded || busy || created || !name.trim() || issues.length > 0} onClick={() => void createVersion(!host)}>
              {busy ? "处理中…" : created ? "草稿已保存" : "保存为草稿"}
            </button>}
          </div>
        </div>
      </section>
      {rowPublication&&<WorkbenchDrawer title="核对类型与关系发布" canClose={!busy} close={()=>setRowPublication(undefined)}>
        <p>操作入口：{rowPublication}</p>
        <p className="ontology-notice">实体与关系按完整规则版本一起发布。下面列出本次全部改动，包括其他记录的新增、修改和删除，请一起核对。</p>
        <OntologyChangeSummary before={currentOntology?.schema} after={definition} expanded />
        <p>发布后用于后续抽取。旧材料不会自动重新抽取，可在发布后选择更新范围。</p>
        {versionFeedback&&<p role={versionFeedback.failed?'alert':'status'}>{versionFeedback.text}</p>}
        {issues.length>0&&<ul className="ontology-issues" role="alert">{issues.map((issue,index)=><li key={index}>{issue}</li>)}</ul>}
        <div className="ontology-table-actions">{created&&createdVersionId?<button className="primary" disabled={busy||dirty||items.find(item=>item.id===createdVersionId)?.status!=='draft'} onClick={()=>void publish(createdVersionId)}>确认发布整个版本</button>
          :<button className="primary" disabled={busy||!loaded||!name.trim()||issues.length>0} onClick={()=>void createVersion(false)}>保存待发布版本</button>}
          <button disabled={busy} onClick={()=>setRowPublication(undefined)}>返回列表</button></div>
      </WorkbenchDrawer>}
      {versionsOpen && <WorkbenchDrawer inline={Boolean(host)} className="ontology-history-page" title="类型规则版本历史" closeLabel={host ? '返回' : undefined} close={() => setVersionsOpen(false)} canClose={!busy}><section className="knowledge-card ontology-list">
        {versionFeedback && <p role={versionFeedback.failed ? 'alert' : 'status'} className={versionFeedback.failed ? 'notice error' : 'notice'}>{versionFeedback.text}</p>}
        <div className="section-title">
          <h2>版本历史</h2>
          <span>{items.length} 个版本</span>
          <button type="button" disabled={busy} onClick={() => void load().catch((reason: Error) => report(reason.message, true))}>刷新列表</button>
        </div>
        {dirty && <p className="ontology-notice">当前配置有未保存的修改，请先创建草稿，再发布对应版本。</p>}
        {items.map((item) => (
          <article className="ontology-row ontology-history-row" key={item.id}>
            <div>
              <strong>v{item.version_number} · {item.name}</strong>
              <small>
                {item.schema.entity_types.length} 个实体类型 · {item.schema.relation_types.length} 个关系类型
              </small>
              <OntologyVersionSummary schema={item.schema}/>
              {item.status==='draft'&&<OntologyChangeSummary before={currentOntology?.schema} after={item.schema} />}
            </div>
            <div className="job-actions">
              <span className={`badge ${item.status}`}>{{ draft: '草稿', published: '已发布', superseded: '已替代' }[item.status] || item.status}</span>
              <button type="button" disabled={busy} onClick={() => copyVersion(item)}>复制为新配置</button>
              {item.status === "draft" && (
                <button type="button" disabled={busy || dirty} onClick={() => void publish(item.id)}>发布</button>
              )}
              {item.status==='published'&&<button type="button" disabled={busy||dirty} onClick={()=>{setVersionsOpen(false);setImpact({id:item.id,fromHistory:true});}}>查看影响与更新材料</button>}
            </div>
          </article>
        ))}
      </section>
      </WorkbenchDrawer>}
      </div>
      {!host && !versionsOpen && <div className="ontology-bottom-actions"><span>{savedDrafts.length} 个未发布规则草稿</span></div>}
      {impact&&<WorkbenchDrawer inline={Boolean(host)} title="发布影响与材料更新" className="ontology-updates-drawer" closeLabel={host ? impact.fromHistory ? '返回版本历史' : '返回生效规则' : undefined} canClose={!impactBusy} close={()=>{setImpact(undefined);if(host&&impact.fromHistory)setVersionsOpen(true);}}>
        <Suspense fallback={<p role="status">正在加载材料影响分析…</p>}><OntologyUpdates key={impact.id} workspace={workspaceId} ontologyId={impact.id} onBusy={setImpactBusy} onProcessMaterials={onImport} /></Suspense>
      </WorkbenchDrawer>}
    </div>
  );
}

function ReviewView({
  documents,
  report,
}: {
  documents: DocumentItem[];
  report: (message: string, error?: boolean) => void;
}) {
  const readyDocuments = documents.filter((item) => item.status === "ready");
  const [documentId, setDocumentId] = useState(readyDocuments[0]?.id ?? "");
  const [runs, setRuns] = useState<KnowledgeRun[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [drafts, setDrafts] = useState<Record<string, Record<string, unknown>>>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!documentId && readyDocuments[0]) setDocumentId(readyDocuments[0].id);
  }, [documentId, readyDocuments]);

  const load = useCallback(async () => {
    const result = await requestJson<{ items: KnowledgeRun[] }>(
      `/api/knowledge/runs?workspace_id=${workspaceId}`,
    );
    setRuns(result.items);
    const target = selectedRunId ?? result.items[0]?.id ?? null;
    if (target) {
      setSelectedRunId(target);
      const detail = await requestJson<{ run: KnowledgeRun; candidates: Candidate[] }>(
        `/api/knowledge/runs/${target}`,
      );
      setCandidates(detail.candidates);
      setDrafts((current) => {
        const next = { ...current };
        for (const item of detail.candidates) if (!next[item.id]) next[item.id] = item.payload;
        return next;
      });
    } else {
      setCandidates([]);
    }
  }, [selectedRunId]);

  useEffect(() => {
    load().catch((reason: Error) => report(reason.message, true));
    const timer = window.setInterval(() => {
      load().catch(() => undefined);
    }, 1800);
    return () => window.clearInterval(timer);
  }, [load, report]);

  async function startExtraction() {
    if (!documentId) return;
    setBusy(true);
    try {
      const result = await requestJson<{ run: KnowledgeRun }>(
        `/api/documents/${documentId}/knowledge`,
        { method: "POST" },
      );
      setSelectedRunId(result.run.id);
      report("知识抽取任务已进入队列。完成后请审核候选再发布。");
      await load();
    } catch (reason) {
      report(reason instanceof Error ? reason.message : "启动抽取失败", true);
    } finally {
      setBusy(false);
    }
  }

  async function decide(candidate: Candidate, decision: "approved" | "rejected") {
    try {
      await requestJson(`/api/knowledge/candidates/${candidate.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision, payload: drafts[candidate.id] ?? candidate.payload }),
      });
      await load();
    } catch (reason) {
      report(reason instanceof Error ? reason.message : "候选审核失败", true);
    }
  }

  async function publish() {
    if (!selectedRunId) return;
    try {
      await requestJson(`/api/knowledge/runs/${selectedRunId}/publish`, { method: "POST" });
      report("图谱发布任务已进入队列；仅 Neo4j 写入完成后才会显示为成功。");
      await load();
    } catch (reason) {
      report(reason instanceof Error ? reason.message : "发布失败", true);
    }
  }

  const selectedRun = runs.find((item) => item.id === selectedRunId);
  const candidateByKey = Object.fromEntries(candidates.map((item) => [item.candidate_key, item]));
  return (
    <div className="review-layout">
      <section className="knowledge-card run-sidebar">
        <div className="section-title"><h2>抽取批次</h2><span>{runs.length} 批</span></div>
        <div className="run-create">
          <select value={documentId} onChange={(event) => setDocumentId(event.target.value)}>
            {!readyDocuments.length && <option value="">没有可抽取文档</option>}
            {readyDocuments.map((item) => <option key={item.id} value={item.id}>{item.original_name}</option>)}
          </select>
          <button type="button" disabled={!documentId || busy} onClick={() => void startExtraction()}>
            {busy ? "提交中…" : "开始受约束抽取"}
          </button>
        </div>
        {runs.map((run) => (
          <button
            type="button"
            className={`run-row ${selectedRunId === run.id ? "selected" : ""}`}
            key={run.id}
            onClick={() => setSelectedRunId(run.id)}
          >
            <strong>{documents.find((item) => item.id === run.document_id)?.original_name ?? "已删除材料"}</strong>
            <small>{run.model} · {run.prompt_version}</small>
            <span className={`badge ${run.status}`}>{run.status}</span>
          </button>
        ))}
      </section>
      <section className="knowledge-card candidate-panel">
        <div className="section-title">
          <h2>消歧与候选审核</h2>
          {selectedRun && <span>正文 {selectedRun.document_version_id.slice(0, 8)} · 本体 {selectedRun.ontology_version_id.slice(0, 8)}</span>}
        </div>
        {!selectedRun && <div className="empty">选择材料并启动知识抽取。</div>}
        {selectedRun && !candidates.length && <div className="empty">抽取处理中，候选生成后会在此显示。</div>}
        <div className="candidate-list">
          {candidates.map((candidate) => {
            const payload = drafts[candidate.id] ?? candidate.payload;
            const source = candidateByKey[String(payload.source_candidate_key ?? "")];
            const target = candidateByKey[String(payload.target_candidate_key ?? "")];
            return (
              <article className={`candidate ${candidate.status}`} key={candidate.id}>
                <div className="candidate-heading">
                  <strong>
                    {candidate.kind === "entity"
                      ? `${String(payload.name ?? "") } · ${String(payload.type ?? "")}`
                      : `${String(source?.payload.name ?? "?")} → ${String(payload.type ?? "")} → ${String(target?.payload.name ?? "?")}`}
                  </strong>
                  <span className={`badge ${candidate.status}`}>{candidate.status}</span>
                </div>
                {candidate.kind === "entity" && (
                  <div className="candidate-fields">
                    <label>规范名<input value={String(payload.name ?? "")} onChange={(event) => setDrafts((current) => ({ ...current, [candidate.id]: { ...payload, name: event.target.value } }))} /></label>
                    <label>实体类型<input value={String(payload.type ?? "")} onChange={(event) => setDrafts((current) => ({ ...current, [candidate.id]: { ...payload, type: event.target.value.toUpperCase() } }))} /></label>
                    <label>消歧标识<input value={String(payload.disambiguation_key ?? "")} onChange={(event) => setDrafts((current) => ({ ...current, [candidate.id]: { ...payload, disambiguation_key: event.target.value } }))} /></label>
                    <label>别名（逗号分隔）<input value={Array.isArray(payload.aliases) ? payload.aliases.join(", ") : ""} onChange={(event) => setDrafts((current) => ({ ...current, [candidate.id]: { ...payload, aliases: event.target.value.split(/[,，]/).map((item) => item.trim()).filter(Boolean) } }))} /></label>
                    <label>属性 JSON<input defaultValue={JSON.stringify(payload.properties ?? {})} onBlur={(event) => {
                      try {
                        const properties = JSON.parse(event.target.value) as Record<string, unknown>;
                        if (!properties || Array.isArray(properties) || typeof properties !== "object") throw new Error();
                        setDrafts((current) => ({ ...current, [candidate.id]: { ...payload, properties } }));
                      } catch { report("属性必须是有效的 JSON 对象。", true); }
                    }} /></label>
                  </div>
                )}
                {candidate.kind === "relation" && (
                  <div className="candidate-fields relation-fields">
                    <label>关系类型<input value={String(payload.type ?? "")} onChange={(event) => setDrafts((current) => ({ ...current, [candidate.id]: { ...payload, type: event.target.value.toUpperCase() } }))} /></label>
                    <label>起点候选<input value={String(payload.source_candidate_key ?? "")} onChange={(event) => setDrafts((current) => ({ ...current, [candidate.id]: { ...payload, source_candidate_key: event.target.value } }))} /></label>
                    <label>终点候选<input value={String(payload.target_candidate_key ?? "")} onChange={(event) => setDrafts((current) => ({ ...current, [candidate.id]: { ...payload, target_candidate_key: event.target.value } }))} /></label>
                    <label>属性 JSON<input defaultValue={JSON.stringify(payload.properties ?? {})} onBlur={(event) => {
                      try {
                        const properties = JSON.parse(event.target.value) as Record<string, unknown>;
                        if (!properties || Array.isArray(properties) || typeof properties !== "object") throw new Error();
                        setDrafts((current) => ({ ...current, [candidate.id]: { ...payload, properties } }));
                      } catch { report("属性必须是有效的 JSON 对象。", true); }
                    }} /></label>
                  </div>
                )}
                {candidate.validation_errors.length > 0 && (
                  <p className="validation-errors">{candidate.validation_errors.join("；")}</p>
                )}
                {candidate.evidence[0] && (
                  <blockquote>
                    {sourceLabel(candidate.evidence[0].locator)} · {candidate.evidence[0].excerpt}
                  </blockquote>
                )}
                {(candidate.status === "pending" || candidate.status === "invalid") && (
                  <div className="candidate-actions">
                    <button type="button" onClick={() => void decide(candidate, "approved")}>批准</button>
                    <button type="button" onClick={() => void decide(candidate, "rejected")}>拒绝</button>
                  </div>
                )}
              </article>
            );
          })}
        </div>
        {selectedRun && selectedRun.status !== "published" && (
          <button className="publish-button" type="button" onClick={() => void publish()}>发布到 Neo4j</button>
        )}
      </section>
    </div>
  );
}

function GraphView() {
  const [showIsolated,setShowIsolated]=useState(false);
  const [nodes, setNodes] = useState<GraphNode[]>([]);
  const [edges, setEdges] = useState<GraphEdge[]>([]);
  const [typeLabels, setTypeLabels] = useState<Record<string, string>>({});
  const [relationLabels, setRelationLabels] = useState<Record<string, string>>({});
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [focusedNodeId, setFocusedNodeId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [detection, setDetection] = useState<GraphDetection>();
  const loadController = useRef<AbortController | null>(null);
  const [sourceOffset, setSourceOffset] = useState(0);
  const [sourceReload, setSourceReload] = useState(0);
  const [sourceLoading, setSourceLoading] = useState(false);
  const [sourceError, setSourceError] = useState<string | null>(null);
  const [sources, setSources] = useState<(GraphSources & {factId: string}) | null>(null);
  const ownerGraph = bridgeHosted();
  const sourceEdge = edges.find(edge=>edgeId(edge)===selectedEdgeId);

  const load = useCallback(async (entityId?: string) => {
    loadController.current?.abort();
    const controller = new AbortController();
    loadController.current = controller;
    setLoading(true);
    setLoadError(null);
    setSelectedEdgeId(null);setSources(null);
    try {
      const result = await requestJson<{ nodes: GraphNode[]; edges: GraphEdge[]; detection?: GraphDetection }>(
        graphUrl(workspaceId,ownerGraph,entityId),
        { signal: controller.signal }, 20000,
      );
      if (controller.signal.aborted) return;
      setNodes(result.nodes);
      setEdges(result.edges);
      setDetection(result.detection);
      setSelectedEdgeId(null);
      setFocusedNodeId(entityId || null);
    } catch (reason) {
      if (controller.signal.aborted) return;
      setLoadError(reason instanceof Error ? reason.message : "知识网络加载失败");
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [ownerGraph]);

  useEffect(() => {
    void load();
    return () => loadController.current?.abort();
  }, [load]);

  useEffect(() => {
    const refresh=()=>{setNodes([]);setEdges([]);void load();};
    window.addEventListener('starlink:graph-changed',refresh);
    return ()=>window.removeEventListener('starlink:graph-changed',refresh);
  }, [load]);

  useEffect(() => {
    if (!selectedEdgeId || !sourceEdge) { setSources(null); setSourceError(null); return; }
    const controller = new AbortController();
    setSourceLoading(true);
    setSourceError(null);
    if (sourceOffset === 0) setSources(null);
    readGraphSources(requestJson,workspaceId,ownerGraph,sourceEdge,sourceOffset,controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      setSources((previous) => ({ ...result, factId: selectedEdgeId,
        items: sourceOffset > 0 && previous?.factId === selectedEdgeId
          ? [...previous.items, ...result.items] : result.items }));
    }).catch((reason: unknown) => {
      if (!controller.signal.aborted) setSourceError(reason instanceof Error ? reason.message : "来源加载失败");
    }).finally(() => { if (!controller.signal.aborted) setSourceLoading(false); });
    return () => controller.abort();
  }, [selectedEdgeId, sourceEdge, sourceOffset, sourceReload, ownerGraph]);

  useEffect(() => {
    requestJson<{ items: Ontology[] }>(`/api/ontologies?workspace_id=${workspaceId}`)
      .then(({ items }) => {
        const published = items.find((item) => item.status === "published");
        setTypeLabels(Object.fromEntries(
          (published?.schema.entity_types ?? []).map(({ name, label }) => [name.toUpperCase(), label]),
        ));
        setRelationLabels(Object.fromEntries(
          (published?.schema.relation_types ?? []).map(({ name, label }) => [name.toUpperCase(), label]),
        ));
      })
      .catch(() => { setTypeLabels({}); setRelationLabels({}); });
  }, []);

  const visibleNodes=useMemo(()=>showIsolated?nodes:withoutIsolatedNodes(nodes,edges),[nodes,edges,showIsolated]);
  useEffect(()=>{
    if(focusedNodeId&&!visibleNodes.some(node=>nodeId(node)===focusedNodeId)){
      setFocusedNodeId(null);setSelectedEdgeId(null);
    }
  },[visibleNodes,focusedNodeId]);
  const sigmaNodes: GraphNodeData[] = useMemo(
    () =>
      visibleNodes.map((node) => ({
        id: nodeId(node),
        label: node.canonical_name,
        entityType: node.entity_type,
        disambiguationKey: node.disambiguation_key ?? "",
      })),
    [visibleNodes],
  );

  const sigmaEdges: GraphEdgeData[] = useMemo(
    () =>
      edges.map((edge) => ({
        id: edgeId(edge),
        source: String(edge.subject_entity_id),
        target: String(edge.object_entity_id),
        label: relationLabel(edge.relation_type, relationLabels),
        evidence: edge.evidence,
      })),
    [edges, relationLabels],
  );

  const selectedNode = nodes.find((node) => nodeId(node) === focusedNodeId) ?? null;
  const edge = edges.find((edge) => edgeId(edge) === selectedEdgeId);
  const currentSources = sources?.factId === selectedEdgeId ? sources : null;
  const selectedEdge = edge ? { ...(currentSources?.edge ?? edge), evidence: currentSources?.items ?? [] } : null;
  const relatedEdges = focusedNodeId ? edges.filter((edge) =>
    edge.subject_entity_id === focusedNodeId || edge.object_entity_id === focusedNodeId) : edges;

  const handleNodeClick = useCallback(
    (nodeId: string) => {
      void load(nodeId || undefined);
    },
    [load],
  );

  const handleEdgeClick = useCallback(
    (id: string) => {
      const found = edges.find((edge) => edgeId(edge) === id);
      if (!found) return;
      setSelectedEdgeId(id);
      setSourceOffset(0);
      setSourceReload((value) => value + 1);
      // Keep the node's fact list when this relation belongs to it. A directly
      // clicked relation elsewhere returns to the list for the current graph.
      setFocusedNodeId((current) => current &&
        (found.subject_entity_id === current || found.object_entity_id === current) ? current : null);
    },
    [edges],
  );

  const handleReset = useCallback(() => {
    void load();
  }, [load]);

  return (
    <div className="graph-layout">
      <section className="knowledge-card graph-canvas">
        <div className="section-title">
          <h2>知识网络</h2>
          <div className="graph-toolbar">
            <label className="graph-isolated-toggle"><span>显示孤立节点</span><input type="checkbox" role="switch" checked={showIsolated} onChange={event=>setShowIsolated(event.target.checked)}/></label>
            <span>{loading&&!nodes.length?'正在读取…':loadError&&!nodes.length?'尚未读取图谱':`${visibleNodes.length} 个实体 · ${edges.length} 条关系`}</span>
            {(focusedNodeId || selectedEdgeId) && (
              <button type="button" onClick={handleReset}>
                返回全图
              </button>
            )}
            <button type="button" onClick={() => void load(focusedNodeId || undefined)} disabled={loading}>刷新</button>
          </div>
        </div>
        {loadError && <div className="graph-load-error" role="alert">
          {loadError}。请点击刷新重试。
          {!!nodes.length && <small>下方保留上次加载的知识网络。</small>}
        </div>}
        {loading && !!nodes.length && <p role="status">正在刷新知识网络…</p>}
        {detectionNotice(detection) && <p className="graph-source-note" role="status">{detectionNotice(detection)}</p>}
        {loading && !nodes.length ? <div className="sigma-graph-empty" role="status">正在加载知识网络…</div>
          : loadError && !nodes.length ? <div className="sigma-graph-empty">知识网络暂时无法加载。</div>
          : !nodes.length && detectionNotice(detection) ? <div className="sigma-graph-empty">检测状态尚未就绪，请稍后刷新。</div>
          : !!nodes.length&&!visibleNodes.length&&!showIsolated ? <div className="sigma-graph-empty">当前读取范围内没有相连的实体，可开启“显示孤立节点”查看未连线的实体。</div>
          : <SigmaGraph
          nodes={sigmaNodes}
          edges={sigmaEdges}
          typeLabels={typeLabels}
          onNodeClick={handleNodeClick}
          onEdgeClick={handleEdgeClick}
          selectedNodeId={focusedNodeId}
          selectedEdgeId={selectedEdgeId}
        />}
      </section>
      {(!loading&&!loadError||nodes.length>0)&&<GraphDetails nodes={visibleNodes} edges={relatedEdges} selectedNode={selectedNode} selectedEdge={selectedEdge}
        typeLabels={typeLabels} relationLabels={relationLabels} onSelectEdge={handleEdgeClick} sourceLabel={sourceLabel}
        sourceLoading={sourceLoading} sourceError={sourceError} sourceNotice={detectionNotice(currentSources?.detection)}
        onReloadSources={() => { setSourceOffset(0); setSourceReload((value) => value + 1); }}
        onMoreSources={currentSources?.next_offset != null ? () => setSourceOffset(currentSources.next_offset!) : undefined} />}
    </div>
  );
}

function SearchView({
  documents,
  report,
  onOpenSource,
  initialDocumentId='',
}: {
  documents: DocumentItem[];
  report: (message: string, error?: boolean) => void;
  onOpenSource: (source: IndexSource, signal: AbortSignal) => Promise<void>;
  initialDocumentId?:string;
}) {
  const [sourceDetails, setSourceDetails] = useState<{mode: 'segments' | 'chunks'; indexId?: string} | null>(null);
  const [indexStatus, setIndexStatus] = useState<SearchIndexStatus | null>(null);
  const [query, setQuery] = useState("");
  const [documentId, setDocumentId] = useState(initialDocumentId);
  const [entityTypes, setEntityTypes] = useState<string[]>([]);
  const [result, setResult] = useState<SearchResult | null>(null);
  const [building, setBuilding] = useState(false);
  const [buildSubmitting, setBuildSubmitting] = useState(false);
  const buildPending = useRef(false);
  const [buildFeedback, setBuildFeedback] = useState<{text: string; failed: boolean} | null>(null);
  const [searching, setSearching] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const searchOperation = useRef<AbortController | null>(null);
  const confirmationOperation = useRef<AbortController | null>(null);
  useEffect(() => () => { searchOperation.current?.abort(); confirmationOperation.current?.abort(); }, []);

  async function confirmSensitive(desensitize: boolean) {
    const token = result?.sensitive?.confirmation_token;
    if (!token || confirmationOperation.current) return;
    const controller = new AbortController();
    confirmationOperation.current = controller;
    setConfirming(true);
    try {
      const confirmed = await requestJson<{ items: SearchHit[] }>("/api/search/confirm", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, desensitize }),
        signal: controller.signal,
      });
      setResult((current) => current?.sensitive?.confirmation_token === token ? {
        ...current, items: [...current.items, ...confirmed.items.map((item) => ({
          ...item, score: item.score ?? 0, channels: item.channels ?? ["confirmed"],
          matched_entities: item.matched_entities ?? [], original_url: item.original_url ?? "",
          preview_url: item.preview_url ?? null,
        }))],
        sensitive: current.sensitive ? { ...current.sensitive, confirmation_token: null, confirmation_count: 0 } : undefined,
      } : current);
    } catch (reason) {
      if (!controller.signal.aborted) report(reason instanceof Error ? reason.message : "确认失败", true);
    } finally {
      if (confirmationOperation.current === controller) { confirmationOperation.current = null; setConfirming(false); }
    }
  }

  const loadStatus = useCallback(async () => {
    const next = await requestJson<SearchIndexStatus>(
      `/api/search/indexes?workspace_id=${workspaceId}`,
    );
    setIndexStatus(next);
    setBuilding(next.items.some((item) => item.job_status === "queued" || item.job_status === "running"));
  }, []);

  useEffect(() => {
    loadStatus().catch((reason: Error) => report(reason.message, true));
    const timer = window.setInterval(() => {
      loadStatus().catch((reason: Error) => report(reason.message, true));
    }, 2500);
    return () => window.clearInterval(timer);
  }, [loadStatus, report]);

  async function buildIndex() {
    if (buildPending.current) return;
    buildPending.current = true;
    setBuildSubmitting(true);
    setBuildFeedback(null);
    try {
      const response = await requestJson<{ reused: boolean; index: SearchIndex; job: {status: string} }>("/api/search/indexes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspace_id: workspaceId }),
      }, 30000);
      const pending = ['queued', 'running'].includes(response.job.status);
      setBuilding(pending);
      const feedback = response.reused && response.index.status === 'active'
        ? `检查完成：当前索引 v${response.index.version_number} 已是最新，正文与模型配置没有变化，无需重新构建，版本号保持不变。`
        : response.reused
          ? `已有索引 v${response.index.version_number} 的构建任务${response.job.status === 'running' ? '正在处理' : '正在排队'}，已复用该任务。可在任务中心查看进度。`
          : `索引 v${response.index.version_number} 的构建任务已提交。完成后自动切换到新索引，可在任务中心查看进度。`;
      setBuildFeedback({text: feedback, failed: false});
      report(feedback);
      try { await loadStatus(); } catch {
        setBuildFeedback({text: `${feedback} 状态刷新失败，请稍后重新查看。`, failed: true});
      }
    } catch (reason) {
      const text = reason instanceof Error ? reason.message : '索引任务创建失败';
      setBuildFeedback({text, failed: true});
      report(text, true);
    } finally {
      buildPending.current = false;
      setBuildSubmitting(false);
    }
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!query.trim()) return;
    searchOperation.current?.abort();
    confirmationOperation.current?.abort();
    confirmationOperation.current = null;
    setConfirming(false);
    const controller = new AbortController();
    searchOperation.current = controller;
    setResult(null);
    setSearching(true);
    try {
      const next = await requestJson<SearchResult>("/api/search", {
        method: "POST",
        signal: controller.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspace_id: workspaceId,
          query: query.trim(),
          document_ids: documentId ? [documentId] : [],
          entity_types: entityTypes,
          limit: 12,
        }),
      });
      if (!controller.signal.aborted) setResult(next);
    } catch (reason) {
      if (controller.signal.aborted) return;
      setResult(null);
      report(reason instanceof Error ? reason.message : "检索失败", true);
    } finally {
      if (searchOperation.current === controller) setSearching(false);
    }
  }

  const nodeNames = Object.fromEntries(
    (result?.graph.nodes ?? []).map((node) => [String(node.entity_id ?? node.id), node.canonical_name]),
  );
  return (
    <div className="search-layout">
      <details className="knowledge-card search-control"><summary><DesignIcon name="right" />检索状态 <span className={`badge ${indexStatus?.compatible && indexStatus?.fresh ? "succeeded" : "queued"}`}>{indexStatus?.compatible && indexStatus?.fresh ? "正文索引已就绪" : "正文索引需要更新或配置"}</span></summary>
        <div className="section-title">
          <h2>正文检索索引</h2>
          <span>{indexStatus?.active ? `v${indexStatus.active.version_number}` : "尚未创建"}</span>
        </div>
        <div className="index-summary">
          <p className="muted">这里反映正文索引状态，不代表全部实体关系已发布，也不代表全部内容已完成脱敏检测。</p>
          {!indexStatus?.embedding_configured && <p className="validation-errors">Embedding 尚未正确配置。</p>}
          {indexStatus?.active ? (
            <>
              <strong>{indexStatus.active.provider} · {indexStatus.active.model}</strong>
              <small>
                {indexStatus.active.dimension} 维 · {indexStatus.active.indexed_segments} 个语义工作块
                <button type="button" className="index-details-link" onClick={() => setSourceDetails({mode: 'chunks', indexId: indexStatus.active?.id})}>查看工作块及来源</button>
              </small>
              {!indexStatus.compatible && <p className="review-warning">当前 Embedding 配置已变化，需要创建新索引。</p>}
              {indexStatus.compatible && !indexStatus.fresh && <p className="review-warning">{building ? "材料已变化，正在自动更新索引。" : "材料正文发生变化，需要更新索引。"}</p>}
            </>
          ) : (
            <p>解析完成后创建文本索引，无需等待知识图谱。</p>
          )}
          <small>可参与检索的来源片段：{indexStatus?.publishable_segments ?? 0} 个（整个知识库）
            <button type="button" className="index-details-link" disabled={!indexStatus} onClick={() => setSourceDetails({mode: 'segments', indexId: indexStatus?.active?.id})}>查看明细</button>
          </small>
          {indexStatus?.compatible && indexStatus.fresh && !building && <small>索引已同步当前正文。检查更新时，内容与模型配置未变化将复用现有索引。</small>}
          <button type="button" className="index-build-button" disabled={buildSubmitting || building || !indexStatus?.embedding_configured} onClick={() => void buildIndex()}>
            {buildSubmitting ? '正在检查并提交…' : building ? "索引构建中…" : indexStatus?.compatible && indexStatus.fresh ? '检查索引更新' : indexStatus?.active ? "更新索引" : "创建索引"}
          </button>
          {buildFeedback && <p role={buildFeedback.failed ? 'alert' : 'status'} className={`notice ${buildFeedback.failed ? 'error' : 'success'}`}>{buildFeedback.text}</p>}
        </div>
      </details>

      {sourceDetails && <SearchSourceDetails workspace={workspaceId} documents={documents} {...sourceDetails} close={() => setSourceDetails(null)} onOpen={onOpenSource} sourceLabel={sourceLabel} />}
      <section className="search-main">
        <form className="search-form" onSubmit={(event) => void submit(event)}>
          <label>
            <span>检索问题</span>
            <input value={query} maxLength={2000} onChange={(event) => setQuery(event.target.value)} placeholder="例如：张伟在哪家公司任职？" />
          </label>
          <label>
            <span>限定材料</span>
            <select value={documentId} onChange={(event) => setDocumentId(event.target.value)}>
              <option value="">全部已解析材料</option>
              {documents.filter((item) => item.status === "ready").map((item) => (
                <option value={item.id} key={item.id}>{item.original_name}</option>
              ))}
            </select>
          </label>
          <SearchTypeFilter workspace={workspaceId} value={entityTypes} change={setEntityTypes} />
          <button type="submit" disabled={searching || !query.trim() || !indexStatus?.compatible}>
            <DesignIcon name="query" />{searching ? "检索中…" : "检索证据"}
          </button>
        </form>
        {!result && <div className="empty">输入问题或原文中的关键词，查看对应证据。正文索引就绪后即可检索；已发布的实体关系可辅助检索，未发布草稿不参与。{documentId&&' 当前已限定材料，可在上方切换为全部材料。'}</div>}
        {result?.message && <div className="review-warning" role="status">{result.message}</div>}
        {result && !result.items.length && !result.sensitive?.confirmation_count && !result.sensitive?.withheld && <div className="empty">没有找到符合当前版本与筛选条件的证据。</div>}
        {!!result?.sensitive?.withheld && <div className="review-warning">{result.sensitive.withheld} 条结果的正文尚未完成脱敏检测，暂不显示。请在“脱敏设置”查看扫描状态并重试失败的扫描。</div>}
        {!!result?.sensitive?.confirmation_count && <div className="review-warning">
          {result.sensitive.confirmation_count} 条结果包含需要确认的敏感信息。
          <button type="button" disabled={confirming} onClick={() => void confirmSensitive(true)}>确认并脱敏查看</button>
          <button type="button" disabled={confirming} onClick={() => void confirmSensitive(false)}>确认查看原文</button>
          {confirming && <span role="status">正在确认…</span>}
        </div>}
        {result?.graph_warning && <div className="review-warning">{result.graph_warning}</div>}
        <div className="search-results-layout">
          {result?.items.map((item, index) => (
            <article className="search-result-row" key={item.id} aria-label={`检索结果 ${index + 1}：${item.original_name}`}>
            <section className="search-hit">
              <div className="search-hit-heading">
                <div>
                  <h3>{index + 1}. {item.original_name}</h3>
                  <small title="检索得分用于排序，包含关键词和图谱加分，不代表相关概率。">{sourceLabel(item.locator)} · 检索得分 {item.score.toFixed(3)}</small>
                </div>
                <div className="channel-list">
                  {item.channels.map((channel) => <span className="badge" key={channel}>{{vector:'语义匹配',keyword:'关键词匹配',graph:'关联知识',confirmed:'已确认查看'}[channel]??channel}</span>)}
                </div>
              </div>
              <p>{Array.from(item.text).length > 180 ? `${Array.from(item.text).slice(0, 180).join('')}…` : item.text}</p>
              {!!item.matched_entities.length && <small>图命中：{item.matched_entities.join("、")}</small>}
            </section>
            <section className="search-evidence" aria-label={`对应证据：${item.original_name}`}>
              <header><h3>对应证据</h3><span className="badge succeeded">可查看</span></header>
              <p className="muted">{item.original_name} · {sourceLabel(item.locator)}</p>
              <blockquote><small>命中段落</small><p>{item.text}</p></blockquote>
              <div className="source-actions">
                {item.original_url && <a href={item.original_url} target="_blank" rel="noreferrer">查看原件</a>}
                {item.preview_url && <a href={item.preview_url} target="_blank" rel="noreferrer">查看来源页</a>}
              </div>
            </section>
            </article>
          ))}
        </div>
        {!!result?.items.length && <p className="catalog-footnote">每行右侧展示该条检索结果的对应证据。未发布草稿不影响当前结果。</p>}
        {!!result?.graph.edges.length && (
          <div className="search-context">
            <h3>有限图扩展</h3>
            {result.graph.edges.map((edge) => (
              <div key={String(edge.fact_id ?? edge.id)}>
                <span>{nodeNames[edge.subject_entity_id] ?? edge.subject_entity_id.slice(0, 8)}</span>
                <b>{edge.relation_type}</b>
                <span>{nodeNames[edge.object_entity_id] ?? edge.object_entity_id.slice(0, 8)}</span>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function LLMConfigPanel({ report: onReport, onSaved, onLeaveState }: { report: (message: string, error?: boolean) => void; onSaved: () => void; onLeaveState: (state: {dirty: boolean; busy: boolean}) => void }) {
  const [form, setForm] = useState<LLMSettings | null>(null);
  const [baseline, setBaseline] = useState<LLMSettings | null>(null);
  const [feedback, setFeedback] = useState<{text: string; failed: boolean} | null>(null);
  const report = useCallback((text: string, failed = false) => { setFeedback({text, failed}); onReport(text, failed); }, [onReport]);
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState<"save" | "test" | null>(null);
  const pending = useRef(false);
  const dirty = !!apiKey || JSON.stringify(form) !== JSON.stringify(baseline);
  useEffect(() => {
    const controller = new AbortController();
    requestJson<LLMSettings>("/api/settings/llm", {signal: controller.signal}).then(value => {
      if (!controller.signal.aborted) { setForm(value); setBaseline(value); }
    }).catch((reason: Error) => { if (!controller.signal.aborted) report(reason.message, true); });
    return () => controller.abort();
  }, [report]);
  useEffect(() => { onLeaveState({dirty, busy: !!busy}); }, [dirty, busy, onLeaveState]);
  useEffect(() => {
    if (!dirty && !busy) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty, busy]);
  if (!form) return <div className="empty" role={feedback?.failed ? 'alert' : 'status'}>{feedback?.text ?? '正在读取 LLM 连接信息…'}</div>;
  const body = { ...form, openai_api_key: apiKey };
  async function run(action: "save" | "test") {
    if (pending.current) return;
    pending.current = true;
    setBusy(action);
    try {
      if (action === "test") {
        const result = await requestJson<{ ok: boolean; model: string }>("/api/settings/llm/test", {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
        });
        report(`连接成功：${result.model}`);
      } else {
        const saved = await requestJson<LLMSettings>("/api/settings/llm", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...body, expected_revision: form!.revision }),
        });
        setForm(saved);
        setBaseline(saved);
        setApiKey("");
        onSaved();
        report("LLM 连接已保存，知识抽取与脱敏检测现已共用该配置。");
      }
    } catch (reason) {
      report(reason instanceof Error ? reason.message : "LLM 操作失败", true);
    } finally { pending.current = false; setBusy(null); }
  }
  return <div className="llm-config">
    {feedback && <p role={feedback.failed ? 'alert' : 'status'} className={feedback.failed ? 'error' : 'notice'}>{feedback.text}</p>}
    <h3>知识识别与脱敏 LLM</h3>
    <p>两项功能使用同一个模型连接。修改后立即用于新任务；已运行的任务不会重启。</p>
    <fieldset className="llm-controls" disabled={busy !== null} aria-label="模型连接配置">
    <div className="llm-fields">
      <label>连接方式<select value={form.llm_provider} onChange={(event) => setForm({ ...form, llm_provider: event.target.value as LLMSettings["llm_provider"] })}>
        <option value="openai_compatible">OpenAI 兼容接口</option><option value="ollama">Ollama</option>
      </select></label>
      {form.llm_provider === "openai_compatible" ? <>
        <label>API Base URL<input type="url" value={form.openai_base_url} placeholder="https://example.com/v1" onChange={(event) => setForm({ ...form, openai_base_url: event.target.value })} /></label>
        <label>模型名称<input value={form.openai_model} placeholder="模型 ID" onChange={(event) => setForm({ ...form, openai_model: event.target.value })} /></label>
        <label>API Key<input type="password" autoComplete="new-password" value={apiKey} placeholder={form.openai_api_key_configured ? "已配置；留空则保持原值" : "请输入 API Key"} onChange={(event) => setApiKey(event.target.value)} /></label>
      </> : <>
        <label>Ollama Base URL<input type="url" value={form.ollama_base_url} placeholder="http://127.0.0.1:11434" onChange={(event) => setForm({ ...form, ollama_base_url: event.target.value })} /></label>
        <label>模型名称<input value={form.ollama_model} placeholder="已安装的模型名称" onChange={(event) => setForm({ ...form, ollama_model: event.target.value })} /></label>
      </>}
      <label>请求超时（秒）<input type="number" min={1} max={600} value={form.model_timeout_seconds} onChange={(event) => setForm({ ...form, model_timeout_seconds: Number(event.target.value) })} /></label>
    </div>
    <details className="llm-advanced">
      <summary>高级处理设置 · 本地小模型与任务预算</summary>
      <p className="muted">默认单并发、分步抽取。本地小模型建议先保持单并发；云端可从 2 路开始对照测试。联合抽取需要验证所用模型的质量。</p>
      <section className="llm-parameter-group"><h4>知识抽取</h4><div className="llm-form">
        <label>抽取策略<select value={form.extraction_strategy} onChange={(e) => setForm({ ...form, extraction_strategy: e.target.value as LLMSettings["extraction_strategy"] })}>
          <option value="two_stage">分步抽取（默认）</option><option value="joint">联合抽取（需验证）</option>
        </select></label>
        <label>稀疏页面合并<select value={form.knowledge_cross_page_batches === false ? "off" : "on"} onChange={(e) => setForm({ ...form, knowledge_cross_page_batches: e.target.value === "on" })}>
          <option value="on">按预算合并相邻页面</option><option value="off">每页独立抽取</option>
        </select><small>保留原始页码与证据位置，只调整知识抽取批次。</small></label>
        {([
          ["llm_concurrency", "LLM 并发数", 1, 4], ["llm_context_tokens", "上下文 token", 2048, 131072],
          ["llm_extraction_input_tokens", "抽取正文预算", 256, 16000], ["llm_extraction_output_tokens", "抽取输出预算", 128, 8192],
        ] as const).map(([key, label, min, max]) => <label key={key}>{label}<input type="number" min={min} max={max} value={form[key]} onChange={(e) => setForm({ ...form, [key]: Number(e.target.value) })} /></label>)}
      </div></section>
      <section className="llm-parameter-group"><h4>脱敏检测预算</h4><div className="llm-form">
        {([
          ["llm_sensitive_input_tokens", "Ollama 脱敏输入预算", 256, 16000], ["llm_sensitive_output_tokens", "脱敏输出预算", 128, 8192],
          ["llm_sensitive_batch_size", "Ollama 脱敏批次上限", 1, 8],
        ] as const).map(([key, label, min, max]) => <label key={key}>{label}<input type="number" min={min} max={max} value={form[key]} onChange={(e) => setForm({ ...form, [key]: Number(e.target.value) })} /></label>)}
        {form.llm_provider === 'openai_compatible' && ([
          ["openai_sensitive_batch_size", "外部接口脱敏批次上限", 1, 16],
          ["openai_sensitive_input_tokens", "外部接口脱敏输入预算", 256, 16000],
          ["openai_sensitive_context_tokens", "外部接口脱敏上下文预算", 2048, 131072],
        ] as const).map(([key, label, min, max]) => <label key={key}>{label}<input type="number" min={min} max={max}
          value={form[key]} onChange={(e) => setForm({ ...form, [key]: Number(e.target.value) })} /></label>)}
      </div></section>
      <section className="llm-parameter-group"><h4>推理与输出</h4><div className="llm-form">
        {form.llm_provider === "ollama" ? <>
          <label>模型驻留时间<input value={form.ollama_keep_alive} placeholder="10m" onChange={(e) => setForm({ ...form, ollama_keep_alive: e.target.value })} /></label>
          <label>推理模式<select value={form.ollama_think} onChange={(e) => setForm({ ...form, ollama_think: e.target.value as LLMSettings["ollama_think"] })}>
            <option value="auto">模型默认</option><option value="off">关闭（模型支持时）</option><option value="on">启用（模型支持时）</option>
          </select></label>
        </> : <>
        <label>推理模式<select value={form.openai_think ?? "off"} onChange={(e) => setForm({ ...form, openai_think: e.target.value as LLMSettings["openai_think"] })}>
          <option value="auto">模型默认</option><option value="off">关闭（服务商支持时）</option><option value="on">启用（服务商支持时）</option>
        </select><small>新连接默认关闭。未知兼容接口需指定支持的参数格式；不支持关闭时请选择模型默认。关闭后请对照检查关系抽取和敏感信息漏检情况。</small></label>
        {form.openai_think && form.openai_think !== "auto" && <label>推理参数格式<select value={form.openai_thinking_format ?? "auto"} onChange={(e) => setForm({ ...form, openai_thinking_format: e.target.value as LLMSettings["openai_thinking_format"] })}>
          <option value="auto">自动识别服务商 / 模型</option><option value="thinking">Thinking（DeepSeek / 火山方舟）</option><option value="enable_thinking">Enable Thinking（Qwen）</option><option value="reasoning_effort">Reasoning Effort（支持 none 的接口）</option>
        </select></label>}
        <label>结构化输出能力<select value={form.openai_structured_output} onChange={(e) => setForm({ ...form, openai_structured_output: e.target.value as LLMSettings["openai_structured_output"] })}>
          <option value="text">文本 JSON + 本地校验</option><option value="json_object">JSON Object</option><option value="json_schema">JSON Schema</option>
        </select></label></>}
      </div></section>
      {form.llm_provider === "openai_compatible" && <p className="muted">文本兼容模式沿用服务端输出上限；JSON Object / Schema 模式使用上方输出预算。推理模型的预算可能同时包含思考 token，出现截断时需适当增加。</p>}
    </details>
    </fieldset>
    <div className="llm-actions"><span>{form.llm_configured ? "当前连接已配置" : "当前连接未配置"}</span>
      <button type="button" disabled={busy !== null} onClick={() => void run("test")}>{busy === "test" ? "测试中…" : "测试连接"}</button>
      <button type="button" disabled={busy !== null} onClick={() => void run("save")}>{busy === "save" ? "保存中…" : "保存 LLM 连接"}</button>
    </div>
  </div>;
}

function SensitiveView({ report: onReport, onSavingChange }: { report: (message: string, error?: boolean) => void; onSavingChange: (saving: boolean) => void }) {
  const [ruleFeedback, setRuleFeedback] = useState<{text: string; failed: boolean} | null>(null);
  const report = useCallback((text: string, failed = false) => { setRuleFeedback({text, failed}); onReport(text, failed); }, [onReport]);
  const [settings, setSettings] = useState<SensitiveSettings | null>(null);
  const [editingRuleId, setEditingRuleId] = useState<string | null>(null);
  const [preview, setPreview] = useState("");
  const [previewResult, setPreviewResult] = useState("");
  const [busy, setBusy] = useState(false);
  const [savingFlag, setSavingFlag] = useState(false);
  const savedSettings = useRef<SensitiveSettings | null>(null);
  const saving = useRef(false);
  const retryPending = useRef(false);
  const [retryBusy, setRetryBusy] = useState(false);
  const load = useCallback(async () => {
    if (saving.current) return;
    const next = await requestJson<SensitiveSettings>(`/api/sensitive/settings?workspace_id=${workspaceId}`);
    if (saving.current || (savedSettings.current && next.revision < savedSettings.current.revision)) return;
    savedSettings.current = next;
    setSettings((current) => current && current.revision === next.revision ? {
      ...current, scan: next.scan, llm_provider: next.llm_provider,
      llm_model: next.llm_model, llm_configured: next.llm_configured,
    } : next);
  }, []);
  useEffect(() => {
    void load().catch((reason: Error) => report(reason.message, true));
    const timer = window.setInterval(() => void load().catch(() => undefined), 3000);
    return () => window.clearInterval(timer);
  }, [load, report]);
  function updateRule(id: string, patch: Partial<SensitiveRule>) {
    setSettings((current) => current ? { ...current, rules: current.rules.map((rule) => rule.id === id ? { ...rule, ...patch } : rule) } : current);
  }
  function updateMasking(rule: SensitiveRule, patch: Partial<SensitiveRule["masking"]>) {
    const masking = { ...rule.masking, ...patch };
    if (masking.strategy !== "keep_edges") { masking.prefix_characters = 0; masking.suffix_characters = 0; }
    updateRule(rule.id, { masking, mask: masking.replacement });
  }
  function setSaving(value: boolean) {
    saving.current = value;
    setBusy(value);
    onSavingChange(value);
  }
  async function updateGlobalToggle(field: "enabled" | "semantic_enabled", value: boolean) {
    const baseline = savedSettings.current;
    if (!baseline || saving.current) return;
    setSaving(true);
    setSavingFlag(true);
    setSettings((current) => current ? { ...current, [field]: value } : current);
    const payload = { workspace_id: workspaceId, expected_revision: baseline.revision,
      enabled: baseline.enabled, semantic_enabled: baseline.semantic_enabled, rules: baseline.rules, [field]: value };
    const submit = (acknowledgeSimilarRuleId?: string) => requestJson<SensitiveSettings>("/api/sensitive/settings", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...payload, acknowledge_similar_rule_id: acknowledgeSimilarRuleId }),
    });
    try {
      let next: SensitiveSettings;
      try {
        next = await submit();
      } catch (reason) {
        const similar = /规则与 ([a-z][a-z0-9_]+) 相似/.exec(reason instanceof Error ? reason.message : "");
        if (!similar) throw reason;
        // These are the persisted rules; this operation does not change their definitions.
        next = await submit(similar[1]);
      }
      savedSettings.current = next;
      setSettings((current) => ({ ...next, rules: current?.rules ?? next.rules }));
      const label = field === "enabled" ? "交付脱敏" : "LLM 语义敏感识别";
      report(`${label}已${value ? "启用" : "关闭"}，开关已自动保存。`);
    } catch (reason) {
      setSettings((current) => current ? { ...current, enabled: baseline.enabled,
        semantic_enabled: baseline.semantic_enabled } : current);
      report(`开关保存失败：${reason instanceof Error ? reason.message : "请重试"}`, true);
    } finally {
      setSavingFlag(false);
      setSaving(false);
    }
  }
  async function save(acknowledgeSimilarRuleId?: string) {
    if (!settings || saving.current) return;
    setSaving(true);
    try {
      const next = await requestJson<SensitiveSettings>("/api/sensitive/settings", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspace_id: workspaceId, expected_revision: settings.revision,
          enabled: settings.enabled, semantic_enabled: settings.semantic_enabled, rules: settings.rules,
          acknowledge_similar_rule_id: acknowledgeSimilarRuleId }),
      });
      savedSettings.current = next;
      setSettings(next);
      setEditingRuleId(null);
      report("脱敏规则已保存；需要重新识别的内容会自动安排扫描。");
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "保存失败";
      const similar = /规则与 ([a-z][a-z0-9_]+) 相似/.exec(message);
      if (similar && !acknowledgeSimilarRuleId && window.confirm(`这条规则与 ${similar[1]} 相似。确认用途不同并继续保存吗？`)) {
        setSaving(false);
        await save(similar[1]);
        return;
      }
      report(message, true);
    } finally { setSaving(false); }
  }
  async function testPreview() {
    if (!preview.trim()) return;
    try {
      const next = await requestJson<{ text: string; status: string }>("/api/sensitive/preview", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspace_id: workspaceId, text: preview }),
      });
      setPreviewResult(`${next.status}：${next.text || "[不交付]"}`);
    } catch (reason) { report(reason instanceof Error ? reason.message : "测试失败", true); }
  }
  async function retry() {
    if (!settings?.scan.id || retryPending.current) return;
    retryPending.current = true;
    setRetryBusy(true);
    try {
      const scan = await requestJson<Job>(`/api/jobs/${settings.scan.id}/retry`, { method: "POST" });
      setSettings((current) => current ? { ...current, scan } : current);
      await load();
      report(scan.status === "succeeded" ? "当前内容已完成检测。" : "已复用当前扫描任务。");
    } catch (reason) { report(reason instanceof Error ? reason.message : "重试失败", true); }
    finally { retryPending.current = false; setRetryBusy(false); }
  }
  if (!settings) return <div className="empty">正在读取脱敏设置…</div>;
  const builtins = settings.rules.filter((rule) => rule.source === "built_in");
  const customRules = settings.rules.filter((rule) => rule.source === "custom");
  const editingRule = settings.rules.find((rule) => rule.id === editingRuleId) ?? null;
  const rulesChanged = JSON.stringify(settings.rules) !== JSON.stringify(savedSettings.current?.rules);
  const draftPromptUsed = settings.rules.filter((rule) => rule.enabled && rule.kind === "semantic")
    .reduce((sum, rule) => sum + rule.name.length + rule.description.length
      + [...rule.examples, ...rule.counter_examples].reduce((exampleSum, value) => exampleSum + value.trim().length, 0) + 20, 0);
  function isBuiltinCustomized(rule: SensitiveRule) {
    const defaultRule = settings!.builtin_defaults.find((item) => item.id === rule.id);
    if (!defaultRule) return false;
    return rule.enabled !== defaultRule.enabled || rule.mode !== defaultRule.mode
      || rule.allow_original_after_confirm !== defaultRule.allow_original_after_confirm
      || rule.description !== defaultRule.description
      || JSON.stringify(rule.examples) !== JSON.stringify(defaultRule.examples)
      || JSON.stringify(rule.counter_examples) !== JSON.stringify(defaultRule.counter_examples)
      || rule.masking.strategy !== defaultRule.masking.strategy
      || rule.masking.prefix_characters !== defaultRule.masking.prefix_characters
      || rule.masking.suffix_characters !== defaultRule.masking.suffix_characters
      || rule.masking.replacement !== defaultRule.masking.replacement;
  }
  const scanLabels: Record<string, string> = {
    disabled: "未启用", index_required: "等待检索索引", not_started: "等待扫描",
    queued: "等待扫描", running: "扫描中", succeeded: "扫描完成",
    failed: "扫描失败", cancelled: "扫描已取消",
  };
  return <section className="knowledge-card sensitive-settings">
    <div className="section-title"><h2>脱敏设置</h2><span>工作空间 {workspaceId}</span></div>
    <p className="settings-location">模型连接在左下角“设置”中调整，知识识别与脱敏继续共用同一配置。</p>
    <div className="sensitive-panel">
      <div className="sensitive-panel-title"><h3>保护设置</h3><span role="status">{savingFlag ? "正在保存开关…" : "开关修改后自动保存"}</span></div>
      <label className="sensitive-toggle"><input type="checkbox" disabled={busy} checked={settings.enabled} onChange={(event) => void updateGlobalToggle("enabled", event.target.checked)} /><span><strong>启用交付脱敏</strong><small>规则对对外交付的检索与图谱结果生效</small></span></label>
      <label className="sensitive-toggle"><input type="checkbox" disabled={busy} checked={settings.semantic_enabled} onChange={(event) => void updateGlobalToggle("semantic_enabled", event.target.checked)} /><span><strong>使用 LLM 识别语义敏感信息</strong><small>复用左下角“设置”中的模型连接</small></span></label>
      <p>开启后自动扫描当前知识内容。切换模型仍会创建扫描任务，但识别规则、模板和原文均未变化的结果会直接复用，包括未命中结果，不再调用模型。检测未完成的结果会暂缓交付。</p>
    </div>
    <div className="sensitive-panel sensitive-scan">
      <div className="sensitive-panel-title"><h3>检测运行状态</h3><span>{scanLabels[settings.scan.status] ?? settings.scan.status}</span></div>
      <p>{settings.scan.metrics?.fields != null ? scanCounts(settings.scan.metrics) : settings.scan.total_units != null ? `已覆盖 ${settings.scan.completed_units ?? 0} / ${settings.scan.total_units} 个交付字段` : "等待可用索引或新的扫描任务"}{settings.scan.error_code ? ` · ${settings.scan.error_message ?? settings.scan.error_code}` : ""}</p>
      {settings.scan.metrics && <small>本轮执行 {processingSeconds(settings.scan.metrics, settings.scan.status)} 秒{settings.scan.metrics.total_processing_seconds != null ? ` · 已结束轮次累计 ${settings.scan.metrics.total_processing_seconds.toFixed(1)} 秒` : ""}</small>}
      {(settings.scan.status === "failed" || settings.scan.status === "cancelled") && <button type="button" disabled={retryBusy} onClick={() => void retry()}>{retryBusy ? "正在安排…" : "重试扫描"}</button>}
    </div>
    <div className="sensitive-panel">
      <div className="sensitive-panel-title"><h3>系统内置规则</h3><span>{builtins.length} 条 · ID 与识别器固定</span></div>
      <div className="sensitive-rule-save"><span className={rulesChanged ? "sensitive-unsaved" : ""}>{rulesChanged ? "规则修改尚未保存" : "规则已保存"}</span><button type="button" disabled={busy || draftPromptUsed > settings.rule_capacity.prompt_limit} onClick={() => void save()}>{busy && !savingFlag ? "保存中…" : "保存脱敏设置"}</button></div>
      <div className="sensitive-rule-grid">{builtins.map((rule) => <article className="sensitive-rule-card" key={rule.id}>
        <div className="sensitive-card-head"><strong>{rule.name}</strong><span>{rule.protected ? "强制保护" : rule.enabled ? "已启用" : "已停用"}</span></div>
        <p>{rule.description}</p>
        <small>{rule.kind === "regex" ? "确定性识别" : "语义识别"} · {rule.mode === "mask" ? "自动脱敏" : rule.mode === "block" ? "拒绝交付" : "需要确认"}</small>
        <div className="sensitive-card-actions"><button type="button" onClick={() => setEditingRuleId(rule.id)}>编辑</button>
          {!rule.protected && <button type="button" onClick={() => updateRule(rule.id, { enabled: !rule.enabled })}>{rule.enabled ? "停用" : "启用"}</button>}
          {isBuiltinCustomized(rule) && <button type="button" onClick={() => {
            const original = settings.builtin_defaults.find((item) => item.id === rule.id);
            if (original) updateRule(rule.id, original);
          }}>恢复默认</button>}
        </div>
      </article>)}</div>
    </div>
    <div className="sensitive-panel">
      <div className="sensitive-panel-title"><h3>自定义语义规则</h3><span>{customRules.length} / {settings.rule_capacity.max_custom} 条</span></div>
      <p>用明确的识别说明、正例和反例限定业务敏感内容。停用规则不占用模型提示容量。</p>
      <div className={`sensitive-capacity${draftPromptUsed > settings.rule_capacity.prompt_limit ? " over-limit" : ""}`}><span>当前表单提示容量约 {draftPromptUsed} / {settings.rule_capacity.prompt_limit} 字符</span><progress value={Math.min(draftPromptUsed, settings.rule_capacity.prompt_limit)} max={settings.rule_capacity.prompt_limit} /></div>
      <div className="sensitive-custom-list">{customRules.map((rule) => <article className="sensitive-custom-row" key={rule.id}>
        <div><strong>{rule.name}</strong><p>{rule.description}</p><small>{rule.enabled ? "已启用" : "已停用"} · {rule.mode === "mask" ? "自动脱敏" : rule.mode === "block" ? "拒绝交付" : "需要确认"}</small></div>
        <div className="sensitive-card-actions"><button type="button" onClick={() => setEditingRuleId(rule.id)}>编辑</button><button type="button" onClick={() => updateRule(rule.id, { enabled: !rule.enabled })}>{rule.enabled ? "停用" : "启用"}</button><button type="button" onClick={() => {
          if (window.confirm(`删除“${rule.name}”？保存设置后生效。`)) { setSettings({ ...settings, rules: settings.rules.filter((item) => item.id !== rule.id) }); setEditingRuleId(null); }
        }}>删除</button></div>
      </article>)}</div>
      {!customRules.length && <p>尚无自定义规则。</p>}
      <button type="button" disabled={customRules.length >= settings.rule_capacity.max_custom} onClick={() => {
        const id = `custom_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
        setSettings({ ...settings, rules: [...settings.rules, { id, name: "", kind: "semantic", source: "custom", enabled: true, mode: "mask", mask: "[已脱敏]", masking: { strategy: "fixed", prefix_characters: 0, suffix_characters: 0, replacement: "[已脱敏]" }, allow_original_after_confirm: false, description: "", examples: [], counter_examples: [] }] });
        setEditingRuleId(id);
      }}>新增自定义规则</button>
    </div>
    {editingRule && <WorkbenchDrawer title={`编辑规则：${editingRule.name || "新规则"}`} close={() => setEditingRuleId(null)} canClose={!busy}><div className="sensitive-panel sensitive-editor">
      {ruleFeedback && <p role={ruleFeedback.failed ? 'alert' : 'status'} className={ruleFeedback.failed ? 'notice error' : 'notice'}>{ruleFeedback.text}</p>}
      <div className="sensitive-panel-title"><h3>编辑：{editingRule.name || "新规则"}</h3><button type="button" onClick={() => setEditingRuleId(null)}>收起</button></div>
      <div className="sensitive-editor-grid">
        <label>规则名称<input value={editingRule.name} maxLength={80} placeholder="例如：客户项目代号" onChange={(event) => updateRule(editingRule.id, { name: event.target.value })} /></label>
        <label>命中后的处理<select value={editingRule.mode} disabled={editingRule.protected} onChange={(event) => updateRule(editingRule.id, { mode: event.target.value as SensitiveRule["mode"], allow_original_after_confirm: false })}><option value="confirm">需要确认</option><option value="mask">自动脱敏</option><option value="block">直接阻止</option></select></label>
        {editingRule.kind === "semantic" && <><label className="wide">识别说明<textarea value={editingRule.description} maxLength={400} rows={3} placeholder="写清哪些内容算命中，以及容易混淆但不应命中的情况；自定义规则至少 10 字。" onChange={(event) => updateRule(editingRule.id, { description: event.target.value })} /></label>
          <label>正例（每行一条）<textarea value={editingRule.examples.join("\n")} rows={4} placeholder="例如：海棠计划一期" onChange={(event) => updateRule(editingRule.id, { examples: event.target.value.split(/\r?\n/) })} /><small>自定义规则至少填写一条</small></label>
          <label>反例（每行一条）<textarea value={editingRule.counter_examples.join("\n")} rows={4} placeholder="例如：本项目、项目计划" onChange={(event) => updateRule(editingRule.id, { counter_examples: event.target.value.split(/\r?\n/) })} /><small>帮助模型排除泛称与误报</small></label></>}
        {editingRule.mode === "confirm" && <label className="wide checkbox-line"><input type="checkbox" checked={editingRule.allow_original_after_confirm} onChange={(event) => updateRule(editingRule.id, { allow_original_after_confirm: event.target.checked })} />用户确认后允许领取原文；关闭时仅交付脱敏版</label>}
        <label>遮盖方式<select value={editingRule.masking.strategy} disabled={editingRule.protected} onChange={(event) => updateMasking(editingRule, { strategy: event.target.value as SensitiveRule["masking"]["strategy"] })}><option value="full">完全遮盖</option><option value="fixed">固定替换文本</option>{(!editingRule.protected && !["secret"].includes(editingRule.id)) && <option value="keep_edges">保留前后字符</option>}</select></label>
        <label>替换字符或文本<input value={editingRule.masking.replacement} maxLength={32} disabled={editingRule.protected} onChange={(event) => updateMasking(editingRule, { replacement: event.target.value })} /></label>
        {editingRule.masking.strategy === "keep_edges" && <><label>保留前缀字符数<input type="number" min={0} max={editingRule.id === "email" || editingRule.id === "person" ? 1 : editingRule.id === "phone" ? 3 : editingRule.id === "id_card" ? 6 : 32} value={editingRule.masking.prefix_characters} onChange={(event) => updateMasking(editingRule, { prefix_characters: Number(event.target.value) })} /></label><label>保留后缀字符数<input type="number" min={0} max={editingRule.id === "phone" || editingRule.id === "id_card" ? 4 : editingRule.id === "email" || editingRule.id === "person" ? 0 : 32} value={editingRule.masking.suffix_characters} onChange={(event) => updateMasking(editingRule, { suffix_characters: Number(event.target.value) })} /></label></>}
      </div>
      <p>内置规则的识别器保持不变；密钥规则始终启用并拒绝交付。保存后再运行下方测试。</p>
      <button className="primary" disabled={busy || draftPromptUsed > settings.rule_capacity.prompt_limit} onClick={() => void save()}>保存脱敏设置</button>
    </div></WorkbenchDrawer>}
    <button className="sensitive-save" type="button" disabled={busy || draftPromptUsed > settings.rule_capacity.prompt_limit} onClick={() => void save()}>{busy ? "保存中…" : "保存脱敏设置"}</button>
    <div className="sensitive-panel sensitive-preview"><h3>效果测试</h3><small>测试使用已保存的规则；修改规则后请先保存。示例文本不会另行保存。</small><textarea value={preview} onChange={(event) => setPreview(event.target.value)} maxLength={12000} placeholder="粘贴一段测试文本" /><button type="button" onClick={() => void testPreview()}><DesignIcon name="play" />测试脱敏效果</button>{previewResult && <p>{previewResult}</p>}</div>
  </section>;
}

function App() {
  const [view, setView] = useState<"materials" | "ontology" | "review" | "graph" | "search" | "sensitive" | "skills" | "releases">((new URLSearchParams(location.search).get("view") as "ontology" | "materials" | "releases") || "materials");
  const [ontologyNavigation, setOntologyNavigation] = useState<{ action: OntologyAction }>();
  const clearOntologyNavigation = useCallback(() => setOntologyNavigation(undefined), []);
  const [searchDocumentId,setSearchDocumentId]=useState('');
  const ontologyLeaveState = useRef({ dirty: false, busy: false });
  const updateOntologyLeaveState = useCallback((value: { dirty: boolean; busy: boolean }) => { ontologyLeaveState.current = value; }, []);
  const materialLeaveState=useRef({dirty:false,busy:false});
  const detailRequest=useRef(0);
  const materialInteraction=useRef(0);
  const updateMaterialLeaveState=useCallback((value:{dirty:boolean;busy:boolean})=>{materialLeaveState.current=value;},[]);
  function leaveMaterialReview() {
    if(correctionPending){report('正文保存结果尚未确认，请先重试保存以确认结果。',true);return false;}
    if(deletingDocument){report('材料正在删除，请等待结果后操作。',true);return false;}
    if(correctionPreparation.current){report('正在读取校对来源，请等待完成后操作。',true);return false;}
    if(saving){report('正文正在保存，请等待结果后操作。',true);return false;}
    if(editing&&Object.entries(drafts).some(([id,text])=>detail?.segments.find(segment=>segment.id===id)?.text!==text)&&!window.confirm('正文有未保存修改，是否放弃并离开？'))return false;
    if(materialLeaveState.current.busy){report('材料知识核对正在保存，请等待结果后操作。',true);return false;}
    return !materialLeaveState.current.dirty||window.confirm('当前实体或规则有未保存调整，是否放弃这些调整并离开？');
  }
  function canLeaveView() {
    if(sensitiveSaving)return false;
    if(view==='materials'&&!leaveMaterialReview())return false;
    if(view==='ontology'){
      if(ontologyLeaveState.current.busy){report('本体操作正在处理中，请等待结果后再切换页面。',true);return false;}
      if(ontologyLeaveState.current.dirty&&!window.confirm('类型与关系有未保存修改，是否放弃并切换页面？'))return false;
    }
    return true;
  }
  function navigate(target:typeof view,documentId='') {
    if(target!==view&&!canLeaveView())return false;
    if(target!==view){materialInteraction.current++;if(view==='materials'){setEditing(false);setDrafts({});}}
    if(target==='skills')setSkillsOpened(true);
    if(target!=='ontology')setMaterialPreview(undefined);
    if(target==='search')setSearchDocumentId(documentId);
    setView(target);return true;
  }
  const [tasksOpen, setTasksOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsLeaveState, setSettingsLeaveState] = useState({dirty: false, busy: false});
  const [uploadOpen, setUploadOpen] = useState(false);
  const [libraryCollapsed, setLibraryCollapsed] = useState(false);
  const [skillsOpened, setSkillsOpened] = useState(false);
  const [status, setStatus] = useState<Status | null>(null);
  const [materialPreview, setMaterialPreview] = useState<SuggestionPreview>();
  const nativeOwner = status?.native_owner_management ?? (status?.integration_mode === 'standalone' && status.local_data_gate_mode === 'legacy');
  const materialOntology = useMaterialOntology(workspaceId, nativeOwner);
  const [documents, setDocuments] = useState<DocumentItem[]>([]);
  const documentListRequest = useRef(0);
  const maintenance=useMaterialMaintenance(workspaceId,documents,nativeOwner&&view==='materials');
  const [maintenanceOpen,setMaintenanceOpen]=useState(false),[onlyAttention,setOnlyAttention]=useState(false),[maintenanceRevision,setMaintenanceRevision]=useState(0);
  const maintenanceRows=documents.map(doc=>maintenance.items[doc.id]).filter((row):row is NonNullable<typeof row>=>!!row);
  const attentionCount=maintenanceRows.filter(needsMaterialAttention).length;
  const [jobs, setJobs] = useState<Job[]>([]);
  const [jobFeedback, setJobFeedback] = useState<{text: string; failed: boolean} | null>(null);
  const [jobsError, setJobsError] = useState('');
  const [jobPage, setJobPage] = useState(1);
  const [jobPageSize, setJobPageSize] = useState(10);
  const [jobTotal, setJobTotal] = useState(0);
  const [jobActivity, setJobActivity] = useState<JobActivity | null>(null);
  const jobActivityRef = useRef<JobActivity | null>(null);
  const [jobsLoading, setJobsLoading] = useState(true);
  const jobPagination = useRef({ page: 1, size: 10 });
  const jobRequestId = useRef(0);
  const jobRequestPending = useRef<{ id: number; pagination: { page: number; size: number }; promise: Promise<void> } | null>(null);
  const orderedJobs = useMemo(() => [...jobs].sort((first, second) => {
    // Compare the original UTC strings to preserve sub-millisecond precision.
    for (const field of ["updated_at", "created_at", "id"] as const) {
      if (first[field] !== second[field]) return first[field] < second[field] ? 1 : -1;
    }
    return 0;
  }), [jobs]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [materialReviewTarget,setMaterialReviewTarget]=useState<{documentId:string;target?:'current-extraction'}>();
  const initialMaterialSelected = useRef(false);
  const sourceToLocate = useRef<string | null>(null);
  const uploadPending = useRef(false);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [segmentWindowStart, setSegmentWindowStart] = useState(0);
  const [busy, setBusy] = useState(false);
  const [sensitiveSaving, setSensitiveSaving] = useState(false);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const materialSelection = useRef({id: selectedId, editing, saving});
  materialSelection.current = {id: selectedId, editing, saving};
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const correctionWrite = useRef<{documentId: string; body: string} | null>(null);
  const [correctionPending, setCorrectionPending] = useState(false);
  useEffect(()=>{
    const unsaved=editing&&Object.entries(drafts).some(([id,text])=>detail?.segments.find(segment=>segment.id===id)?.text!==text);
    if(!unsaved&&!saving&&!correctionPending)return;
    const warn=(event:BeforeUnloadEvent)=>{event.preventDefault();event.returnValue='';};
    window.addEventListener('beforeunload',warn);return()=>window.removeEventListener('beforeunload',warn);
  },[editing,drafts,detail,saving,correctionPending]);
  const [selectedSegmentId, setSelectedSegmentId] = useState<string | null>(null);
  const [locatedSourceId,setLocatedSourceId]=useState<string>();
  const [preparingCorrection,setPreparingCorrection]=useState(false);
  const correctionPreparation=useRef(false);
  const [focusedSource,setFocusedSource]=useState<Segment|null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [deletion, setDeletion] = useState<DeleteResult | null>(null);
  const deleteRequestId = useRef(0);
  const [deleteTarget, setDeleteTarget] = useState<DocumentItem | null>(null);
  const [deletingDocument, setDeletingDocument] = useState(false);
  const deleteOperation = useRef<{documentId: string; operationId: string} | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const jobPageCount = Math.max(1, Math.ceil(jobTotal / jobPageSize));

  const changeJobPage = useCallback((page: number, size = jobPagination.current.size) => {
    if (page === jobPagination.current.page && size === jobPagination.current.size) return;
    jobPagination.current = { page, size };
    jobRequestId.current += 1;
    setJobPage(page);
    setJobPageSize(size);
    setJobs([]);
    setJobsLoading(true);
  }, []);

  const refreshJobs = useCallback((force = false): Promise<void> => {
    const pagination = jobPagination.current;
    const pending = jobRequestPending.current;
    if (!force && pending?.pagination === pagination) return pending.promise;
    const id = ++jobRequestId.current;
    const promise = (async () => {
      try {
        const result = await requestJson<JobPageResult>(
          `/api/jobs?workspace_id=${encodeURIComponent(workspaceId)}&limit=${pagination.size}&offset=${(pagination.page - 1) * pagination.size}`,
        );
        // A late response from another page must never replace the visible one.
        if (id !== jobRequestId.current || pagination !== jobPagination.current) return;
        if (typeof result.total !== "number" || !result.activity) {
          throw new Error("任务分页接口尚未更新，请重启后端并刷新页面。");
        }
        setJobTotal(result.total);
        setJobActivity(result.activity);
        jobActivityRef.current = result.activity;
        const lastPage = Math.max(1, Math.ceil(result.total / pagination.size));
        if (pagination.page > lastPage) {
          changeJobPage(lastPage, pagination.size);
          return;
        }
        setJobs(result.items);
        setJobsError('');
        setJobsLoading(false);
      } catch (reason) {
        if (id !== jobRequestId.current || pagination !== jobPagination.current) return;
        setJobsError(reason instanceof Error ? reason.message : '任务列表读取失败');
        setJobsLoading(false);
        throw reason;
      } finally {
        if (jobRequestPending.current?.id === id) jobRequestPending.current = null;
      }
    })();
    jobRequestPending.current = { id, pagination, promise };
    return promise;
  }, [changeJobPage]);

  const report = useCallback((value: string, failed = false) => {
    if (failed) {
      setError(value);
      setMessage(null);
    } else {
      setMessage(value);
      setError(null);
    }
  }, []);

  const refresh = useCallback(async (forceJobs = false) => {
    const requestId = ++documentListRequest.current;
    const selectionAtStart = materialSelection.current.id;
    const results = await Promise.allSettled([
      readDocumentLibrary<DocumentItem>(workspaceId, requestJson).then(items => {
        if (requestId !== documentListRequest.current) return;
        setDocuments(items);
        const selection = materialSelection.current;
        if (selectionAtStart && selection.id === selectionAtStart && !items.some(item => item.id === selectionAtStart)
            && !selection.editing && !selection.saving && !materialLeaveState.current.dirty && !materialLeaveState.current.busy) {
          detailRequest.current++;
          setSelectedId(null); setDetail(null);
        }
      }),
      refreshJobs(forceJobs),
    ]);
    const failure = results.find(result => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
  }, [refreshJobs]);

  useEffect(() => {
    let current = true;
    refreshJobs().catch((reason: Error) => { if (current) setPollError(reason.message); });
    return () => { current = false; };
  }, [jobPage, jobPageSize, refreshJobs]);

  useEffect(() => {
    requestJson<Status>("/api/settings/status").then(setStatus).catch((reason: Error) => {
      setError(reason.message);
    });
  }, []);

  useEffect(() => {
    return startVisiblePolling({ refresh: async () => { await refresh(); setPollError(null); },
      delay: () => taskPollDelay(jobActivityRef.current),
      onError: reason => setPollError(reason instanceof Error ? reason.message : "任务状态更新失败") });
  }, [refresh]);

  const loadDetail = useCallback(async (documentId: string, offset = 0) => {
    const requestId=++detailRequest.current;
    const next = await requestJson<Detail>(
      `/api/documents/${documentId}?segment_offset=${offset}&segment_limit=${segmentPageSize}`,
    );
    if(requestId!==detailRequest.current)return;
    if (offset === 0) setSegmentWindowStart(0);
    setDetail((current) => {
      if (offset > 0 && current?.document.id === documentId) {
        if (current.version?.id !== next.version?.id) { setSegmentWindowStart(offset); return next; }
        return { ...next, blocks: current.blocks, segments: [...current.segments, ...next.segments] };
      }
      return next;
    });
    if (offset === 0) setSelectedSegmentId(next.segments[0]?.id ?? null);
  }, []);

  useEffect(() => {
    if (initialMaterialSelected.current || !documents.length || busy || editing ||
        materialLeaveState.current.dirty || materialLeaveState.current.busy) return;
    initialMaterialSelected.current = true;
    setSelectedId((current) => current ?? documents[0].id);
  }, [documents, busy, editing]);

  useEffect(() => {
    const selected = documents.find((item) => item.id === selectedId);
    if (
      selected?.status === "ready" &&
      (!detail || detail.document.id !== selected.id)
    ) {
      loadDetail(selected.id).catch((reason: Error) => setError(reason.message));
    }
  }, [documents, selectedId, detail, loadDetail]);

  useEffect(() => {
    if (!selectedId || editing) return;
    let disposed = false;
    const stopPolling = startVisiblePolling({
      delay: () => Math.max(5000, taskPollDelay(jobActivityRef.current)), onError: () => undefined,
      refresh: () => requestJson<Detail>(`/api/documents/${selectedId}?segment_limit=${segmentPageSize}`)
        .then((next) => {
          if (disposed) return;
          setDetail((current) => {
            if (current?.document.id !== selectedId) return current;
            if (current.version?.id !== next.version?.id) {
              if(materialLeaveState.current.dirty||materialLeaveState.current.busy||correctionPreparation.current)return current;
              setSelectedSegmentId(next.segments[0]?.id ?? null);
              setSegmentWindowStart(0);
              return next;
            }
            return { ...next, segments: current.segments, blocks: current.blocks };
          });
        }),
    });
    return () => { disposed = true; stopPolling(); };
  }, [selectedId, editing]);

  const foregroundJobCount = jobActivity?.foreground_count ?? 0;
  const sensitiveJob = jobActivity?.sensitive_job;
  const runtimeText = !jobActivity ? "正在获取任务状态…" : foregroundJobCount
    ? `${foregroundJobCount} 个材料/索引任务处理中${sensitiveJob ? ` · 脱敏扫描${sensitiveJob.status === "running" ? "中" : "排队中"}` : ""}`
    : sensitiveJob
      ? `后台脱敏扫描${sensitiveJob.status === "running" ? "中" : "排队中"}${sensitiveJob.metrics?.pending_texts != null ? ` · 本轮新检测 ${sensitiveJob.metrics.new_detected_texts ?? 0}/${sensitiveJob.metrics.pending_texts} 种文本` : ""}`
      : "任务队列空闲";
  const selectedDocument = documents.find((item) => item.id === selectedId) ?? null;
  const selectedSegment =
    detail?.segments.find((segment) => segment.id === selectedSegmentId) ??
    detail?.segments[0] ??
    null;
  const visualDocument = detail?.document.document_format === "image" || detail?.document.document_format === "pdf";
  const audioDocument = detail?.document.document_format === "audio";
  const selectedBlock = !editing ? detail?.blocks?.find((b) => b.source_refs?.some((ref) => ref.segment_id === selectedSegmentId)) : null;
  const displaySegments = !editing && detail?.blocks?.length ? detail.blocks : detail?.segments ?? [];
  const focusedSourceActive=focusedSource?.id===selectedSegmentId?focusedSource:null;
  const selectedKnowledgeSource:SelectedKnowledgeSource|undefined=detail?.version&&!editing?(()=>{
    const ref=selectedBlock?.source_refs?.find(item=>item.segment_id===selectedSegmentId);
    const segmentId=ref?.segment_id??focusedSourceActive?.id??selectedSegment?.id;
    if(!segmentId)return undefined;
    const raw=detail.segments.find(item=>item.id===segmentId);
    const locator=ref?.locator??focusedSourceActive?.source_locator??raw?.source_locator??{};
    const text=raw?Array.from(raw.text).slice(ref?.source_char_start??0,ref?.source_char_end).join(''):
      selectedBlock&&typeof ref?.block_char_start==='number'&&typeof ref.block_char_end==='number'?Array.from(selectedBlock.text).slice(ref.block_char_start,ref.block_char_end).join(''):undefined;
    return {documentId:detail.document.id,versionId:detail.version.id,segmentId,start:ref?.source_char_start,end:ref?.source_char_end,label:sourceLabel(locator),text};
  })():undefined;
  const previewUrl = focusedSourceActive?.preview_url ?? selectedBlock?.preview_url ?? selectedSegment?.preview_url;
  const highlightSegments = focusedSourceActive?[focusedSourceActive]:selectedBlock?.source_refs?.map((ref) => ({ id: ref.segment_id, kind: "source", text: "", source_locator: ref.locator })) ?? (selectedSegment ? [selectedSegment] : []);

  function selectSegment(segment: Segment) {
    setFocusedSource(null);
    setSelectedSegmentId(segment.id);
    if (!audioDocument || !audioRef.current) return;
    const start = Number(segment.source_locator.start_seconds);
    if (!Number.isFinite(start)) return;
    audioRef.current.currentTime = start;
    void audioRef.current.play().catch(() => undefined);
  }

  function synchronizeAudio(currentTime: number) {
    if (!detail || editing) return;
    const matching = detail.segments.find((segment) => {
      const start = Number(segment.source_locator.start_seconds);
      const end = Number(segment.source_locator.end_seconds);
      return Number.isFinite(start) && Number.isFinite(end) && currentTime >= start && currentTime < end;
    });
    if (matching && matching.id !== selectedSegmentId) setSelectedSegmentId(matching.id);
  }

  async function upload(files: FileList | null) {
    if (!files?.length || uploadPending.current) return;
    uploadPending.current = true;
    const interactionAtUpload=materialInteraction.current;
    const canOpenImported=!editing&&!materialLeaveState.current.dirty&&!materialLeaveState.current.busy;
    let firstImported:DocumentItem|undefined;
    setBusy(true);
    setError(null);
    setMessage(null);
    let reused = 0;
    let accepted = 0;
    const failures: string[] = [];
    try {
      for (const file of Array.from(files)) {
        try {
          const form = new FormData();
          form.append("workspace_id", workspaceId);
          form.append("file", file, file.name);
          const result = await requestJson<{ reused: boolean;document:DocumentItem }>("/api/documents", {
            method: "POST",
            body: form,
          });
          accepted += 1;
          firstImported??=result.document;
          if (result.reused) reused += 1;
        } catch (reason) {
          failures.push(
            `${file.name}：${reason instanceof Error ? reason.message : "上传失败"}`,
          );
        }
      }
      if(firstImported&&canOpenImported&&interactionAtUpload===materialInteraction.current&&!materialLeaveState.current.dirty&&!materialLeaveState.current.busy)openDocument(firstImported);
      if (failures.length) setError(failures.join("；"));
      if (accepted) {
        const feedback = `导入提交成功：已接收 ${accepted} 个文件。${reused ? `其中 ${reused} 个复用了已有文档。` : ''}解析、知识抽取与索引处理进度请查看下方任务。`;
        setMessage(feedback);
        setJobFeedback({text: failures.length ? `${feedback}另有 ${failures.length} 个文件导入失败：${failures.join('；')}` : feedback, failed: failures.length > 0});
        changeJobPage(1);
        setUploadOpen(false);
        setTasksOpen(true);
        // Submission has succeeded even if refreshing the lists fails.
        try { await refresh(true); } catch (reason) {
          setJobsError(`导入已提交，列表刷新失败：${reason instanceof Error ? reason.message : '请稍后刷新'}`);
        }
      }
    } finally {
      uploadPending.current = false;
      setBusy(false);
    }
  }

  function openDocument(document: DocumentItem) {
    if(!leaveMaterialReview())return;
    initialMaterialSelected.current = true;
    materialInteraction.current++;
    detailRequest.current++;
    setSelectedId(document.id);
    setError(null);
    setDetail(null);
    setEditing(false);
    setSegmentWindowStart(0);
    setDrafts({});
    setSelectedSegmentId(null);
    setLocatedSourceId(undefined);setFocusedSource(null);
  }

  async function openIndexSource(source: IndexSource, signal: AbortSignal) {
    if (!leaveMaterialReview()) throw new Error('请先保存或放弃当前调整');
    const requestId = ++detailRequest.current;
    const offset = Math.floor((source.segment_offset ?? 0) / segmentPageSize) * segmentPageSize;
    const next = await requestJson<Detail>(`/api/documents/${encodeURIComponent(source.document_id)}?segment_offset=${offset}&segment_limit=${segmentPageSize}`, {signal}, 15000);
    if (signal.aborted) return;
    if (requestId !== detailRequest.current) throw new Error('材料选择已变化，请重新打开');
    if (next.version?.id !== source.version_id || !next.segments.some(s => s.id === source.id)) throw new Error('材料正文已变化，请刷新明细后重新定位');
    initialMaterialSelected.current = true;
    materialInteraction.current++;
    sourceToLocate.current = source.id;
    setSelectedId(source.document_id);
    setDetail(next);
    setSegmentWindowStart(offset);
    setSelectedSegmentId(source.id);
    setEditing(false); setDrafts({}); setLocatedSourceId(source.id);setFocusedSource(next.segments.find(segment=>segment.id===source.id)??null);setError(null);
    setView('materials');
  }

  useEffect(() => {
    if (view !== 'materials' || !sourceToLocate.current || sourceToLocate.current !== selectedSegmentId) return;
    const element = document.querySelector(`[data-source-segment="${CSS.escape(sourceToLocate.current)}"]`);
    if (element) { element.scrollIntoView({block: 'nearest'}); sourceToLocate.current = null; }
  }, [view, detail, selectedSegmentId]);

  const jobActionsPending = useRef(new Set<string>());
  const [busyJobActions, setBusyJobActions] = useState<Record<string, string>>({});
  async function jobAction(job: Job, action: "retry" | "cancel") {
    if (jobActionsPending.current.has(job.id)) return;
    jobActionsPending.current.add(job.id);
    setBusyJobActions((current) => ({ ...current, [job.id]: action }));
    setJobFeedback(null);
    setError(null);
    try {
      const next = await requestJson<Job>(`/api/jobs/${job.id}/${action}`, { method: "POST" });
      if (action === "retry") {
        changeJobPage(1);
        setDeletion((current) => current?.cleanup_job?.id === job.id
          ? { ...current, cleanup_job: next } : current);
      }
      const feedback = action === 'cancel' ? next.status === 'cancelled' ? '任务已取消。' : '已请求取消，正在中止当前任务。'
        : job.kind === 'sensitive_scan' ? '已按当前索引和脱敏配置安排扫描重试。'
        : job.kind === 'search_index' ? next.status === 'succeeded' ? '当前材料已有可用索引，无需重复构建。' : '已按当前材料和模型配置安排索引更新。'
        : '已安排任务重试。';
      setMessage(feedback);
      setJobFeedback({text: feedback, failed: false});
      await refresh(true);
    } catch (reason) {
      const feedback = reason instanceof Error ? reason.message : '任务操作失败';
      setError(feedback);
      setJobFeedback({text: feedback, failed: true});
    }
    finally {
      jobActionsPending.current.delete(job.id);
      setBusyJobActions((current) => { const next = { ...current }; delete next[job.id]; return next; });
    }
  }

  function removeDocument(document: DocumentItem) {
    if (correctionPending) { report('请先重试保存以确认正文校对结果，再删除材料。',true);return; }
    if (saving || correctionPreparation.current || materialLeaveState.current.busy) {
      report('材料正在保存或读取校对来源，请等待完成后再删除。', true); return;
    }
    setError(null); setDeleteTarget(document);
    if (deleteOperation.current?.documentId !== document.id)
      deleteOperation.current = {documentId: document.id, operationId: crypto.randomUUID()};
  }
  async function confirmDocumentDeletion() {
    const document = deleteTarget;
    if (!document || deletingDocument) return;
    if (saving || correctionPreparation.current || materialLeaveState.current.busy) {
      setError('材料正在保存或读取校对来源，请等待完成后再确认删除。'); return;
    }
    const operation = deleteOperation.current;
    if (!operation || operation.documentId !== document.id) return;
    const requestId = ++deleteRequestId.current;
    setError(null); setDeletingDocument(true);
    try {
      const response = await requestJson<DeleteResult & { processing_warnings?: string[] }>(
        `/api/documents/${document.id}?confirm=true`, { method: "DELETE",
          headers: {'Content-Type': 'application/json'}, body: JSON.stringify({operation_id: operation.operationId}) },
      );
      if (requestId === deleteRequestId.current) {
        setDeleteTarget(null); deleteOperation.current = null;
        setEditing(false); setDrafts({}); setSelectedId(null); setDetail(null); detailRequest.current++;
        setMessage(embeddedHost() ? '材料删除请求已受理，派生数据清理进度请查看任务中心。' : null);
        setDeletion(embeddedHost() ? null : response);
        if (response.processing_warnings?.length) setError(response.processing_warnings.join("；"));
      }
      try { await refresh(); }
      catch { setError('删除已受理，但列表刷新失败，请刷新页面查看结果。'); }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "删除失败");
    } finally { setDeletingDocument(false); }
  }

  async function beginCorrection() {
    if(!leaveMaterialReview())return;
    materialInteraction.current++;
    if (!detail?.version) return;
    correctionPreparation.current=true;setPreparingCorrection(true);setError(null);
    const documentId=detail.document.id,versionId=detail.version.id,requestId=++detailRequest.current;
    try{
      const segments=await loadCorrectionSegments(detail,segmentWindowStart,()=>requestId===detailRequest.current);
      setDetail(current=>current?.document.id===documentId&&current.version?.id===versionId?{...current,segments}:current);
      setSegmentWindowStart(0);setFocusedSource(null);setLocatedSourceId(undefined);
      setDrafts(Object.fromEntries(segments.map(segment=>[segment.id,segment.text])));setEditing(true);
    }catch(reason){setError(reason instanceof Error?reason.message:'读取校对来源失败');}
    finally{correctionPreparation.current=false;setPreparingCorrection(false);}
  }

  async function saveCorrection() {
    if (!detail?.version || saving) return;
    setSaving(true);
    setError(null);
    try {
      if (!correctionWrite.current) {
        if (detail.segments.length !== detail.document.segment_count || detail.segments.some(s=>s.text_truncated))
          throw new Error('正文尚未完整读取，不能保存校对。');
        correctionWrite.current = {documentId: detail.document.id, body: JSON.stringify({
          operation_id: crypto.randomUUID(), base_version_id: detail.version.id,
          segments: detail.segments.map(segment=>({id:segment.id,text:drafts[segment.id]??segment.text})),
        })};
      }
      const pending = correctionWrite.current;
      setCorrectionPending(true);
      const corrected = await requestJson<Detail>(
        `/api/documents/${pending.documentId}/content`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: pending.body,
        },
      );
      correctionWrite.current=null;setCorrectionPending(false);
      setDetail(corrected);
      setSelectedSegmentId(corrected.segments[0]?.id ?? null);
      setEditing(false);
      setDrafts({});
      setMessage("校对内容已保存为新的不可变版本。");
      try { await refresh(); }
      catch { setError('校对已保存，但列表刷新失败，请刷新查看。'); }
    } catch (reason) {
      const status=(reason as {status?:number})?.status;
      if(status && [400,401,403,404,409,413,422].includes(status)){
        correctionWrite.current=null;setCorrectionPending(false);
      }
      setError(reason instanceof Error ? reason.message : "保存校对版本失败");
    } finally {
      setSaving(false);
    }
  }

  const pageNames = { materials: '知识核对', ontology: '类型与关系', releases: '版本历史', graph: '知识网络', search: '知识检索', sensitive: '脱敏设置', skills: '推理方法', review: '知识核对' };
  const pageDescriptions = { materials: '阅读原文，核对依据，将可信的知识发布到网络。', ontology: '管理的是类型规则，不是材料中的具体实体。', releases: '追溯已发布知识的变化，查看当时使用的正文与来源依据。', graph: '查看已发布知识之间的联系，回到材料核对来源。', search: '检索正文与已发布知识，回到原文核对每一条依据。', sensitive: '设置敏感内容的保护方式，使用已保存规则验证处理效果。', skills: '管理分析方法，查看和维护可供外部助手使用的方法包。', review: '对照原文核对知识。' };
  const navIcons: Record<string, IconName> = { materials: 'materials', ontology: 'ontology', releases: 'releases', graph: 'graph', search: 'search', sensitive: 'sensitive', skills: 'skills' };
  const activeIcons: Record<string, IconName> = { materials: 'materialsActive', ontology: 'ontologyActive', releases: 'releasesActive', search: 'searchActive', sensitive: 'sensitiveActive' };
  useEffect(() => { embeddedHost()?.viewChanged(window, view); }, [view]);
  useEffect(() => {
    embeddedHost()?.register(window, { view,
      navigate(target, ontologyAction) {
        const activeDialog = ontologyAction && view === 'ontology' && document.querySelector<HTMLDialogElement>('.ontology-page dialog[open]');
        if (activeDialog) {
          requestAnimationFrame(() => activeDialog.focus());
          return true;
        }
        if (!navigate(target as typeof view)) return false;
        setOntologyNavigation(ontologyAction ? { action: ontologyAction } : undefined);
        return true;
      },
      canLeave: canLeaveView, clearOntologyAction: clearOntologyNavigation,
      refreshGraph:()=>window.dispatchEvent(new Event('starlink:graph-changed')),
      openMaterial: (documentId,reviewTarget) => {
        if(!/^[A-Za-z0-9_-]{1,128}$/.test(documentId)||!canLeaveView()||!leaveMaterialReview())return false;
        initialMaterialSelected.current=true;materialInteraction.current++;detailRequest.current++;
        setMaterialReviewTarget({documentId,target:reviewTarget});
        setSelectedId(documentId);setDetail(null);setEditing(false);setDrafts({});setSegmentWindowStart(0);
        setSelectedSegmentId(null);setLocatedSourceId(undefined);setFocusedSource(null);setView('materials');
        // The requested material may be outside the currently loaded library page.
        const requestId=detailRequest.current+1;
        void loadDetail(documentId).catch(reason=>{if(detailRequest.current===requestId)setError(reason instanceof Error?reason.message:'材料读取失败');});
        return true;
      } });
  });
  return (
    <main className={`workbench-app ${embeddedHost() ? "embedded-workbench" : ""} view-${view} ${new URLSearchParams(location.search).has("native") ? "native-mode" : ""}`}>
      <aside className="app-sidebar">
        <div className="app-brand"><span><DesignIcon name="brand" /></span><strong>知识网络工作台</strong></div>
        <div className="workspace-label"><small>WORKSPACE</small><span>研究与知识管理</span></div>
      <nav className="primary-nav" aria-label="工作台功能">
        {([
          ["materials", "知识核对"],
          ["ontology", "类型与关系"],
          ["releases", "版本历史"],
          ["graph", "知识网络"],
          ["search", "知识检索"],
          ["sensitive", "脱敏设置"],
          ["skills", "推理方法"],
        ] as const).filter(([key]) => !new URLSearchParams(location.search).has("native") || ["materials","ontology","releases"].includes(key)).map(([key, label]) => (
          <button
            type="button"
            className={view === key ? "active" : ""}
            key={key}
            disabled={sensitiveSaving}
            onClick={() => navigate(key)}
          >
            <DesignIcon name={view === key ? activeIcons[key] ?? navIcons[key] : navIcons[key]} />{label}
          </button>
        ))}
      </nav>
        <div className="sidebar-bottom"><button type="button" disabled={sensitiveSaving} onClick={() => setSettingsOpen(true)}><DesignIcon name="settings" />设置</button>
          <small><i className={status?.knowledge_auto_pipeline_ready ? 'dot' : 'status-unready'} />{!status ? '正在读取服务状态' : status.knowledge_auto_pipeline_ready ? '服务已就绪' : '部分服务未就绪'}</small></div>
      </aside>
      <div className="app-workspace">
      <header className="app-topbar"><div className="breadcrumb"><span>工作台</span><span>/</span><strong>{pageNames[view]}</strong></div>
        <div className="topbar-actions"><span className="runtime"><i className={foregroundJobCount || sensitiveJob ? 'pulse' : 'dot'} />{runtimeText}</span>
          <button type="button" onClick={() => setTasksOpen(true)}><DesignIcon name="tasks" />任务中心</button>
          <span title="正文、知识与类型建议分别处理；可在任务中心查看进度。" aria-label="使用说明"><DesignIcon name="help" /></span></div></header>
      <div className="app-content">
      <header className="page-heading"><div><h1>{pageNames[view]}</h1><p>{pageDescriptions[view]}</p></div>
        {view === 'materials' && <button type="button" disabled={sensitiveSaving} onClick={() => navigate('graph')}><DesignIcon name="network" />查看知识网络</button>}</header>
      {settingsOpen && <WorkbenchDrawer title="设置" close={() => { if (!settingsLeaveState.dirty || window.confirm('连接设置尚未保存，确认放弃本次修改？')) { setSettingsOpen(false); setSettingsLeaveState({dirty:false,busy:false}); } }} canClose={!sensitiveSaving && !settingsLeaveState.busy}>
        <LLMConfigPanel report={report} onLeaveState={setSettingsLeaveState} onSaved={() => { void requestJson<Status>('/api/settings/status').then(setStatus).catch(() => undefined); }} />
        <p className="muted">知识抽取与脱敏检测共用此连接。新配置用于新任务，已运行的任务不会重启。</p>
      </WorkbenchDrawer>}

      {skillsOpened && <div hidden={view !== "skills"}><Suspense fallback={<p className="empty">正在加载推理方法管理…</p>}><SkillWorkbench workspace={workspaceId} mode={status?.integration_mode} /></Suspense></div>}
      {view === 'releases' && <Suspense fallback={<p>正在加载版本历史…</p>}><KnowledgeReleases key={workspaceId} workspace={workspaceId} /></Suspense>}

      {message && <div className="notice success">{message}</div>}
      {deletion && <DeleteIndexNotice result={deletion} workspace={workspaceId} read={requestJson} />}
      {(error || pollError) && <div className="notice error">{error || pollError}</div>}
      {deleteTarget && <WorkbenchDrawer title="确认删除材料" canClose={!deletingDocument} close={() => setDeleteTarget(null)}>
        <p>确认从当前数据仓彻底删除“{deleteTarget.original_name}”及其原件、解析内容和派生数据？此操作不可撤销。已有历史备份不会被自动改写。</p>
        <p>此材料尚未保存的正文、实体或规则调整也会丢失。</p>
        {error && <p role="alert">{error}</p>}
        <button type="button" disabled={deletingDocument} onClick={() => setDeleteTarget(null)}>取消</button>
        <button type="button" disabled={deletingDocument} onClick={() => void confirmDocumentDeletion()}>{deletingDocument ? '正在删除…' : '确认删除'}</button>
      </WorkbenchDrawer>}

      {view === "materials" && (
        <>

      {uploadOpen && <WorkbenchDrawer title="导入材料" close={() => setUploadOpen(false)} canClose={!busy}><section className="upload-panel">
        {error && <p role="alert" className="notice error">{error}</p>}
        {message && <p role="status" className="notice">{message}</p>}
        <div>
          <h2>上传文字、图像与音频材料</h2>
          <p>支持 TXT、Markdown、DOCX、PDF、PNG、JPEG、WAV、MP3、M4A 和 FLAC。</p>
          <p className="ontology-notice">上传后自动解析正文、抽取知识并构建索引。符合规则的自动结果可发布；未入图候选和人工修改在“知识核对”核对后再发布。正文检索无需等待人工核对。</p>
          {status && (
            <small>
              单文件上限 {formatBytes(status.document_max_bytes)} · 图片最多 {status.document_max_image_pixels.toLocaleString()} 像素 · 音频最长 {Math.round(status.asr_max_duration_seconds / 60)} 分钟
            </small>
          )}
        </div>
        <label className={busy ? "upload-button disabled" : "upload-button"}>
          {busy ? "正在接收…" : "选择文件"}
          <input
            type="file"
            multiple
            disabled={busy}
            accept=".txt,.md,.markdown,.docx,.pdf,.png,.jpg,.jpeg,.wav,.mp3,.m4a,.flac"
            onChange={(event) => {
              void upload(event.target.files);
              event.currentTarget.value = "";
            }}
          />
        </label>
      </section></WorkbenchDrawer>}

      <div className={`workspace ${libraryCollapsed ? "library-collapsed" : ""}`}>
        <section className="library">
          <div className="section-title">
            <h2>材料库 <small>{documents.length}</small></h2>
            <button className="icon-button library-collapse" aria-label={libraryCollapsed ? "展开材料库" : "收起材料库"} onClick={() => setLibraryCollapsed(!libraryCollapsed)}><DesignIcon name="collapse" /></button>
          </div>
          <div className="library-primary-actions">
            <button className="import-materials" type="button" disabled={busy} onClick={() => setUploadOpen(true)}><DesignIcon name="plus" />导入材料</button>
            {nativeOwner&&<label><input type="checkbox" checked={onlyAttention} onChange={event=>setOnlyAttention(event.target.checked)}/>待处理</label>}
          </div>
          {nativeOwner&&<div className="library-maintenance"><button disabled={busy} onClick={()=>{
            if(editing||saving||materialLeaveState.current.dirty||materialLeaveState.current.busy){report('请先保存或取消当前正文、实体及规则修改，再集中处理材料。',true);return;}
            setMaintenanceOpen(true);void maintenance.refresh();
          }}>材料更新与核对{attentionCount?` · ${attentionCount}`:''}</button>
          {maintenance.error&&<small role="alert">材料状态读取失败，请打开更新面板重试。</small>}</div>}
          <div className="library-items">
          {!documents.length && <div className="empty">上传第一份材料开始验证入库流程。</div>}
          {nativeOwner&&onlyAttention&&!attentionCount&&<div className="empty">{maintenance.error?'材料状态读取失败，请刷新重试。':maintenanceRows.length<documents.length?'正在检查材料状态…':'当前没有待处理材料。'}</div>}
          {documents.filter(document=>!nativeOwner||!onlyAttention||needsMaterialAttention(maintenance.items[document.id])).map((document) => (
            <button
              type="button"
              className={`document-row ${selectedId === document.id ? "selected" : ""}`}
              key={document.id}
              onClick={() => openDocument(document)}
            >
              <DesignIcon name={selectedId === document.id ? "fileActive" : "file"} />
              <span className="document-main">
                <strong>{document.original_name}</strong>
                <small>
                  {document.document_format.toUpperCase()} · {formatBytes(document.size_bytes)} · {document.segment_count} 段来源
                </small>
                {nativeOwner && materialOntologyLabel(materialOntology.items[document.id]) && <small className="ontology-material-badge">{materialOntologyLabel(materialOntology.items[document.id])}</small>}
                {nativeOwner&&maintenance.items[document.id]&&<small className={`material-maintenance-badge ${maintenance.items[document.id].state}`} title={maintenance.items[document.id].reason}>{maintenance.items[document.id].label}</small>}
                {nativeOwner&&!maintenance.items[document.id]&&<small>{maintenance.error?'更新状态暂不可用':'正在检查更新状态…'}</small>}
              </span>
              <span className={`badge ${document.status}`}>
                {statusText[document.status] ?? document.status}
              </span>
            </button>
          ))}</div>
          <p className="library-note">正文、知识与类型建议分别处理；查看任务可了解详细进度。</p>
        </section>

        <aside className="detail">
          {!selectedId && <div className="empty">选择一份文档查看正文和来源位置。</div>}
          {selectedId && !detail && (
            <div className="pending-detail">
              <div className="empty">文档尚未解析完成，请在任务中心查看当前阶段。</div>
              {selectedDocument && (
                <button type="button" onClick={() => void removeDocument(selectedDocument)}>
                  删除文档
                </button>
              )}
            </div>
          )}
          {detail && (
            <>
              <div className={nativeOwner&&!editing?"material-review-layout":"material-read-layout"}>
              <section className="material-source-panel">
              <div className="detail-heading">
                <div>
                  <h2>{detail.document.original_name}</h2>
                  <p>
                    正文 v{detail.version?.version_number} · {detail.version?.version_kind === "corrected" ? "人工校对" : "自动解析"}
                  </p>
                </div>
              </div>
              <div className="source-shortcuts" role="group" aria-label="材料操作">
                {!editing ? <>
                  <button type="button" className="source-correct-primary" disabled={preparingCorrection} onClick={()=>void beginCorrection()}><DesignIcon name="edit" />{preparingCorrection?'正在读取校对来源…':'校对正文'}</button>
                  <span className="source-correction-hint">按来源片段修改</span>
                </> : <>
                  <button type="button" className="source-correct-primary" disabled={saving} onClick={() => void saveCorrection()}>{saving ? "保存中…" : correctionPending ? "重试并确认保存结果" : "保存新版本"}</button>
                  <button type="button" disabled={saving || correctionPending} onClick={() => { if(!leaveMaterialReview())return;setEditing(false); setDrafts({}); }}>取消校对</button>
                  <span className="source-correction-hint">修改下方来源片段，保存为新正文版本</span>
                </>}
                <a href={detail.document.original_url} target="_blank" rel="noreferrer">查看原件</a>
                <button type="button" disabled={saving} onClick={() => void removeDocument(detail.document)}>删除</button>
                <span className={`badge ${status?.knowledge_auto_pipeline_ready ? "succeeded" : "failed"}`}>
                  {status?.knowledge_auto_pipeline_ready ? "知识自动处理" : "自动处理未就绪"}
                </span>
              </div>
              {detail.version?.metadata.requires_review === true && (
                <div className="review-warning">部分识别结果质量指标较低，请结合原始材料校对后再用于后续处理。</div>
              )}
              {detail.processing && <div className="processing-summary" role="status">
                <span>{detail.processing.text_ready ? "正文可查看" : "正文解析中"}</span>
                <span>{detail.processing.index_ready ? "文本检索就绪" : "文本索引待更新"}</span>
                <span>{({ published: "图谱就绪", empty: "处理完成，未形成有效关系", failed: "图谱处理失败", cancelled: "图谱已取消", pending: "图谱待处理", retracted: "图谱已撤回", stale: "图谱结果已失效" } as Record<string, string>)[detail.processing.graph_status] ?? "图谱处理中"}</span>
                <span>{({ succeeded: "交付检测完成", failed: "交付检测失败", cancelled: "交付检测已取消", disabled: "交付脱敏未启用", index_required: "交付检测等待索引", not_started: "交付检测待处理", queued: "交付检测排队中", pending: "交付检测待处理" } as Record<string, string>)[detail.processing.delivery_status] ?? "交付检测中"}</span>
              </div>}
              {detail.processing?.knowledge_summary && <details className="document-knowledge-outcome"><summary>查看抽取结果与未入图原因</summary>
                <KnowledgeOutcome summary={detail.processing.knowledge_summary} />
              </details>}
              {audioDocument && (
                <div className="audio-panel">
                  <audio
                    key={detail.document.id}
                    ref={audioRef}
                    controls
                    preload="metadata"
                    src={detail.document.original_url}
                    onTimeUpdate={(event) => synchronizeAudio(event.currentTarget.currentTime)}
                  >
                    当前浏览器无法播放该音频，请使用“原件”下载查看。
                  </audio>
                  <small>点击下方转写片段可从对应时间开始播放。</small>
                </div>
              )}
              <div className={visualDocument ? "evidence-layout" : "evidence-layout text-only"}>
                {visualDocument && (
                  <div className="preview-panel">
                    {previewUrl ? (
                      <div className="preview-frame">
                        <img src={previewUrl} alt="当前来源页面" />
                        {highlightSegments.map((source, i) => highlightStyle(source) && <span key={`${source.id}:${i}`} className="source-highlight" style={highlightStyle(source)} />)}
                      </div>
                    ) : (
                      <div className="empty">选择带页码的片段查看原图位置。</div>
                    )}
                  </div>
                )}
                <div className="segments">
                  <h3 className="body-view-heading">{editing?'校对正文':'正文'}</h3>
                  <p className="segment-note">
                    {editing ? "按原始来源片段校对，保存后生成新的正文版本。" : "按段落阅读，来源位置保留在段落上方；多个来源可展开查看，点击来源可定位原件。"}
                  </p>
                  {!editing&&selectedSegment&&locatedSourceId===selectedSegment.id&&!selectedBlock&&!!detail.blocks?.length&&<article className="segment active located-source" data-source-segment={selectedSegment.id}>
                    <strong>已定位的来源片段 · {sourceLabel(selectedSegment.source_locator)}</strong><p>{selectedSegment.text}</p><small>对应段落尚未加载，先显示这条原始来源。</small><button type="button" onClick={()=>setLocatedSourceId(undefined)}>收起定位片段</button>
                  </article>}
                  {(editing||!detail.blocks?.length) && segmentWindowStart > 0 && <p className="segment-note">当前从第 {segmentWindowStart + 1} 个来源片段开始显示。<button type="button" onClick={() => void loadDetail(detail.document.id).catch((reason: Error) => setError(reason.message))}>返回正文开头</button></p>}
                  {displaySegments.map((segment) => (
                    <article
                      className={`segment ${(selectedBlock?.id ?? selectedSegment?.id) === segment.id ? "active" : ""} ${segment.source_locator.low_confidence ? "low-confidence" : ""}`}
                      key={segment.id}
                      data-source-segment={segment.source_refs?.some(ref=>ref.segment_id===selectedSegmentId)?selectedSegmentId:segment.id}
                      onClick={() => {
                        const ref = segment.source_refs?.[0];
                        selectSegment(ref ? { ...segment, id: ref.segment_id, source_locator: ref.locator } : segment);
                      }}
                    >
                      <div>
                        <span>{sourceLabel(segment.source_locator)}</span>
                        <code>{segment.source_refs ? `${segment.source_refs.length} 个来源` : segment.kind}</code>
                      </div>
                      {editing ? (
                        <textarea
                          disabled={saving || correctionPending}
                          value={drafts[segment.id] ?? segment.text}
                          onClick={(event) => event.stopPropagation()}
                          onChange={(event) =>
                            setDrafts((current) => ({
                              ...current,
                              [segment.id]: event.target.value,
                            }))
                          }
                        />
                      ) : (
                        <p>{segment.text}</p>
                      )}
                      {!editing&&!!segment.source_refs?.length&&segment.source_refs.length>1&&<details className="paragraph-sources" open={locatedSourceId&&segment.source_refs.some(ref=>ref.segment_id===locatedSourceId)?true:undefined} onClick={event=>event.stopPropagation()}>
                        <summary>查看 {segment.source_refs.length} 个来源片段</summary>
                        {segment.source_refs.map((ref,index)=>{
                          const raw=detail.segments.find(item=>item.id===ref.segment_id);
                          const text=raw?Array.from(raw.text).slice(ref.source_char_start??0,ref.source_char_end).join(''):
                            typeof ref.block_char_start==='number'&&typeof ref.block_char_end==='number'?Array.from(segment.text).slice(ref.block_char_start,ref.block_char_end).join(''):null;
                          const page=Number(ref.locator.page);
                          return <div key={`${ref.segment_id}:${index}`} className="paragraph-source" data-source-ref={ref.segment_id}>
                            <button type="button" aria-pressed={focusedSourceActive?.id===ref.segment_id} onClick={()=>{
                              const source={id:ref.segment_id,kind:raw?.kind??'source',text:raw?.text??'',source_locator:ref.locator,
                                preview_url:raw?.preview_url??(visualDocument&&Number.isInteger(page)&&page>0?`/api/documents/${encodeURIComponent(detail.document.id)}/pages/${page}/preview`:segment.preview_url)};
                              selectSegment(source);setFocusedSource(source);
                            }}>{sourceLabel(ref.locator)}</button>
                            {text&&<><small>{raw?'原始来源内容':'段内对应内容'}</small><p>{text}</p></>}
                            {!!ref.locator.low_confidence&&<small>此来源识别置信度较低，请结合原件核对。</small>}
                          </div>;
                        })}
                      </details>}
                    </article>
                  ))}
                  {(editing||!detail.blocks?.length) && segmentWindowStart + detail.segments.length < detail.document.segment_count && (
                    <button
                      className="load-more"
                      type="button"
                      onClick={() => void loadDetail(detail.document.id, segmentWindowStart + detail.segments.length).catch((reason: Error) => setError(reason.message))}
                    >
                      加载更多来源片段
                    </button>
                  )}
                  {!editing && (detail.blocks?.length ?? 0) < (detail.block_count ?? 0) && <button type="button" className="load-more" onClick={() => void (async () => {
                    const next = await requestJson<Detail>(`/api/documents/${detail.document.id}?block_offset=${detail.blocks?.length ?? 0}`);
                    setDetail((current) => current?.document.id === next.document.id && current.version?.id === next.version?.id ? { ...current, blocks: [...new Map([...(current.blocks ?? []), ...(next.blocks ?? [])].map(block=>[block.id,block])).values()] } : current);
                  })().catch((reason: Error) => setError(reason.message))}>加载更多正文</button>}
                </div>
              </div>
              <p className="source-revision-note">正文修订将生成新版本，并可能需要重新核对知识证据。</p>
              </section>
              {nativeOwner&&!editing&&<div className="material-review-side">
                <Suspense fallback={<p>正在读取知识核对内容…</p>}><DocumentKnowledgeCorrections inline key={`${detail.document.id}:${maintenanceRevision}:${materialReviewTarget?.documentId===detail.document.id?materialReviewTarget.target||'':''}`}
                  workspace={workspaceId} documentId={detail.document.id} documentName={detail.document.original_name}
                  reviewTarget={materialReviewTarget?.documentId===detail.document.id?materialReviewTarget.target:undefined}
                  materialNotice={detail.document.status==='ready' ? <MaterialOntologyNotice key={`${detail.document.id}:${detail.version?.id}`}
                  workspace={workspaceId} documentId={detail.document.id} status={materialOntology.items[detail.document.id]}
                  error={materialOntology.error} disabled={saving} refresh={materialOntology.refresh}
                  onReview={()=>document.querySelector('.material-rule-editor')?.scrollIntoView({behavior:'smooth',block:'start'})} /> : undefined}
                  materialStatus={materialOntology.items[detail.document.id]} onLeaveState={updateMaterialLeaveState} selectedSource={selectedKnowledgeSource} onSearch={()=>navigate('search',detail.document.id)} /></Suspense>
              </div>}
              </div>
            </>
          )}
        </aside>
      </div>

      </>)}
      {nativeOwner&&maintenanceOpen&&<MaterialMaintenance workspace={workspaceId} rows={maintenanceRows} error={maintenance.error} loading={maintenanceRows.length<documents.length&&!maintenance.error} refresh={maintenance.refresh}
        close={()=>setMaintenanceOpen(false)} onReloaded={()=>setMaintenanceRevision(value=>value+1)} onReview={id=>{const document=documents.find(doc=>doc.id===id);if(document){setMaintenanceOpen(false);setOnlyAttention(false);openDocument(document);}}} />}
      {tasksOpen && <WorkbenchDrawer title="任务中心" close={() => setTasksOpen(false)} className="task-drawer"><section className="jobs">
        {jobsError && <p role="alert" className="notice error">{jobsError}</p>}
        {jobFeedback && <p role={jobFeedback.failed ? 'alert' : 'status'} className={`notice ${jobFeedback.failed ? 'error' : 'success'}`}>{jobFeedback.text}</p>}
        <div className="section-title">
          <h2>任务中心</h2>
          <span>{status?.job_history_retention_days ? `最近 ${status.job_history_retention_days} 天` : "按最近更新排序"} · 自动轮询</span>
          <button disabled={busy||sensitiveSaving} onClick={()=>{if(navigate('materials'))setTasksOpen(false);}}>返回材料核对</button>
        </div>
        {status?.job_history_retention_days && <p className="job-retention-notice">
          成功或取消的任务在最后更新 {status.job_history_retention_days} 天后移出列表。后台定期清理不再被业务使用的过期记录；排队、运行和失败任务继续保留。材料、知识网络及检索索引不会随任务历史清理而删除。
        </p>}
        <p className="job-retention-notice">{status?.job_auto_retry_enabled
          ? `抽取和敏感检测失败后可有限自动重试：网络异常最多 ${status.job_auto_retry_delays_seconds?.length ?? 3} 次，模型输出异常补偿 1 次。单个片段异常会跳过并继续；成功结果可复用。等待重试时可以取消。`
          : "自动重试未开启，失败任务可检查原因后手工重试。"}</p>
        {!jobs.length && <div className="empty">{jobsLoading ? "正在加载任务…" : jobTotal ? "当前页没有任务，请刷新或选择其他页。" : "暂无文档任务。"}</div>}
        {orderedJobs.map((job) => {
          const mergedScan = isMergedScan(job);
          const document = documents.find((item) => item.id === job.document_id);
          const hasDocument = !!document || !!(job.document_name && !job.document_deleted_at);
          const documentName = document?.original_name ?? job.document_name;
          const jobTitle = job.kind === "sensitive_scan"
            ? "脱敏扫描"
            : job.kind === "search_index"
              ? "检索索引"
              : job.kind === "knowledge_retract" && job.stage === "purged"
                ? "材料彻底清理"
              : documentName ? `${documentName}${job.document_deleted_at ? "（已删除）" : ""}` : job.document_id ? "已删除文档" : "后台任务";
          const jobHistory = <>
            <small className="job-times" title="按最近状态更新时间倒序；时间使用浏览器所在时区。开始时间为最近一次执行。">
              <span>更新 {jobTime(job.updated_at)}</span>
              <span>创建 {jobTime(job.created_at)}</span>
              <span>开始 {jobTime(job.metrics?.started_at)}</span>
              <span>结束 {jobTime(["succeeded", "failed", "cancelled"].includes(job.status) ? job.updated_at : undefined)}</span>
            </small>
            {job.error_message && <p className={mergedScan ? "job-info" : "job-error"}>{job.error_message}</p>}
            {autoRetryText(job) && <small className="job-info">{autoRetryText(job)}</small>}
            {job.kind === "knowledge_extract" && job.metrics?.extraction_batches_reused != null &&
              <small>复用已完成抽取 {job.metrics.extraction_batches_reused} 个片段{job.metrics.failed_batches ? ` · 失败 ${job.metrics.failed_batches} 个片段，其余已继续处理` : ""}</small>}
            {!!job.metrics?.extraction_failures?.length && <details><summary>抽取失败片段</summary>
              <ul>{job.metrics.extraction_failures.map(failure => <li key={failure.batch_index}>片段 {failure.batch_index + 1} · {failure.reason}</li>)}</ul>
            </details>}
            {job.knowledge_summary && ["succeeded", "failed", "cancelled"].includes(job.status) &&
              <KnowledgeOutcome summary={job.knowledge_summary} />}
            {job.metrics && (!mergedScan || job.attempt > 0) && <small>本轮执行 {processingSeconds(job.metrics, job.status)} 秒{job.metrics.total_processing_seconds != null ? ` · 已结束轮次累计 ${job.metrics.total_processing_seconds.toFixed(1)} 秒` : ""}{job.metrics.vectors_reused != null ? ` · 向量复用 ${job.metrics.vectors_reused} 块` : ""}</small>}
            {job.kind === "sensitive_scan" && job.metrics?.fields != null && <small>{scanCounts(job.metrics)}</small>}
              {job.kind === "search_index" && job.metrics?.index_chunks_reused != null && <small>
                分块复用 {job.metrics.index_chunks_reused} 块 · 新分块 {job.metrics.index_chunks_generated ?? 0} 块 · 新向量 {job.metrics.vectors_generated ?? 0} 块
                {` · 模型准备 ${(job.metrics.embedding_load_seconds ?? 0).toFixed(1)} 秒 · 分块准备 ${(job.metrics.index_chunking_seconds ?? 0).toFixed(1)} 秒 · 向量计算 ${(job.metrics.embedding_seconds ?? 0).toFixed(1)} 秒 · 索引写入 ${(job.metrics.index_persisting_seconds ?? 0).toFixed(1)} 秒`}
              </small>}
            {!mergedScan && job.metrics?.replacement_job_id && <small>已转至{job.kind === "search_index" ? "索引" : "扫描"}任务 {job.metrics.replacement_job_id.slice(0, 8)}</small>}
            {!job.error_message && job.kind === "sensitive_scan" && job.status === "cancelled" && !mergedScan && <p className="job-error">旧任务未记录取消原因；重试将使用当前索引和脱敏配置。</p>}
          </>;
          return (
            <div className={`job-row${mergedScan ? " job-row-merged" : ""}`} key={job.id}>
              <div>
                <strong>{jobTitle}</strong>
                <small>
                  {job.kind === "knowledge_retract" && (job.document_deleted_at || job.stage === "purged") ? "材料清理" : jobKindText[job.kind] ?? "后台任务"} · {mergedScan ? "已合并" : job.stage === 'suggestions_ready' ? jobStageText[job.stage] : knowledgeStage(job.kind, job.status, job.knowledge_summary) ?? jobStageText[job.stage] ?? job.stage} · {jobExecutionLabel(job, mergedScan)}
                  {!mergedScan && job.total_units !== null
                    ? ` · ${job.completed_units}/${job.total_units}${job.kind === "sensitive_scan" ? " 项" : ""}`
                    : ""}
                </small>
                {mergedScan ? <>
                  <MergedScanInfo replacementId={job.metrics!.replacement_job_id!} attempt={job.attempt} read={requestJson} />
                  <details className="merged-scan-history"><summary>查看旧任务记录</summary>{jobHistory}</details>
                </> : jobHistory}
              </div>
              <div className="job-actions">
                <span className={`badge ${mergedScan ? "merged" : job.status}`}>{mergedScan ? "已合并" : job.status === "failed" && job.metrics?.auto_retry?.state === "waiting" ? "等待自动重试" : job.status === "running" && job.cancel_requested ? "正在取消" : statusText[job.status] ?? job.status}</span>
                {(job.status === "queued" || job.status === "running" || job.status === "failed" && job.metrics?.auto_retry?.state === "waiting") &&
                  !(job.kind === "knowledge_retract" && job.document_deleted_at) && (
                  <button type="button" disabled={job.cancel_requested || !!busyJobActions[job.id]} onClick={() => void jobAction(job, "cancel")}>
                    {job.cancel_requested ? "取消中…" : job.status === "failed" ? "取消自动重试" : "取消"}
                  </button>
                )}
                {!mergedScan && (job.status === "failed" || job.status === "cancelled") &&
                  !job.metrics?.replacement_job_id && (hasDocument || job.kind === "knowledge_retract" || job.kind === "search_index" || job.kind === "sensitive_scan") && (
                  <button type="button" disabled={!!busyJobActions[job.id]} onClick={() => void jobAction(job, "retry")}>
                    {busyJobActions[job.id] ? "正在安排…" : "重试"}
                  </button>
                )}
              </div>
            </div>
          );
        })}
        <nav className="job-pagination" aria-label="任务分页" aria-busy={jobsLoading}>
          <div className="job-page-info">
            <label>每页 <select value={jobPageSize} disabled={jobsLoading} onChange={(event) => changeJobPage(1, Number(event.target.value))}>
              <option value={10}>10</option><option value={20}>20</option><option value={50}>50</option>
            </select> 条</label>
            <span>共 {jobTotal} 条{jobs.length > 0 ? ` · 当前第 ${(jobPage - 1) * jobPageSize + 1}–${(jobPage - 1) * jobPageSize + jobs.length} 条` : ""}</span>
          </div>
          <div className="job-page-controls">
            <button type="button" disabled={jobsLoading || jobPage <= 1} onClick={() => changeJobPage(1)}>首页</button>
            <button type="button" disabled={jobsLoading || jobPage <= 1} onClick={() => changeJobPage(jobPage - 1)}>上一页</button>
            <span>第 {jobPage} / {jobPageCount} 页</span>
            <button type="button" disabled={jobsLoading || jobPage >= jobPageCount} onClick={() => changeJobPage(jobPage + 1)}>下一页</button>
            <button type="button" disabled={jobsLoading || jobPage >= jobPageCount} onClick={() => changeJobPage(jobPageCount)}>末页</button>
          </div>
        </nav>
      </section></WorkbenchDrawer>}

      {view === "ontology" && <OntologyView key={materialPreview?.id ?? 'manual'} report={report} onLeaveStateChange={updateOntologyLeaveState} initialPreview={materialPreview} navigation={ontologyNavigation} onNavigationHandled={clearOntologyNavigation} onImport={documentId=>{const host=embeddedHost(); if(host){host.importMaterials(window,documentId);return;} if(navigate('materials'))setUploadOpen(true);}} />}
      {view === "review" && <ReviewView documents={documents} report={report} />}
      {view === "graph" && <GraphView />}
      {view === "search" && <SearchView key={searchDocumentId} initialDocumentId={searchDocumentId} documents={documents} report={report} onOpenSource={openIndexSource} />}
      {view === "sensitive" && <SensitiveView report={report} onSavingChange={setSensitiveSaving} />}

      {status && (
        <footer>
          自动知识流水线 {status.knowledge_auto_pipeline_ready ? "已就绪" : "未就绪"} · LLM {status.llm_configured ? "已配置" : "未配置"} · Embedding {status.embedding_configured ? "已配置" : "未配置"} · Neo4j {status.neo4j_configured ? "已配置" : "未配置"}
        </footer>
      )}
      </div></div>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <WorkbenchErrorBoundary><App /></WorkbenchErrorBoundary>
  </StrictMode>,
);
