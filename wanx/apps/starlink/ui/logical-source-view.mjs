const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const scope = s => JSON.stringify(['page','slide','sheet','table_index','table_region','heading_path','region'].map(k => s.source_locator?.[k] ?? null));
const table = s => ['table_cell','table'].includes(s.kind) && (s.source_locator?.table_index != null || s.source_locator?.table_region != null);

export function logicalSourceGroups(segments) {
  const groups = [];
  for (const segment of segments) {
    const text = String(segment.text ?? ''), kind = table(segment) ? 'table' : segment.kind === 'heading' ? 'heading' : 'paragraph';
    const short = !segment.text_truncated && ['paragraph','text',undefined].includes(segment.kind) && text.length <= 120;
    const last = groups.at(-1), key = scope(segment);
    if (last && last.scope === key && last.kind === kind &&
        (kind === 'table' || short && last.short && last.segments.length < 6 && last.characters + text.length < 600)) {
      last.segments.push(segment);
      last.characters += text.length;
    } else groups.push({kind, scope:key, short, segments:[segment], characters:text.length});
  }
  return groups;
}

export function logicalSourcesHTML(segments, {render = s => s.kind === 'heading' ? `<h3>${esc(s.text)}</h3>` : `<p>${esc(s.text)}</p>`, attributes = () => '', suffix = () => '', location = () => ''} = {}) {
  const cell = s => {
    const label = location(s);
    return `<div ${attributes(s)}>${label?`<small class="logical-source-location">${esc(label)}</small>`:''}${render(s)}${suffix(s)}</div>`;
  };
  return logicalSourceGroups(segments).map(group => {
    if (group.kind === 'table' && group.segments.every(s => s.kind === 'table_cell' &&
        Number.isSafeInteger(s.source_locator?.row_index) && s.source_locator.row_index >= 0 &&
        Number.isSafeInteger(s.source_locator?.column_index) && s.source_locator.column_index >= 0)) {
      const rows = new Map(), columns = [...new Set(group.segments.map(s => s.source_locator.column_index))].sort((a,b) => a-b);
      const positions = new Map(columns.map((col,index) => [col,index]));
      for (const s of group.segments) {
        const row = s.source_locator.row_index;
        if (!rows.has(row)) rows.set(row, new Map());
        const cells = rows.get(row), col = s.source_locator.column_index;
        if (!cells.has(col)) cells.set(col, []);
        cells.get(col).push(s);
      }
      // Missing spans stay sparse: a diagonal 500-cell table must not allocate
      // a 500 x 500 DOM grid. Missing text can also be outside the current page.
      const gap = (row,start,count) => count ? `<td class="logical-table-gap" colspan="${count}" data-source-row="${row}" data-source-column="${columns[start]}" aria-label="当前读取范围未提供这些单元格的正文" title="当前读取范围未提供正文，可能为空白或尚未加载">—</td>` : '';
      return `<article class="logical-table"><div class="logical-table-scroll" tabindex="0" role="region" aria-label="材料表格"><table><caption>表格 · 当前已加载内容</caption><tbody>${[...rows].map(([row,cells]) => {
        let cursor = 0, content = '';
        for (const [col,sources] of [...cells].sort(([a],[b]) => a-b)) {
          const position = positions.get(col);
          content += gap(row,cursor,position-cursor);
          const header = sources.every(s => s.source_locator.table_header === true), tag = header ? 'th' : 'td';
          content += `<${tag}${header?' scope="col"':''} data-source-row="${row}" data-source-column="${col}">${sources.map(cell).join('')}</${tag}>`;
          cursor = position + 1;
        }
        return `<tr>${content}${gap(row,cursor,columns.length-cursor)}</tr>`;
      }).join('')}</tbody></table></div></article>`;
    }
    // Legacy HTML rows lack unambiguous cell offsets. Keep each row intact.
    return `<article class="logical-source-group${group.kind === 'table' ? ' logical-table-rows' : ''}">${group.segments.map(cell).join('')}</article>`;
  }).join('');
}

export function taskUnitLabel(job) {
  return ({knowledge_extract:'抽取批次', modeling_extract:'抽取批次', document_parse:'原文片段', search_index:'索引单元'})[job.kind] || '项';
}

export function extractionCountsHTML(job) {
  if (!['knowledge_extract','modeling_extract'].includes(job?.kind)) return '';
  const m = job.metrics || {}, valid = n => Number.isSafeInteger(n) && n >= 0;
  const parts = [];
  if (valid(m.source_segments)) parts.push(`原文 ${m.source_segments} 个片段`);
  if (valid(m.llm_requests)) {
    // Older managed calls bypassed this counter. Historical call logs span
    // attempts and are truncated, so their length is not a request count.
    const missing = m.llm_requests === 0 && m.llm_request_count_version !== 2 &&
      Array.isArray(m.model_calls) && m.model_calls.length > 0;
    parts.push(missing ? '本次模型请求次数未记录' : `本次模型请求 ${m.llm_requests} 次（含重试）`);
  }
  if (valid(m.extraction_batches_reused) && m.extraction_batches_reused > 0) parts.push(`复用 ${m.extraction_batches_reused} 个抽取批次`);
  if (valid(m.empty_batches) && m.empty_batches > 0) parts.push(`空批次 ${m.empty_batches} 个`);
  if (m.extraction_empty_reason === 'EMPTY_EXTRACTION') parts.push('未抽到实体或关系');
  if (m.extraction_empty_reason === 'NO_PUBLISHABLE_CANDIDATES') parts.push('本次没有通过校验、可发布的候选');
  if (m.extraction_empty_reason === 'EXCLUDED_SCOPE') parts.push('本次候选均命中仓库的明确排除范围');
  const count = m.extraction_counts;
  if (count && [count.model_entities, count.model_relations, count.rejected_entities, count.rejected_relations].every(valid)) {
    parts.push(`模型返回 ${count.model_entities} 个实体、${count.model_relations} 条关系`);
    parts.push(`校验拒绝 ${count.rejected_entities} 个实体、${count.rejected_relations} 条关系`);
    if (valid(count.excluded_candidates) && count.excluded_candidates > 0) parts.push(`按范围排除 ${count.excluded_candidates} 项`);
  }
  return parts.length ? `<p class="task-source-counts">${parts.join(' · ')}</p>` : '';
}
