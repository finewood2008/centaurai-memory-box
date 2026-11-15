const active = new Set(['queued', 'running', 'cancel_requested']);
const states = new Set([...active, 'succeeded', 'failed', 'cancelled', 'interrupted']);
const op = /^[a-f0-9]{32}$/;
const fail = () => { throw Error('EXPERT_RESPONSE_INVALID'); };
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : fail();
const text = (value, max) => typeof value === 'string' && value.length <= max ? value : fail();
const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fail();

export function parseRun(value) {
  const r = object(value);
  if (!states.has(r.state) || !r.id || !/^[A-Za-z0-9._-]{1,128}$/.test(r.id)) fail();
  return {
    id: r.id, state: r.state, text: text(r.text, 12000),
    result: r.result === null ? null : text(r.result, 1024 * 1024),
    errorCode: r.errorCode === null ? null : text(r.errorCode, 128),
    createdAt: number(r.createdAt), updatedAt: number(r.updatedAt),
  };
}

export function message(error) {
  const code = typeof error?.code === 'string' ? error.code : error?.message;
  const messages = {
    EXPERT_INPUT_INVALID: '请输入 1—12000 字的内容。',
    EXPERT_RESPONSE_INVALID: '应用服务返回的数据暂时无法识别，请刷新状态。',
    EXPERT_BINDING_UNAVAILABLE: '当前应用的服务尚未就绪，请检查部署结果。',
    EXPERT_RUNTIME_UNAVAILABLE: '盒端智能服务暂不可用，请稍后刷新。',
    EXPERT_REQUEST_CONFLICT: '这次请求的信息发生冲突，请刷新后查看原请求。',
    UPDATE_REQUIRED: '应用版本已更新，请从万象重新打开。',
    HOST_SESSION_EXPIRED: '万象连接已失效，请重新连接盒子并打开应用。',
    RUNTIME_SESSION_EXPIRED: '应用会话已结束，请从万象重新打开。',
    RECORD_CHANGED: '另一个窗口更新了请求，请刷新状态后继续。',
  };
  return messages[code] || '操作未完成，请检查盒子连接后刷新状态。';
}

/** Only this repository handles request identity; UI calls never choose an expert. */
export function createExpertClient(api, { operationId = () => crypto.randomUUID().replaceAll('-', '') } = {}) {
  let state = { items: [], selectedId: null, scopeId: null, loading: false, busy: false, ready: false, pending: null, error: '', notice: '' };
  let disposed = false, revision = 0, epoch = 0;
  const listeners = new Set();
  const update = patch => { if (disposed) return; state = { ...state, ...patch }; for (const listener of listeners) listener(); };
  const pendingValue = (row, scopeId) => {
    if (!row) { revision = 0; return null; }
    if (!Number.isSafeInteger(row._revision) || row._revision < 1) fail();
    revision = row._revision;
    if (row.operationId === '' && row.text === '') return null;
    // A first prod deployment can copy dev app data, but cannot replay dev work.
    if (row.scopeId !== scopeId) return null;
    if (!op.test(row.operationId) || typeof row.text !== 'string' || !row.text.trim() || row.text.length > 12000) fail();
    return { operationId: row.operationId, text: row.text, scopeId };
  };
  async function writePending(pending) {
    const row = await api.data.put({ collection: 'expert_requests', id: 'pending', expectedRevision: revision, value: pending || { operationId: '', text: '', scopeId: state.scopeId } });
    if (!Number.isSafeInteger(row?._revision) || row._revision !== revision + 1) fail();
    revision = row._revision;
  }
  function received(value, expectedId) {
    const r = parseRun(object(value).run);
    if (expectedId && r.id !== expectedId) fail();
    return r;
  }
  function remember(r) {
    update({ items: [r, ...state.items.filter(item => item.id !== r.id)].sort((a, b) => b.createdAt - a.createdAt), selectedId: r.id });
  }
  async function refresh() {
    if (disposed || state.busy || state.loading) return;
    const turn = ++epoch;
    update({ loading: true, error: '' });
    try {
      const [result, pending] = await Promise.all([
        api.foundation.invoke('expert.tasks', {}),
        api.data.get({ collection: 'expert_requests', id: 'pending' }),
      ]);
      if (disposed || turn !== epoch) return;
      if (!Array.isArray(result?.items) || result.items.length > 200) fail();
      const scopeId = result?.context?.scopeId;
      if (typeof scopeId !== 'string' || !/^[a-f0-9]{64}$/.test(scopeId)) fail();
      const items = result.items.map(parseRun);
      if (new Set(items.map(item => item.id)).size !== items.length) fail();
      const restored = pendingValue(pending, scopeId);
      update({ items: items.sort((a, b) => b.createdAt - a.createdAt), pending: restored, scopeId, ready: true,
        selectedId: items.some(item => item.id === state.selectedId) ? state.selectedId : items[0]?.id || null,
        ...(restored ? { notice: '上次请求的提交结果尚未确认。可以查看历史，或重试同一次请求。' } : {}) });
    } catch (error) { if (!disposed && turn === epoch) update({ ready: false, error: message(error) }); }
    finally { if (!disposed && turn === epoch) update({ loading: false }); }
  }
  async function submit(pending, persist) {
    update({ busy: true, error: '', notice: '' });
    try {
      if (persist) {
        await writePending(pending);
        if (disposed) return null;
        update({ pending });
      }
      const r = received(await api.foundation.invoke('expert.run', { operationId: pending.operationId, text: pending.text }));
      if (disposed) return null;
      remember(r);
      // Keep the persisted identity if clearing fails, so reopening can retry it.
      await writePending(null);
      update({ pending: null, notice: '请求已受理。结果由盒子保存，关闭窗口后可以回来查看。' });
      return r;
    } catch (error) {
      update({ error: message(error), ...(state.pending ? { notice: '暂时无法确认提交结果。请先刷新；重试会沿用原请求，不会另建一次执行。' } : { ready: false }) });
      return null;
    } finally { update({ busy: false }); }
  }
  async function send(value) {
    if (disposed || !state.ready || !state.scopeId || state.loading || state.busy || state.pending) return null;
    if (typeof value !== 'string' || !value.trim() || value.trim().length > 12000) { update({ error: '请输入 1—12000 字的内容。' }); return null; }
    const id = operationId();
    if (!op.test(id)) { update({ error: message(Error('EXPERT_RESPONSE_INVALID')) }); return null; }
    return submit({ operationId: id, text: value.trim(), scopeId: state.scopeId }, true);
  }
  async function retry() {
    if (disposed || !state.ready || !state.scopeId || state.loading || state.busy || !state.pending || state.pending.scopeId !== state.scopeId) return null;
    return submit({ ...state.pending }, false);
  }
  async function cancel(id) {
    if (disposed || !state.ready || state.loading || state.busy || !state.items.some(item => item.id === id && ['queued', 'running'].includes(item.state))) return;
    update({ busy: true, error: '', notice: '' });
    try {
      const r = received(await api.foundation.invoke('expert.cancel', { runId: id }), id);
      if (disposed) return;
      remember(r);
      update({ notice: r.state === 'cancelled' ? '这次执行已取消。' : '已请求取消，请以更新后的实际状态为准。' });
    } catch (error) { update({ error: message(error), notice: '取消结果尚未确认，请刷新状态查看。' }); }
    finally { update({ busy: false }); }
  }
  return {
    getSnapshot: () => state,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    refresh, send, retry, cancel,
    select(id) { if (!disposed && state.items.some(item => item.id === id)) update({ selectedId: id }); },
    shouldPoll: () => !disposed && !state.busy && !state.loading && (Boolean(state.pending) || state.items.some(item => active.has(item.state))),
    dispose() { disposed = true; epoch++; listeners.clear(); },
  };
}

export const stateLabel = state => ({ queued: '等待处理', running: '处理中', cancel_requested: '正在取消', succeeded: '已完成', failed: '执行失败', cancelled: '已取消', interrupted: '执行中断' })[state] || '状态待确认';
