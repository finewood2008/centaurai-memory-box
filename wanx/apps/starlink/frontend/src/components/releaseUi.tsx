import { useEffect, useState } from 'react';
import { requestJson } from '../request';

export const origin: Record<string, string> = { observed_baseline: '当前基线', automatic: '自动抽取发布', manual_correction: '人工纠错发布' };
export function endpoint(workspace: string, path = '', values: Record<string, string | number> = {}) {
  return `/api/knowledge-releases${path}?${new URLSearchParams({ workspace_id: workspace, ...Object.fromEntries(Object.entries(values).map(([k,v]) => [k,String(v)])) })}`;
}
export function useRead<T>(url: string | null) {
  const [state, setState] = useState<{ url: string | null; value: T | null; error: string }>({ url: null, value: null, error: '' });
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController(); setState({ url, value: null, error: '' });
    if (url) void requestJson<T>(url, { signal: controller.signal, cache: 'no-store', redirect: 'error' }, 20000)
      .then(result => { if (!controller.signal.aborted) setState({ url, value: result, error: '' }); })
      .catch(reason => { if (!controller.signal.aborted) setState({ url, value: null, error: reason instanceof Error ? reason.message : '加载失败' }); });
    return () => controller.abort();
  }, [url, retry]);
  return { value: state.url === url ? state.value : null, error: state.url === url ? state.error : '', reload: () => setRetry(n => n + 1) };
}
export function Pager({ offset, total, size = 20, move }: { offset: number; total: number; size?: number; move: (value: number) => void }) {
  return <div className="release-pager"><button disabled={offset === 0} onClick={() => move(Math.max(0, offset - size))}>上一页</button>
    <span>{total ? `${offset + 1}–${Math.min(offset + size, total)} / ${total}` : '0 条'}</span>
    <button disabled={offset + size >= total} onClick={() => move(offset + size)}>下一页</button></div>;
}
export function ErrorNotice({ message, retry }: { message: string; retry: () => void }) {
  return message ? <p role="alert" className="notice error">{message} <button onClick={retry}>重试</button></p> : null;
}
