import { useCallback, useEffect, useMemo, useState } from "react";
import { SigmaContainer, useLoadGraph, useRegisterEvents, useSetSettings, useSigma } from "@react-sigma/core";
import { MultiGraph } from "graphology";
import forceAtlas2 from "graphology-layout-forceatlas2";
import { entityLabel } from "../graph";
import "@react-sigma/core/lib/style.css";
import "../sigma-graph.css";

export type GraphNodeData = {
  id: string;
  label: string;
  entityType: string;
  disambiguationKey: string;
  size?: number;
};

export type GraphEdgeData = {
  id: string;
  source: string;
  target: string;
  label: string;
  evidence: Array<{
    id: string;
    document_id: string;
    segment_id: string;
    locator_json: string;
    excerpt: string;
  }>;
};

const TYPE_COLORS: Record<string, string> = {
  PERSON: "#c0392b",
  ORG: "#2980b9",
  GPE: "#27ae60",
  CONCEPT: "#8e44ad",
  FEATURE: "#e67e22",
  TECHNOLOGY: "#16a085",
  DOCUMENT: "#7f8c8d",
  PRODUCT: "#d35400",
  EVENT: "#6e9382",
  DATE: "#6e9382",
};

function getNodeColor(type: string): string {
  return TYPE_COLORS[type.toUpperCase()] ?? "#6e9382";
}

function GraphDataLoader({ nodes, edges }: { nodes: GraphNodeData[]; edges: GraphEdgeData[] }) {
  const loadGraph = useLoadGraph();

  useEffect(() => {
    const graph = new MultiGraph();
    const nodeCount = Math.max(nodes.length, 1);
    const initialRadius = Math.max(10, Math.sqrt(nodeCount) * 8);

    // 计算度数用于节点大小
    const degree: Record<string, number> = {};
    for (const edge of edges) {
      degree[edge.source] = (degree[edge.source] ?? 0) + 1;
      degree[edge.target] = (degree[edge.target] ?? 0) + 1;
    }
    const maxDeg = Math.max(1, ...Object.values(degree));

    for (const [index, node] of nodes.entries()) {
      const d = degree[node.id] ?? 0;
      const baseSize = 8 + (d / maxDeg) * 14;
      // ForceAtlas2 reads the existing coordinates as its starting point. Missing
      // x/y values become NaN in its Float32 matrix and Sigma then has nothing it
      // can draw. A deterministic circle also keeps the first frame stable while
      // the force-directed layout is calculated.
      const angle = (index / nodeCount) * Math.PI * 2;
      graph.addNode(node.id, {
        label: node.label,
        size: node.size ?? baseSize,
        color: getNodeColor(node.entityType),
        entityType: node.entityType,
        disambiguationKey: node.disambiguationKey,
        originalSize: node.size ?? baseSize,
        x: Math.cos(angle) * initialRadius,
        y: Math.sin(angle) * initialRadius,
      });
    }

    for (const edge of edges) {
      if (!graph.hasNode(edge.source) || !graph.hasNode(edge.target)) continue;
      graph.addEdgeWithKey(edge.id, edge.source, edge.target, {
        label: edge.label,
        size: 1.5,
        color: "#b5c9bd",
        evidence: edge.evidence,
      });
    }

    // 力导向布局
    const settings = forceAtlas2.inferSettings(graph);
    forceAtlas2.assign(graph, {
      settings: {
        ...settings,
        gravity: 0.8,
        scalingRatio: 180,
        slowDown: 15,
      },
      iterations: 400,
    });

    loadGraph(graph);
  }, [nodes, edges, loadGraph]);

  return null;
}

function GraphInteraction({
  onNodeClick,
  onEdgeClick,
  selectedNodeId,
  selectedEdgeId,
}: {
  onNodeClick?: (nodeId: string) => void;
  onEdgeClick?: (edgeId: string) => void;
  selectedNodeId: string | null;
  selectedEdgeId: string | null;
}) {
  const sigma = useSigma();
  const registerEvents = useRegisterEvents();
  const setSettings = useSetSettings();
  const [hoveredNode, setHoveredNode] = useState<string | null>(null);
  const [hoveredEdge, setHoveredEdge] = useState<string | null>(null);

  // 节点和边的渲染设置
  useEffect(() => {
    setSettings({
      nodeReducer: (node, data) => {
        const graph = sigma.getGraph();
        const isSelected = selectedNodeId === node;
        const isHovered = hoveredNode === node;
        const hasSelectedEdge = !!selectedEdgeId && graph.hasEdge(selectedEdgeId);
        const isEndpoint = hasSelectedEdge && (
          graph.source(selectedEdgeId!) === node || graph.target(selectedEdgeId!) === node);

        if (hasSelectedEdge && !isEndpoint) {
          return { ...data, color: "#d8dfdb", label: "", forceLabel: false, size: (data.originalSize as number) * 0.7 };
        }
        const highlighted = isEndpoint || isSelected || isHovered;

        // 如果有选中/hover的节点，相邻节点和边保持亮度，其他降暗
        if (!hasSelectedEdge && (selectedNodeId || hoveredNode)) {
          const focus = selectedNodeId ?? hoveredNode;
          if (focus && node !== focus && !graph.hasEdge(focus, node) && !graph.hasEdge(node, focus)) {
            return { ...data, color: "#d8dfdb", label: "", forceLabel: false, size: (data.originalSize as number) * 0.7 };
          }
        }

        if (highlighted) {
          return { ...data, size: (data.originalSize as number) * 1.3, color: data.color, forceLabel: true, zIndex: 1 };
        }
        return { ...data, size: data.originalSize as number, forceLabel: false, zIndex: 0 };
      },
      edgeReducer: (edge, data) => {
        const graph = sigma.getGraph();
        const src = graph.source(edge);
        const tgt = graph.target(edge);
        const isEdgeSelected = selectedEdgeId === edge;
        const isEdgeHovered = hoveredEdge === edge;
        const focus = selectedNodeId ?? hoveredNode;

        if (isEdgeSelected || (!selectedEdgeId && isEdgeHovered)) {
          return { ...data, color: "#356c55", size: 3, forceLabel: true, zIndex: 1 };
        }
        if (selectedEdgeId) {
          return { ...data, color: "#eef2f0", size: 0.8, label: "", forceLabel: false, zIndex: 0 };
        }
        if (focus && src !== focus && tgt !== focus) {
          return { ...data, color: "#eef2f0", size: 0.8, label: "", forceLabel: false, zIndex: 0 };
        }
        return { ...data, label: "", forceLabel: false, zIndex: 0 };
      },
    });
  }, [sigma, setSettings, selectedNodeId, hoveredNode, selectedEdgeId, hoveredEdge]);

  useEffect(() => {
    registerEvents({
      clickNode: ({ node }) => {
        onNodeClick?.(node);
      },
      clickEdge: ({ edge }) => {
        onEdgeClick?.(edge);
      },
      enterNode: ({ node }) => setHoveredNode(node),
      leaveNode: () => setHoveredNode(null),
      enterEdge: ({ edge }) => setHoveredEdge(edge),
      leaveEdge: () => setHoveredEdge(null),
    });
  }, [registerEvents, onNodeClick, onEdgeClick]);

  return null;
}

export default function SigmaGraph({
  nodes,
  edges,
  typeLabels = {},
  onNodeClick,
  onEdgeClick,
  selectedNodeId,
  selectedEdgeId,
}: {
  nodes: GraphNodeData[];
  edges: GraphEdgeData[];
  typeLabels?: Record<string, string>;
  onNodeClick?: (nodeId: string) => void;
  onEdgeClick?: (edgeId: string) => void;
  selectedNodeId?: string | null;
  selectedEdgeId?: string | null;
}) {
  const [key, setKey] = useState(0);

  // 数据变化时重建 graph（保证力导向重新布局）
  const dataKey = useMemo(() => {
    return nodes.length + edges.length;
  }, [nodes, edges]);

  useEffect(() => {
    setKey((k) => k + 1);
  }, [dataKey]);

  const handleNodeClick = useCallback(
    (id: string) => {
      onNodeClick?.(id);
    },
    [onNodeClick],
  );

  const handleEdgeClick = useCallback(
    (id: string) => {
      onEdgeClick?.(id);
    },
    [onEdgeClick],
  );

  if (!nodes.length) {
    return (
      <div className="sigma-graph-empty">
        <div className="empty">当前没有可显示的已发布实体。请在材料详情或任务中心查看处理进度与未入图原因。</div>
      </div>
    );
  }

  return (
    <div className="sigma-graph-wrapper">
      <SigmaContainer
        key={key}
        graph={MultiGraph}
        style={{ height: "100%", width: "100%" }}
        settings={{
          allowInvalidContainer: true,
          labelDensity: 0.06,
          labelRenderedSizeThreshold: 10,
          labelColor: { color: "#2d3f35" },
          edgeLabelSize: 10,
          minEdgeThickness: 3,
          defaultEdgeType: "arrow",
          enableEdgeEvents: true,
          renderEdgeLabels: true,
          zIndex: true,
          zoomDuration: 200,
        }}
      >
        <GraphDataLoader nodes={nodes} edges={edges} />
        <GraphInteraction
          onNodeClick={handleNodeClick}
          onEdgeClick={handleEdgeClick}
          selectedNodeId={selectedNodeId ?? null}
          selectedEdgeId={selectedEdgeId ?? null}
        />
      </SigmaContainer>
      <div className="sigma-graph-legend">
        {Array.from(new Set(nodes.map((n) => n.entityType))).map((type) => (
          <span key={type} className="legend-item" title={type}>
            <span className="legend-dot" style={{ background: getNodeColor(type) }} />
            {entityLabel(type, typeLabels)}
          </span>
        ))}
      </div>
      <div className="sigma-graph-hint">点击节点查看相关事实 · 选择关系查看来源 · 箭头表示关系方向</div>
    </div>
  );
}
