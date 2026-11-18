// ZIP library management; credentials stay in page memory only.
export const states = { draft: "草稿", published: "已发布", disabled: "已停用" } as const;
export type Summary = { workspace_id: string; id: string; kind: string; title: string; description: string;
  state: keyof typeof states; skill_revision: number; draft_revision: number; default_version: string | null };
export type Page<T> = { items: T[]; offset: number; limit: number; total: number };
export type Issue = { code: string; message: string; path: (string | number)[]; severity: string };
export class SkillError extends Error {
  code: string; issues: Issue[]; currentRevision?: number;
  constructor(message: string, code = "", issues: Issue[] = [], currentRevision?: number) {
    super(message); this.code = code; this.issues = issues; this.currentRevision = currentRevision;
  }
}
export function skillUrl(workspace: string, id = "", suffix = "", query: Record<string, string | number | boolean> = {}) {
  const params = new URLSearchParams({ workspace_id: workspace });
  for (const [key, value] of Object.entries(query)) if (value !== "") params.set(key, String(value));
  return `/api/skills${id ? `/${encodeURIComponent(id)}` : ""}${suffix}?${params}`;
}
export async function skillRequest<T>(token: string, url: string, signal: AbortSignal, options: RequestInit = {}, blob = false): Promise<T> {
  // Never send this management credential to arbitrary origins, redirects or other APIs.
  if (!/^\/api\/skills(?:[/?]|$)/.test(url) || url.includes("\\") || /(?:^|\/)\.\.(?:\/|\?|$)/.test(url))
    throw new SkillError("管理请求地址无效。");
  const normalized = new URL(url, "http://management.invalid");
  if (!/^\/api\/skills(?:\/|$)/.test(normalized.pathname)) throw new SkillError("管理请求地址无效。");
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; abort(); }, 30000);
  try {
    const headers = new Headers(options.headers);
    if (token) headers.set("X-Skill-Admin-Token", token);
    else headers.delete("X-Skill-Admin-Token");
    if (typeof options.body === "string") headers.set("Content-Type", "application/json");
    const response = await fetch(url, { ...options, headers, redirect: "error", cache: "no-store", signal: controller.signal });
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      const detail = body?.detail;
      throw new SkillError(typeof detail?.message === "string" ? detail.message : `管理请求失败（HTTP ${response.status}）。`,
        detail?.code ?? "", Array.isArray(detail?.issues) ? detail.issues : [], detail?.current_revision);
    }
    const value = blob ? await response.blob() : await response.json();
    controller.signal.throwIfAborted();
    return value as T;
  } catch (error) {
    if (timedOut) throw new SkillError("请求超时。写入操作可能已经完成，请重新读取后确认，勿连续提交。");
    if (signal.aborted || error instanceof SkillError) throw error;
    throw new SkillError("无法完成管理请求，请检查连接。写入结果不确定时请先重新读取。");
  } finally { clearTimeout(timer); signal.removeEventListener("abort", abort); }
}
export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url; link.download = filename; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
