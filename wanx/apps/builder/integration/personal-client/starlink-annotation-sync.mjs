import {createHash} from 'node:crypto';
const canonical = value => JSON.stringify(value, function(_key,item) {
  return item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key,item[key]])) : item;
});
const annotationPath = (warehouseId,documentId) => `/warehouses/${encodeURIComponent(warehouseId)}/documents/${encodeURIComponent(documentId)}/source-annotation`;

export function importedAnnotationSnapshot(binding) {
  const a=binding.snapshot;
  if (!a || !Number.isSafeInteger(binding.annotationRevision) || binding.annotationRevision<1 ||
      a.revision!==undefined && a.revision!==binding.annotationRevision ||
      !Array.isArray(a.tags) || a.tags.length>2048 || a.tags.some(tag=>typeof tag!=='string'||!tag.trim()||tag.length>80) ||
      typeof a.description!=='string' || a.description.length>2000 ||
      a.needsReview!==undefined && typeof a.needsReview!=='boolean') return null;
  return structuredClone(a);
}

export async function readStarlinkAnnotation({service,warehouseId,documentId,versionId,check}) {
  if (service.capabilities?.source_annotations?.version !== 1) return {};
  try {
    check();
    const value = await service.api(annotationPath(warehouseId,documentId));
    check();
    if (value.document_id !== documentId) throw Object.assign(Error('invalid response'),{code:'SEMANTICA_INVALID_RESPONSE'});
    if (!value.annotation) return {};
    const a=value.annotation, stale=value.stale || value.document_version_id!==versionId;
    return {sourceAnnotation:{snapshot:{tags:a.tags,description:a.description,provenance:a.provenance,
      revision:a.source.revision,needsReview:a.needs_review},current:null,needsRefresh:!!stale,remoteOnly:true},
      annotationSync:{status:stale?'stale':'saved',revision:value.revision,indexStatus:value.index_status,
        ...(service.capabilities.source_annotations.search_version === 1 && {searchable:!stale && !a.needs_review})}};
  } catch(error) {
    check();return {annotationSync:{status:'pending',code:error.code || 'SEMANTICA_REQUEST_FAILED'}};
  }
}

// The durable local import binding is the retry source. Metadata has its own
// receipt; a committed file must never be uploaded again for a metadata error.
export async function syncStarlinkAnnotation({service, binding, check}) {
  check();
  const a = importedAnnotationSnapshot(binding);
  if (!a) return {status:'missing_snapshot',code:'SPACE_ANNOTATION_SNAPSHOT_MISSING'};
  if (service.capabilities?.source_annotations?.version !== 1) return {status:'unsupported'};
  if (!binding.versionId) return {status:'pending',code:'SPACE_ANNOTATION_DOCUMENT_PENDING'};
  const annotation = {
    source:{file_id:binding.id,space_id:'personal',sha256:binding.digest,revision:binding.annotationRevision},
    tags:a.tags || [], description:a.description || '', needs_review:!!a.needsReview,
    provenance:(a.provenance || []).map(({tag,source,itemId,origin}) => ({tag,source,itemId,origin:origin ?? null})),
  };
  const path = annotationPath(binding.warehouseId,binding.documentId);
  const searchStatus = service.capabilities.source_annotations.search_version === 1 ? {searchable:!a.needsReview} : {};
  const checked = async task => { check(); try { return await task(); } finally { check(); } };
  try {
    const current = await checked(() => service.api(path));
    if (current.document_id !== binding.documentId || !Number.isSafeInteger(current.revision) || current.revision < 0)
      throw Object.assign(Error('SEMANTICA_INVALID_RESPONSE'), {code:'SEMANTICA_INVALID_RESPONSE'});
    if (current.document_version_id === binding.versionId && !current.stale &&
        canonical(current.annotation) === canonical(annotation))
      return {status:'saved',revision:current.revision,indexStatus:current.index_status,...searchStatus};
    // No previously acknowledged server revision is persisted yet. Never adopt
    // another writer's revision merely to overwrite a different annotation.
    if (current.revision !== 0) return {status:'conflict',code:'SEMANTICA_VERSION_CONFLICT'};
    const payload = {expected_document_version_id:binding.versionId,expected_revision:0,...annotation};
    const operation = 'annotation_' + createHash('sha256').update(JSON.stringify([binding.warehouseId,binding.documentId,payload])).digest('hex');
    const result = await checked(() => service.api(path,{method:'PUT',body:{operation_id:operation,...payload}}));
    if (result.document_id !== binding.documentId || result.document_version_id !== binding.versionId ||
        !Number.isSafeInteger(result.revision) || result.revision < 1)
      throw Object.assign(Error('SEMANTICA_INVALID_RESPONSE'), {code:'SEMANTICA_INVALID_RESPONSE'});
    return {status:'saved',revision:result.revision,indexStatus:result.index_status,...searchStatus};
  } catch (error) {
    check();
    return {status:error.code==='SEMANTICA_VERSION_CONFLICT'?'conflict':'pending',code:error.code || 'SEMANTICA_REQUEST_FAILED'};
  }
}
