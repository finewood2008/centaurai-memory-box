import { embeddedHost } from './nativeHost.ts';
export class RequestError extends Error {
  code: string;
  status: number;
  constructor(message: string, code = '', status = 0) {
    super(message); this.code = code; this.status = status;
  }
}
function failure(reason: unknown): RequestError {
  // Host errors cross both an IPC boundary and a parent-window realm.
  const error = reason as { message?: string; publicMessage?: string; code?: string; status?: number } | null;
  const code = typeof error?.code === 'string' && /^[A-Z][A-Z_]{1,95}$/.test(error.code) ? error.code : '';
  const uncertain = !code || code === 'SEMANTICA_CONNECTION_FAILED' || code === 'SEMANTICA_SERVICE_TIMEOUT';
  const status = !uncertain && typeof error?.status === 'number' && Number.isInteger(error.status)
    && error.status >= 400 && error.status <= 599 ? error.status : 0;
  return new RequestError(error?.publicMessage || error?.message || '请求未完成，请稍后重试', code, status);
}
const aborted = () => new DOMException('Aborted', 'AbortError');
async function hostResult<T>(request: () => Promise<T>, signal?: AbortSignal | null): Promise<T> {
  if (signal?.aborted) throw aborted();
  const pending = request();
  if (!signal) return pending;
  return new Promise<T>((resolve, reject) => {
    const cancel = () => { signal.removeEventListener('abort', cancel); reject(aborted()); };
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
    // Cancellation discards the reply; it never retries an uncertain write.
    pending.then(value => {
      signal.removeEventListener('abort', cancel);
      if (signal.aborted) reject(aborted()); else resolve(value);
    }, reason => {
      signal.removeEventListener('abort', cancel);
      reject(signal.aborted ? aborted() : reason);
    });
  });
}
export async function requestJson<T>(url: string, options?: RequestInit, timeoutMs?: number): Promise<T> {
  if (options?.signal?.aborted) throw aborted();
  const embedded = embeddedHost();
  const native = typeof window === "undefined" ? undefined : (window as unknown as {semantica?:{call:(action:string,input:unknown)=>Promise<unknown>}}).semantica;
  const headers = new Headers(options?.headers);
  const session = headers.get('x-correction-session');
  const editor = session ? {session, generation: headers.get('x-correction-generation') || '0'} : undefined;
  const input = {url, method: options?.method || 'GET', body: options?.body, ...(editor ? {editor} : {})};
  const host = embedded ? () => embedded.request<T>(window, input)
    : native && new URLSearchParams(location.search).get('native') === '1'
      ? async () => {
        const reply = await native.call('workbench-request', input) as {ok?: boolean; value?: T; code?: string} | null;
        if (reply?.ok === true) return reply.value as T;
        if (reply?.ok === false && typeof reply.code === 'string' && /^[A-Z][A-Z_]{1,95}$/.test(reply.code)) throw failure(reply);
        throw new RequestError('知识工作台响应无效', 'SEMANTICA_INVALID_RESPONSE');
      } : null;
  if (host) {
    try {
      return await hostResult(host, options?.signal);
    } catch (reason) {
      if (options?.signal?.aborted || (reason as {name?: string} | null)?.name === 'AbortError') throw aborted();
      throw failure(reason);
    }
  }
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort();
  options?.signal?.addEventListener("abort", abort, { once: true });
  if (options?.signal?.aborted) controller.abort();
  const timer = timeoutMs === undefined ? undefined : setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      if (controller.signal.aborted) throw aborted();
      const detail = body?.detail;
      const message = typeof detail === 'string' ? detail
        : typeof detail?.message === 'string' ? detail.message
        : typeof body?.message === 'string' ? body.message
        : Array.isArray(detail) ? '提交内容不符合要求，请检查填写的字段后重试'
        : `HTTP ${response.status}`;
      const code = typeof body?.code === 'string' ? body.code : typeof detail?.code === 'string' ? detail.code : '';
      throw new RequestError(message, code, response.status);
    }
    const value = await response.json() as T;
    if (controller.signal.aborted) throw aborted();
    return value;
  } catch (error) {
    if (timedOut) throw new Error("加载超时，请稍后重试");
    throw error;
  } finally {
    clearTimeout(timer);
    options?.signal?.removeEventListener("abort", abort);
  }
}
