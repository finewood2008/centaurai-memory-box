type DocumentPage<T> = { items: T[]; total: number };

// Replace the library only after all pages succeed; the API defaults to 100.
export async function readDocumentLibrary<T extends { id: string }>(
  workspace: string,
  read: (url: string) => Promise<DocumentPage<T>>,
): Promise<T[]> {
  const items = new Map<string, T>();
  let offset = 0;
  while (true) {
    const page = await read(`/api/documents?${new URLSearchParams({workspace_id: workspace, limit: '500', offset: String(offset)})}`);
    for (const item of page.items) items.set(item.id, item);
    offset += page.items.length;
    if (offset >= page.total || page.items.length === 0 || !Number.isFinite(page.total)) break;
  }
  return [...items.values()];
}
