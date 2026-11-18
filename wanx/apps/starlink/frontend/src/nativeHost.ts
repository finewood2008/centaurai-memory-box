export type OntologyCategory = 'published' | 'drafts';
export type OntologyAction = OntologyCategory | 'suggestions';
export type OntologySection = OntologyCategory | 'add-entity' | 'add-relation';
type Controls = {
  view: string;
  navigate: (view: string, ontologyAction?: OntologyAction) => boolean;
  canLeave: () => boolean;
  openMaterial?: (documentId: string, reviewTarget?: 'current-extraction') => boolean;
  refreshGraph?: () => void;
  clearOntologyAction?: () => void;
};
export type EmbeddedWorkbenchHost = {
  request<T>(source: Window, input: { url: string; method: string; body?: BodyInit | null; editor?: {session: string; generation: string} }): Promise<T>;
  register(source: Window, controls: Controls): void;
  viewChanged(source: Window, view: string): void;
  ontologySectionChanged(source: Window, section: OntologySection, category: OntologyCategory): void;
  importMaterials(source: Window, documentId?: string): void;
  openSource(source: Window, documentId: string, versionId: string, segmentId?: string): void;
};
export function embeddedHost(): EmbeddedWorkbenchHost | undefined {
  if (typeof window === "undefined" || window.parent === window || new URLSearchParams(location.search).get("embedded") !== "1") return;
  return (window.parent as unknown as { starlinkWorkbench?: EmbeddedWorkbenchHost }).starlinkWorkbench;
}
export function bridgeHosted(): boolean {
  return !!embeddedHost() || typeof window !== 'undefined' &&
    new URLSearchParams(location.search).get('native') === '1' &&
    typeof (window as unknown as {semantica?: {call?: unknown}}).semantica?.call === 'function';
}
