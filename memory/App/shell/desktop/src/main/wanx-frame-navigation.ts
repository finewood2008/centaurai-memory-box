// The foundation hosts only packaged Starlink documents and existing blob previews.
export function allowsWanxFrameNavigation(documentURL: string, target: string, isMainFrame: boolean): boolean {
  if (isMainFrame) return false;
  if (target.startsWith('blob:file:')) return true;
  try {
    const url = new URL(target);
    url.search = ''; url.hash = '';
    return ['../starlink/ui/index.html', '../starlink/ui/workbench/index.html']
      .some(relative => url.href === new URL(relative, documentURL).href);
  } catch { return false; }
}
