export type GraphNode = {
  entity_id?: string;
  id?: string;
  canonical_name: string;
  entity_type: string;
  disambiguation_key?: string;
  aliases_json?: string;
  aliases?: string[];
  properties_json?: string;
};

export type GraphEvidence = {
  id: string;
  document_id: string;
  segment_id: string;
  locator_json: string;
  excerpt: string;
};

export type GraphEdge = {
  fact_id?: string;
  id?: string;
  subject_entity_id: string;
  object_entity_id: string;
  relation_type: string;
  evidence: GraphEvidence[];
  evidence_count?: number;
  properties_json?: string;
};

export function graphProperties(json?: string): [string, string][] {
  try {
    const value: unknown = JSON.parse(json || '{}');
    if(!value || typeof value!=='object' || Array.isArray(value))return [];
    return Object.entries(value).map(([key,item])=>[key,item==null?'未提供':typeof item==='object'?JSON.stringify(item):String(item)]);
  } catch { return []; }
}

export type GraphDetection = { status: string; pending_texts: number };

export function detectionNotice(detection?: GraphDetection): string | null {
  if (!detection || ["completed", "not_required"].includes(detection.status)) return null;
  const descriptions: Record<string, string> = {
    running: "敏感检测进行中", queued: "等待敏感检测", pending: "敏感检测尚未完成",
    failed: "敏感检测失败，请到任务中心查看或重试", cancelled: "敏感检测已取消，可到任务中心重试",
    changed: "材料或检测配置已变化，请刷新知识网络",
  };
  return `${descriptions[detection.status] ?? "敏感检测尚未完成"}。未完成检测的内容暂以受保护占位显示，检测后请刷新。`;
}

const ENTITY_LABELS: Record<string, string> = {
  PERSON: "人物", ORG: "组织", GPE: "地点", EVENT: "事件", CONCEPT: "概念",
  DOCUMENT: "材料", PRODUCT: "产品", FEATURE: "功能", TECHNOLOGY: "技术", DATE: "日期",
};

const RELATION_LABELS: Record<string, string> = {
  PART_OF: "属于", HAS_FEATURE: "具有功能", USES: "使用", OCCURRED_AT: "发生于",
  WORKS_AT: "任职于", LOCATED_IN: "位于", BORN_IN: "出生于",
  RELATED_TO: "相关", MENTIONS: "提及",
};

export function entityLabel(type: string, labels: Record<string, string> = {}): string {
  const key = type.toUpperCase();
  return labels[key]?.trim() || ENTITY_LABELS[key] || type;
}

export function relationLabel(type: string, labels: Record<string, string> = {}): string {
  const key = type.toUpperCase();
  return labels[key]?.trim() || RELATION_LABELS[key] || type;
}

export function nodeId(node: GraphNode): string {
  return String(node.entity_id ?? node.id ?? "");
}

// Isolation is measured against valid relationships in the loaded graph, before display filters.
export function withoutIsolatedNodes(nodes:GraphNode[],edges:GraphEdge[]):GraphNode[] {
  const ids=new Set(nodes.map(nodeId));
  const connected=new Set(edges.filter(edge=>ids.has(edge.subject_entity_id)&&ids.has(edge.object_entity_id))
    .flatMap(edge=>[edge.subject_entity_id,edge.object_entity_id]));
  return nodes.filter(node=>connected.has(nodeId(node)));
}

export function edgeId(edge: GraphEdge): string {
  return String(edge.fact_id ?? edge.id ?? "");
}

export function entityNames(node: GraphNode | undefined): string[] {
  if (!node) return [];
  let aliases: unknown = node.aliases ?? [];
  if (node.aliases_json) {
    try { aliases = JSON.parse(node.aliases_json); } catch { aliases = []; }
  }
  return Array.from(new Set([
    node.canonical_name,
    ...(Array.isArray(aliases) ? aliases.filter((value): value is string => typeof value === "string") : []),
  ].map((name) => name.trim()).filter(Boolean)));
}

function normalizeName(text: string): string {
  return text.replace(/\s+/gu, "").toLowerCase();
}

// This is a display aid based on the delivered excerpt, not an entailment check.
export function mentionsEntity(text: string, node: GraphNode | undefined): boolean {
  const normalized = normalizeName(text);
  return entityNames(node).some((name) => normalized.includes(normalizeName(name)));
}

export function excerptParts(text: string, names: string[]): Array<{ text: string; matched: boolean }> {
  const patterns = Array.from(new Set(names.map(normalizeName).filter(Boolean)))
    .sort((left, right) => right.length - left.length)
    .map((name) => Array.from(name).map((character) => character.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s*"));
  if (!patterns.length) return [{ text, matched: false }];
  const parts: Array<{ text: string; matched: boolean }> = [];
  let cursor = 0;
  for (const match of text.matchAll(new RegExp(patterns.join("|"), "giu"))) {
    const start = match.index!;
    if (start > cursor) parts.push({ text: text.slice(cursor, start), matched: false });
    parts.push({ text: match[0], matched: true });
    cursor = start + match[0].length;
  }
  if (cursor < text.length) parts.push({ text: text.slice(cursor), matched: false });
  return parts;
}
