const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

export function pendingAnnotationHTML(file) {
  if (file.annotationIndex?.status === 'missing_snapshot') return '<small role="status">未保存导入时标注，不会自动补入空间后续标注</small>';
  if (file.annotationIndex?.status === 'stale') return '<small role="status">正文版本已变化，导入标注未同步</small>';
  if (file.annotationIndex?.status === 'pending') return '<small role="status">文件已导入，标注关联待恢复</small>';
  if (file.annotationSelection?.status === 'pending') return '<small role="status">标注暂未读取，可继续导入；不会自动补入后续标注</small>';
  const annotation = file.sourceAnnotation;
  if (!annotation) return '<small>暂无标签和文件说明</small>';
  if (annotation.needsReview) return '<small>导入时标注待核对，暂不参与标注检索</small>';
  const tags = (annotation.tags || []).map(tag => `<span class="badge">${esc(tag)}</span>`).join(' ');
  return `${tags ? `<small aria-label="文件标签">${tags}</small>` : ''}${annotation.description ? `<small>${esc(annotation.description)}</small>` : ''}${!tags && !annotation.description ? '<small>暂无标签和文件说明</small>' : ''}`;
}

export function relatedMaterialsHTML(result) {
  const documents = (result.annotationDocuments || []).filter(item => /^[A-Za-z0-9_-]{1,128}$/.test(item.documentId));
  if (!documents.length) return '';
  return `<section aria-label="标注相关材料"><h3>相关材料</h3><p class="muted">标签或说明匹配，请查看正文确认相关内容。</p>${documents.map(item => `<article class="result-card"><h4>${esc(item.title)}</h4>${item.annotationMatch ? annotationMatchHTML(item.annotationMatch) : pendingAnnotationHTML({sourceAnnotation:item.annotation})}<button class="text-link" data-source="${esc(item.documentId)}" data-source-version="${esc(item.versionId)}">查看材料</button></article>`).join('')}</section>`;
}

export function annotationMatchHTML(match) {
  if (!match) return '';
  const tags = (match.tags || []).map(tag => `<span class="pill">${esc(tag)}</span>`).join(' ');
  const description = match.description ? `<p>说明命中 · ${esc(match.description)}</p>` : '';
  return `<div class="annotation-search-match">${tags ? `<p>标签命中 · ${tags}</p>` : ''}${description}</div>`;
}

export function materialAnnotationHTML(source) {
  if (!source.sourceAnnotation && !source.annotationSync) return '';
  const annotation = source.sourceAnnotation?.snapshot;
  const sync = source.annotationSync;
  const labels = {saved:sync?.searchable?'标注已保存，可按标签和说明检索。':'标注已保存到服务端，暂不参与标注检索。',pending:'标注待同步，下次读取材料时重试。',
    conflict:'标注版本冲突，原快照未覆盖服务端内容。',stale:'材料版本或源文件状态已变化，未同步导入标注。',
    missing_snapshot:'未保存可靠的导入标注快照，不会自动使用空间最新标注补齐；正文检索仍可用。',
    unsupported:'当前服务暂不支持标注同步，已保留导入时的标注。'};
  return `<section class="mw-import-source" aria-label="来源标注"><header><h3>导入时的标签与说明</h3></header>${pendingAnnotationHTML({sourceAnnotation:annotation})}<p role="status">${labels[sync?.status] || '标注已关联到当前材料。'}</p></section>`;
}
