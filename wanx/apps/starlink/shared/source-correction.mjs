// Metadata pages can contain a shortened last segment. Never edit that preview.
export async function loadCorrectionSegments(detail, offset, current, request) {
  if (!detail.version) throw new Error('正文尚未就绪。');
  const id = encodeURIComponent(detail.document.id), version = detail.version.id;
  const segments = offset === 0 ? detail.segments.map(s => ({...s})) : [];
  const check = () => { if (!current()) throw new Error('材料正文已变化，请刷新后重新开始校对。'); };
  while (segments.length < detail.document.segment_count) {
    const page = await request(`/api/documents/${id}?segment_offset=${segments.length}&segment_limit=200&block_limit=1`);
    check();
    if (page?.document?.id !== detail.document.id || page.version?.id !== version)
      throw Object.assign(new Error('来源片段未能完整读取，请刷新后重试。'), {code: 'SOURCE_VERSION_CONFLICT'});
    if (!Array.isArray(page.segments) || !page.segments.length)
      throw new Error('来源片段未能完整读取，请刷新后重试。');
    segments.push(...page.segments.map(s => ({...s})));
  }
  if (segments.length !== detail.document.segment_count || new Set(segments.map(s => s.id)).size !== segments.length)
    throw new Error('来源片段不完整，请刷新后重试。');
  for (const segment of segments) {
    if (!segment.text_truncated) continue;
    const start = segment.canonical_start, end = segment.canonical_end;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start)
      throw new Error('当前服务未提供完整正文范围，请更新 Semantica 后重新校对。');
    let text = '';
    for (let position = start; position < end;) {
      const finish = Math.min(position + 65536, end);
      const range = await request(`/api/documents/${id}/text?version_id=${encodeURIComponent(version)}&start=${position}&end=${finish}`);
      check();
      if (range?.document_id !== detail.document.id || range.version_id !== version || range.start !== position ||
        range.end !== finish || typeof range.text !== 'string' || Array.from(range.text).length !== finish - position)
        throw new Error('完整正文读取失败，未进入校对。请重试。');
      text += range.text;
      position = finish;
    }
    if (Array.from(text).length !== segment.full_text_chars) throw new Error('正文长度校验失败，未进入校对。');
    segment.text = text;
    segment.text_truncated = false;
  }
  check();
  return segments;
}
