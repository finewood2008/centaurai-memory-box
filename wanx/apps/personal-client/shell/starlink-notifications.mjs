// Main-process only. The signed box API controls warehouse membership; bodies never contain source text.
export async function collectStarlinkNotifications({ request, dataScope, isCurrent, collect, deviceId, deviceName,
  state = {}, save = async () => {} }) {
  state = structuredClone(state);
  state.warehouses ||= {};
  const common = { applicationId: 'centaurai.wanx.semantica', category: 'application', deviceId, deviceName };
  const get = async path => {
    if (!isCurrent()) return null;
    const response = await request({ path: '/api/semantica' + path,
      headers: { 'x-wanx-data-context': dataScope }, signal: AbortSignal.timeout(12000) });
    if (!isCurrent()) return null;
    if (response.status === 401 || response.status === 403) return null;
    if (response.body?.length > 2 * 1024 * 1024) throw new Error('invalid');
    let body;
    try { body = JSON.parse(response.body.toString()); } catch { body = {}; }
    if (response.status !== 200) {
      if (body.code === 'SEMANTICA_NOT_CONFIGURED' || body.code === 'WAREHOUSE_BUSY' || body.code === 'WAREHOUSE_CLOSED') return null;
      throw Object.assign(new Error(response.status === 404 ? 'upgrade' : 'unavailable'), {status: response.status});
    }
    return body;
  };
  const unavailable = async kind => {
    if (!isCurrent()) return;
    // Persist an incident generation: repeated polls/restarts don't spam, recovery permits a new alert.
    if (state.incident?.kind !== kind) {
      state.incident = {kind, generation: (state.incident?.generation || 0) + 1};
      collect({...common, key: `starlink-service:${deviceId}:${dataScope}:${kind}:${state.incident.generation}`,
        title: kind === 'upgrade' ? '星图服务需要升级' : '星图服务暂时不可用',
        body: kind === 'upgrade' ? '当前盒端尚不支持完整的星图错误通知，请更新盒端服务；现有材料已保留。'
          : '暂时无法读取星图服务或任务状态。客户端会继续尝试连接，恢复后补收失败通知；现有材料已保留。'});
    }
    await save(state);
  };
  let directory;
  try { directory = await get('/warehouses'); }
  catch (error) { if (error.status !== 404 || state.active) await unavailable('unavailable'); return; }
  if (!isCurrent() || directory === null) return;
  if (!Array.isArray(directory?.items)) { await unavailable('unavailable'); return; }
  state.active = true;
  let failure = null;
  for (const warehouse of directory.items) {
    if (!isCurrent()) return;
    if (warehouse.state !== 'active' || !/^[a-f0-9-]{36}$/.test(warehouse.id)) continue;
    const stored = state.warehouses[warehouse.id] ||= {};
    try {
      const processing = await get('/processing?warehouse_id=' + warehouse.id);
      if (!isCurrent()) return;
      const config = processing?.effective;
      if (config && (config.blocked_reason || config.extraction?.available === false || config.sensitive?.available === false)) {
        const signature = `${config.signature || processing.revision || 0}:${config.blocked_reason || 'unavailable'}`;
        if (stored.modelFailure !== signature) {
          const automatic = config.mode === 'auto' || config.mode === 'automatic' || config.source === 'wanx_default';
          const confirmation = config.blocked_reason === 'MODEL_CLOUD_CONFIRMATION_REQUIRED';
          collect({...common, key: `starlink-model:${deviceId}:${dataScope}:${warehouse.id}:${signature}:${stored.modelGeneration || 0}`,
            title: confirmation ? '星图在线模型待确认' : automatic ? '星图默认模型不可用' : '星图处理模型不可用',
            body: confirmation ? '处理资料前需要确认在线模型的使用。请打开星图的“模型与处理”检查并确认；现有材料已保留。'
              : automatic ? 'WANX 默认模型当前无法使用，星图材料处理受到影响。请检查万象模型配置；现有材料已保留。'
              : '星图所选模型已失效或配置发生变化。请打开星图的“模型与处理”检查；现有材料已保留。'});
          stored.modelFailure = signature;
        }
      } else if (config && stored.modelFailure) {
        delete stored.modelFailure; stored.modelGeneration = (stored.modelGeneration || 0) + 1;
      }
      // Bounded work each refresh; a durable sequence resumes the backlog on the next refresh.
      for (let page = 0; page < 5; page++) {
        const cursor = stored.cursor || 0;
        const result = await get(`/warehouses/${warehouse.id}/failure-events?after=${cursor}&limit=100`);
        if (!isCurrent()) return;
        if (!result) break;
        if (typeof result.feed_id !== 'string' || !Array.isArray(result.items) || result.items.length > 100 ||
            !Number.isSafeInteger(result.next_cursor) || result.next_cursor < 0 || typeof result.has_more !== 'boolean') throw new Error('invalid');
        if (stored.feedId && stored.feedId !== result.feed_id) { stored.feedId = result.feed_id; stored.cursor = 0; continue; }
        if (result.has_more && result.next_cursor <= cursor) throw new Error('invalid');
        for (const event of result.items) {
          if (!Number.isSafeInteger(event.sequence) || event.sequence < 1 || event.sequence > result.next_cursor ||
              typeof event.job_id !== 'string' || !Number.isFinite(Date.parse(event.failed_at))) throw new Error('invalid');
          const titles = {ontology_suggest: '星图本体建议失败', knowledge_extract: '星图知识抽取失败',
            knowledge_publish: '星图知识图谱发布失败', sensitive_scan: '星图检索检测失败',
            document_parse: '星图材料解析失败', search_index: '星图检索索引失败',
            search_request: '星图检索暂时不可用', graph_request: '星图图谱暂时不可用'};
          const requestFailure = ['search_request','graph_request'].includes(event.kind);
          const key = requestFailure ? `starlink-request:${deviceId}:${dataScope}:${warehouse.id}:${event.kind}:${Math.floor(Date.parse(event.failed_at)/3600000)}`
            : `starlink-job:${deviceId}:${dataScope}:${warehouse.id}:${event.job_id}`;
          collect({...common, key,
            title: titles[event.kind] || '星图任务处理失败', createdAt: Date.parse(event.failed_at),
            body: requestFailure ? '本次请求未完成，请打开星图查看并重试；现有材料已保留。'
              : '任务曾处理失败，请打开星图任务中心查看最新状态及重试结果；现有材料已保留。'});
        }
        stored.feedId = result.feed_id; stored.cursor = result.next_cursor;
        await save(state);
        if (!result.has_more) break;
      }
    } catch (error) { failure = error.message === 'upgrade' ? 'upgrade' : 'unavailable'; }
  }
  if (!isCurrent()) return;
  if (failure) await unavailable(failure);
  else {
    if (state.incident) state.incident = {...state.incident, kind: null};
    await save(state);
  }
}
