import { useEffect, useRef } from "react";
import { edgeId, entityLabel, entityNames, excerptParts, mentionsEntity, nodeId, relationLabel, graphProperties,
  type GraphEdge, type GraphEvidence, type GraphNode } from "../graph";
import {bridgeHosted} from '../nativeHost';

function Properties({json,label}: {json?:string;label:string}) {
  const entries=graphProperties(json);
  return <section className="graph-properties" aria-label={label}><h3>{label}</h3>{entries.length?<dl>{entries.map(([key,value])=><div key={key}><dt>{key}</dt><dd>{value}</dd></div>)}</dl>:<p className="muted">暂无属性信息</p>}</section>;
}

type Props = {
  nodes: GraphNode[];
  edges: GraphEdge[];
  selectedNode: GraphNode | null;
  selectedEdge: GraphEdge | null;
  typeLabels: Record<string, string>;
  relationLabels: Record<string, string>;
  onSelectEdge: (id: string) => void;
  sourceLabel: (locator: Record<string, unknown>) => string;
  sourceLoading?: boolean;
  sourceError?: string | null;
  sourceNotice?: string | null;
  onReloadSources?: () => void;
  onMoreSources?: () => void;
};

function FactLabel({ edge, nodes, relationLabels }: {
  edge: GraphEdge;
  nodes: Map<string, GraphNode>;
  relationLabels: Record<string, string>;
}) {
  return (
    <span className="graph-fact-label">
      <strong>{nodes.get(edge.subject_entity_id)?.canonical_name ?? "未知实体"}</strong>
      <span className="graph-relation" title={edge.relation_type}>
        <span aria-hidden="true">→ </span>{relationLabel(edge.relation_type, relationLabels)}<span aria-hidden="true"> →</span>
      </span>
      <strong>{nodes.get(edge.object_entity_id)?.canonical_name ?? "未知实体"}</strong>
    </span>
  );
}

function SourceItem({ source, names, sourceLabel }: {
  source: GraphEvidence;
  names: string[];
  sourceLabel: Props["sourceLabel"];
}) {
  let locator: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(source.locator_json);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) locator = parsed as Record<string, unknown>;
  } catch { /* Keep the excerpt usable when a historical locator cannot be parsed. */ }
  return (
    <article className="evidence-item">
      <strong>{sourceLabel(locator)}</strong>
      <p>{excerptParts(source.excerpt, names).map((part, index) => part.matched
        ? <mark key={index}>{part.text}</mark>
        : part.text)}</p>
      <div className="graph-source-meta">
        <small>文档 {source.document_id.slice(0, 8)} · 片段 {source.segment_id.slice(0, 8)}</small>
        {!bridgeHosted()&&<a href={`/api/documents/${encodeURIComponent(source.document_id)}/original`} target="_blank" rel="noreferrer">
          查看原件
        </a>}
      </div>
    </article>
  );
}

export default function GraphDetails({ nodes, edges, selectedNode, selectedEdge, typeLabels,
  relationLabels, onSelectEdge, sourceLabel, sourceLoading, sourceError, sourceNotice,
  onReloadSources, onMoreSources }: Props) {
  const listRef = useRef<HTMLDivElement>(null);
  const selectedFactId = selectedEdge ? edgeId(selectedEdge) : null;
  const selectedEntityId = selectedNode ? nodeId(selectedNode) : null;
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const selected = list.querySelector('[aria-pressed="true"]');
    if (!selected) { list.scrollTop = 0; return; }
    const listRect = list.getBoundingClientRect();
    const itemRect = selected.getBoundingClientRect();
    if (itemRect.top < listRect.top) list.scrollTop -= listRect.top - itemRect.top;
    else if (itemRect.bottom > listRect.bottom) list.scrollTop += itemRect.bottom - listRect.bottom;
  }, [selectedFactId, selectedEntityId]);
  const nodeMap = new Map(nodes.map((node) => [nodeId(node), node]));
  const subject = selectedEdge ? nodeMap.get(selectedEdge.subject_entity_id) : undefined;
  const object = selectedEdge ? nodeMap.get(selectedEdge.object_entity_id) : undefined;
  const names = [...entityNames(subject), ...entityNames(object)];
  const sameSegment = selectedEdge?.evidence.filter((source) =>
    mentionsEntity(source.excerpt, subject) && mentionsEntity(source.excerpt, object)) ?? [];
  const context = selectedEdge?.evidence.filter((source) =>
    !mentionsEntity(source.excerpt, subject) || !mentionsEntity(source.excerpt, object)) ?? [];

  return (
    <aside className="knowledge-card graph-details">
      <div className="section-title">
        <h2>相关事实</h2>
        <span>{edges.length} 条关系</span>
      </div>
      <div className="graph-selection" aria-live="polite">
        {selectedNode ? <>
          <strong>{selectedNode.canonical_name}</strong>
          <span className="badge" title={selectedNode.entity_type}>{entityLabel(selectedNode.entity_type, typeLabels)}</span>
          <Properties json={selectedNode.properties_json} label="实体属性" />
          <p>{edges.length ? "下面列出当前图中与该实体相连的关系。选择一条查看来源。" : "该实体已发布，当前图中暂无相连关系；可以在知识核对中核对或补充关系。"}</p>
        </> : <p>点击图中节点查看相关事实，也可直接选择下面的关系。</p>}
      </div>
      <div ref={listRef} className="graph-fact-list" role="group" aria-label={selectedNode ? `${selectedNode.canonical_name}的相关事实` : "当前图中的事实"}>
        {!edges.length && <div className="empty">当前没有可查看的关系。</div>}
        {edges.map((edge) => <button
          key={edgeId(edge)}
          type="button"
          className={`graph-fact${selectedEdge && edgeId(selectedEdge) === edgeId(edge) ? " selected" : ""}`}
          aria-pressed={!!selectedEdge && edgeId(selectedEdge) === edgeId(edge)}
          onClick={() => onSelectEdge(edgeId(edge))}
        >
          <FactLabel edge={edge} nodes={nodeMap} relationLabels={relationLabels} />
          <small>{edge.evidence_count ?? edge.evidence.length} 个来源片段</small>
        </button>)}
      </div>
      <section className="graph-sources" aria-label="关系来源">
        <div className="section-title">
          <h2>关系来源</h2>
          <span>{selectedEdge?.evidence_count ?? selectedEdge?.evidence.length ?? 0} 个片段</span>
        </div>
        {!selectedEdge ? <div className="empty">选择一条关系后，显示它对应的来源片段。</div> : <div key={edgeId(selectedEdge)}>
          <div className="graph-selected-fact" aria-live="polite">
            <FactLabel edge={selectedEdge} nodes={nodeMap} relationLabels={relationLabels} />
            <Properties json={selectedEdge.properties_json} label="关系属性" />
            <p>来源片段用于核对本条关系，片段数不代表独立验证次数。</p>
            {onReloadSources && <button type="button" onClick={onReloadSources} disabled={sourceLoading}>刷新来源</button>}
          </div>
          {sourceLoading && <p className="graph-source-note" role="status">正在加载关系来源…</p>}
          {sourceError && <p className="graph-load-error" role="alert">{sourceError}。请点击刷新来源重试。</p>}
          {sourceNotice && <p className="graph-source-note" role="status">{sourceNotice}</p>}
          {!!sameSegment.length && <div className="graph-source-heading">同段提及两端实体 · {sameSegment.length} 个片段</div>}
          {sameSegment.map((source) => <SourceItem key={source.id} source={source} names={names} sourceLabel={sourceLabel} />)}
          {!sameSegment.length && !!context.length && <p className="graph-source-note">当前摘录未同时提及两端实体，请展开关联上下文核对。</p>}
          {!!context.length && <details className="graph-context">
            <summary>关联上下文 · {context.length} 个片段</summary>
            <p className="graph-source-note">这些摘录提供背景或使用其他表述，不能单独证明本条关系。</p>
            {context.map((source) => <SourceItem key={source.id} source={source} names={names} sourceLabel={sourceLabel} />)}
          </details>}
          {!selectedEdge.evidence.length && !sourceLoading && !sourceError && !sourceNotice && <div className="empty">这条关系暂无可查看的来源。</div>}
          {onMoreSources && <button type="button" onClick={onMoreSources} disabled={sourceLoading}>加载更多来源</button>}
        </div>}
      </section>
    </aside>
  );
}
