// Read-only references to the current project's existing pages. No mutation dispatch.
const resource = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const normalized = value => String(value ?? '').trim().toLocaleLowerCase();
export function starxiaotuNeedle(query) {
  return String(query).trim().replace(/^(?:请|帮我|麻烦|直接|在当前项目中|在当前项目里|记录|实体|关系|资料|搜索|检索|查询|定位|跳到|跳转到|找到|查找|打开|查看|到|一下|：|:|\s)+/u, '').replace(/[「」“”"？?。]+$/gu, '').replace(/^[「“"]/u, '').trim();
}

export function starxiaotuSearchFailure(error) {
  const reasons={
    SEMANTICA_INDEX_REQUIRED:['当前项目尚未建立检索索引，请到资料库查看索引状态并按页面提示建立索引。','conversation'],
    SEMANTICA_INDEX_STALE:['资料已有更新，检索索引尚未同步。请到资料库查看索引进度，完成后重试。','conversation'],
    SEMANTICA_NO_PARSED_CONTENT:['当前项目尚无可检索的已解析正文，请到资料库查看资料解析进度。','conversation'],
    SEMANTICA_EMBEDDING_NOT_CONFIGURED:['当前项目尚未配置检索向量模型，请在模型设置中检查配置。','models'],
    SEMANTICA_CONNECTION_FAILED:['盒端检索连接失败，请检查盒子连接后重试。','conversation'],
    NETWORK_NOT_READY:['盒子网络连接尚未就绪，请恢复连接后重试检索。','conversation'],
    SEMANTICA_SERVICE_TIMEOUT:['盒端检索等待超时，请稍后重试或到资料库核对处理进度。','conversation'],
    SEMANTICA_UPGRADE_REQUIRED:['当前盒端检索接口版本不匹配，请核对盒端与客户端版本。','conversation'],
    SEMANTICA_OPERATION_NOT_ALLOWED:['当前盒端尚未支持此检索操作，请核对服务版本。','conversation'],
    SEMANTICA_INVALID_REQUEST:['当前服务未接受检索参数，请核对客户端与盒端接口版本。','conversation'],
    HOST_SESSION_EXPIRED:['盒子会话已失效，请重新连接盒子后检索。','conversation'],
    WAREHOUSE_CHANGED:['当前项目已切换，请返回需要查询的项目重新检索。','conversation'],
  };
  const code=typeof error?.code==='string' && /^(?:SEMANTICA|HOST_SESSION|WAREHOUSE|NETWORK|MODEL)_[A-Z_]{1,75}$/.test(error.code)?error.code:'';
  const [answer,destination]=reasons[code] || ['当前项目检索暂时不可用，没有生成资料回答。请稍后重试，或到资料库核对处理状态。','conversation'];
  return {answer,code,links:[{label:destination==='models'?'检查模型设置':'打开资料库',target:{view:destination}},{label:'查看数据列表',target:{view:'data'}}]};
}

/** Actual project counts and document references; no full-text index is required. */
export function starxiaotuOverview({warehouse,documents=[],graph,notice='',metric='summary'}) {
  if(!warehouse || typeof warehouse.name!=='string')throw new Error('当前项目统计尚未读取，请刷新项目后重试。');
  const count=(value,unit)=>Number.isSafeInteger(value)&&value>=0?value+unit:'数量暂未确认';
  const metrics={document_count:['资料',' 份'],entity_count:['实体',' 个'],relation_count:['关系',' 条']};
  if(Object.hasOwn(metrics,metric)){
    const [label,unit]=metrics[metric];
    return {answer:'当前项目「'+warehouse.name+'」的'+label+'：'+count(warehouse[metric],unit)+'。来源：项目统计。',results:[],complete:false,...(notice?{message:notice}:{})};
  }
  const rows=documents.filter(item=>resource(item?.id)&&typeof item.original_name==='string');
  const results=rows.slice(0,10).map(item=>({id:'document:'+item.id,title:item.original_name,excerpt:'当前项目资料库中的原文',target:{view:'conversation',kind:'document',documentId:item.id}}));
  const types=[...new Set((graph?.nodes||[]).map(node=>node.type).filter(Boolean))].slice(0,8);
  return {answer:'当前项目「'+warehouse.name+'」：资料 '+count(warehouse.document_count,' 份')+'，实体 '+count(warehouse.entity_count,' 个')+'，关系 '+count(warehouse.relation_count,' 条')+'。\n来源：项目统计与资料列表。'+(rows.length?'下方列出已读取资料中的前 '+results.length+' 份，可打开核对原文。':'当前读取的资料列表为空，可打开资料库核对。')+(types.length?'\n当前已加载的实体类型：'+types.join('、')+'。':'')+'\n输入具体名称或关键词，可以继续检索资料正文。',results,complete:false,...(notice?{message:notice}:{})};
}
export function starxiaotuRecords({graph, documents = [], resolvedQuery = false}, query, payload) {
  const needle = normalized(resolvedQuery?query:starxiaotuNeedle(query));
  const nodes = graph?.nodes || [], edges = graph?.edges || [];
  const names = new Map(nodes.map(node => [node.id, node.name]));
  const results = [];
  const add = item => { if (!results.some(existing => existing.id === item.id)) results.push(item); };
  const matches = (id, title) => needle && (normalized(id) === needle || normalized(title).includes(needle));
  for (const node of nodes) if (resource(node.id) && matches(node.id, node.name)) add({
    id:'entity:'+node.id, title:node.name, excerpt:'当前项目的实体记录 · '+node.type,
    target:{view:'knowledge', kind:'entity', recordId:node.id}, exactId:normalized(node.id) === needle,
  });
  for (const edge of edges) {
    const title = [names.get(edge.s), edge.label, names.get(edge.t)].filter(Boolean).join(' → ');
    if (resource(edge.id) && matches(edge.id, title)) add({id:'relation:'+edge.id, title,
      excerpt:'当前项目的关系记录 · '+(edge.evidence?.length || 0)+' 个来源片段',
      target:{view:'graph',kind:'relation',recordId:edge.id}, exactId:normalized(edge.id) === needle});
  }
  for (const document of documents) if (resource(document.id) && matches(document.id, document.original_name)) add({
    id:'document:'+document.id, title:document.original_name, excerpt:'当前项目资料库中的原文',
    target:{view:'conversation',kind:'document',documentId:document.id}, exactId:normalized(document.id) === needle,
  });
  const remote = payload?.items ?? payload?.results ?? [];
  for (const item of Array.isArray(remote) ? remote.slice(0,10) : []) {
    if (!resource(item.document_id)) continue;
    const versionId=item.document_version_id || item.version_id;
    // A stale/partial search hit can still open its document; never invent a version/segment.
    let locator=item.locator ?? item.locator_json;
    if (typeof locator === 'string') { try { locator=JSON.parse(locator); } catch { locator=null; } }
    const segmentId=item.segment_id || locator?.source_segments?.[0]?.segment_id || locator?.segment_id;
    const text=item.text ?? item.excerpt;
    if (typeof text !== 'string') continue;
    const target={view:'conversation',kind:'document',documentId:item.document_id,
      ...(resource(versionId)?{versionId}:{}), ...(resource(segmentId)?{segmentId}:{}),
      ...(Number.isSafeInteger(locator?.canonical_start)&&locator.canonical_start>=0?{start:locator.canonical_start}:{})};
    add({id:'evidence:'+JSON.stringify([item.document_id,versionId,segmentId,locator]),
      title:item.document_name || item.original_name || documents.find(d=>d.id===item.document_id)?.original_name || '资料原文',
      excerpt:text, target});
  }
  // Graph and retrieval endpoints are bounded snapshots. Only an exact resource ID is unambiguous.
  const exact=results.filter(item=>item.exactId);
  return exact.length === 1 ? {results:exact,complete:true} : {results:results.slice(0,20),complete:false};
}
export async function revealStarxiaotuRecord(element) {
  if (!element?.isConnected) return false;
  element.scrollIntoView({block:'center',inline:'nearest',behavior:'instant'});
  element.classList.add('sx-record-highlight');
  element.setAttribute('tabindex', element.getAttribute('tabindex') || '-1');
  element.focus({preventScroll:true});
  await new Promise(resolve => requestAnimationFrame(resolve));
  const rect=element.getBoundingClientRect();
  if (!element.isConnected || rect.width <= 0 || rect.height <= 0) return false;
  setTimeout(()=>element.classList.remove('sx-record-highlight'),5000);
  return true;
}
