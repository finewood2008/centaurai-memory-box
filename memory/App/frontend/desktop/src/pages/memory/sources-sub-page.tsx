import { MemorySourcesContent } from "../memory-sources-page.js";

export function SourcesSubPage({ onOpenSettings }: { onOpenSettings?: () => void }) {
  return <MemorySourcesContent embedded surface={onOpenSettings ? "workspace" : undefined} onOpenSettings={onOpenSettings} />;
}
