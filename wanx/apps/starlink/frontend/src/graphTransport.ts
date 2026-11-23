import {edgeId, type GraphNode, type GraphEdge, type GraphEvidence, type GraphDetection} from './graph.ts';

export type GraphResult = {nodes: GraphNode[]; edges: GraphEdge[]; detection?: GraphDetection};
export type GraphSources = {items: GraphEvidence[]; total: number; next_offset: number | null; detection?: GraphDetection; edge?: GraphEdge};
type Read = <T>(url: string, options?: RequestInit, timeoutMs?: number) => Promise<T>;

export function graphUrl(workspace: string, owner: boolean, entityId?: string, limit=120, full=false): string {
  const query = new URLSearchParams({workspace_id: workspace, limit: String(limit)});
  if(entityId)query.set('entity_id',entityId);
  // Bridge's authenticated owner route returns complete properties/evidence.
  // summary and the dedicated relation-sources route are standalone API only.
  if(!owner)query.set('summary',full?'false':'true');
  return `/api/${owner?'owner/graph':'graph/neighborhood'}?${query}`;
}

export async function readGraphSources(read: Read, workspace: string, owner: boolean, edge: GraphEdge, offset: number, signal: AbortSignal): Promise<GraphSources> {
  if(!owner)return read<GraphSources>(`/api/graph/relations/${encodeURIComponent(edgeId(edge))}/sources?workspace_id=${encodeURIComponent(workspace)}&offset=${offset}`,{signal},20000);
  // Revalidate the relationship and permission on selection/refresh; don't show
  // cached source text after a document was deleted in another view.
  const graph=await read<GraphResult>(graphUrl(workspace,true,edge.subject_entity_id,500),{signal},20000);
  const current=graph.edges.find(item=>edgeId(item)===edgeId(edge));
  if(!current)throw new Error('关系或来源已变化，请刷新知识图谱');
  return {items:current.evidence,total:current.evidence.length,next_offset:null,detection:graph.detection,edge:current};
}
