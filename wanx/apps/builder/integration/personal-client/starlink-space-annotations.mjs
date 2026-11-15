// Annotation bindings are local candidates. Every recall rechecks both the
// current space file and the warehouse document through their normal APIs.
const resource = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const currentVersion = result => result?.version?.id || result?.document?.active_version_id;
const annotationSignature = annotation => JSON.stringify({tags:annotation?.tags || [], description:annotation?.description || '',
  provenance:(annotation?.provenance || []).map(({tag, source, itemId, origin}) => ({tag, source, itemId, origin}))});
const annotationMatches = (annotation, query) => annotation && !annotation.needsReview &&
  [...(annotation.tags || []), annotation.description || ''].some(value => {
    const text = String(value).toLocaleLowerCase();
    return text.includes(query) || (text.length >= 2 && query.includes(text));
  });

export function createStarlinkSpaceAnnotations({space, service, check}) {
  const selections = new Map();
  const checked = async operation => { check(); try { return await operation(); } finally { check(); } };
  const remote = (action, input) => checked(() => space.operation(action, input));
  const bindings = async warehouseId => {
    const result = await remote('annotation-imports', {warehouseId});
    return (Array.isArray(result) ? result : result?.items || []).filter(item => item.warehouseId === warehouseId && item.space_id === 'personal');
  };
  async function source(binding) {
    const entry = await remote('stat', {id:binding.id, space_id:binding.space_id});
    if (entry.id !== binding.id || entry.kind !== 'file' || entry.trashed != null || entry.digest !== binding.digest ||
        (entry.space_id && entry.space_id !== binding.space_id)) return null;
    const annotation = entry.annotation || await remote('annotation', {id:binding.id, space_id:binding.space_id});
    return {entry, annotation};
  }
  async function document(binding) {
    const result = await checked(() => service.call('document', {warehouseId:binding.warehouseId, id:binding.documentId}));
    const versionId = currentVersion(result);
    if (result?.document?.id !== binding.documentId || !resource(versionId) ||
        (result.document.status && result.document.status !== 'ready') ||
        (result.document.warehouse_id && result.document.warehouse_id !== binding.warehouseId) ||
        (binding.versionId && versionId !== binding.versionId)) return null;
    return {result, versionId};
  }
  const receiptInput = value => ({id:value.id, space_id:'personal', warehouseId:value.warehouseId, documentId:value.documentId,
    digest:value.digest, annotationRevision:value.annotationRevision, ...(value.snapshot ? {snapshot:value.snapshot} : {})});
  async function recover(warehouseId, documentId) {
    const reply = await remote('annotation-pending-imports', {warehouseId});
    const receipts = (Array.isArray(reply) ? reply : reply?.items || []).filter(row => row.warehouseId === warehouseId &&
      row.space_id === 'personal' && (!documentId || row.documentId === documentId));
    const status = {incomplete:receipts.length > 200, pendingImports:receipts.length, recoveredImports:0, remaining:[]};
    for (const receipt of receipts.slice(0, 200)) {
      try {
        if (!await source(receipt)) throw Object.assign(Error('SPACE_REMOTE_FILE_CHANGED'), {code:'SPACE_REMOTE_FILE_CHANGED'});
        const observed = await document(receipt);
        if (!observed) throw Object.assign(Error('SPACE_ANNOTATION_DOCUMENT_PENDING'), {code:'SPACE_ANNOTATION_DOCUMENT_PENDING'});
        // bind revalidates source authority and digest again, and atomically
        // replaces this durable pending receipt with a versioned binding.
        await remote('annotation-bind', {...receiptInput(receipt), versionId:observed.versionId});
        status.pendingImports--; status.recoveredImports++;
      } catch (error) {
        check(); status.incomplete = true; status.code ||= error.code || 'SPACE_ANNOTATION_READ_FAILED'; status.remaining.push(receipt);
      }
    }
    return status;
  }
  return {
    async run(action, input, base) {
      if (!space || !['select-space-files','upload','search','document'].includes(action)) return base();
      let recovery = {incomplete:false, pendingImports:0, recoveredImports:0, remaining:[]};
      if (['search','document'].includes(action) && input.warehouseId) {
        try { recovery = await recover(input.warehouseId, action === 'document' ? input.id : undefined); }
        catch (error) { check(); recovery.incomplete = true; recovery.code = error.code || 'SPACE_ANNOTATION_UNAVAILABLE'; }
      }
      const result = await checked(base);
      if (action === 'select-space-files') {
        const staged = [];
        for (const file of result || []) {
          const selection = input.entries.find(entry => entry.id === file.spaceId);
          if (!selection) throw Object.assign(Error('SPACE_REMOTE_FILE_CHANGED'), {code:'SPACE_REMOTE_FILE_CHANGED'});
          const entry = await remote('stat', {id:file.spaceId, space_id:'personal'});
          if (entry.id !== selection.id || entry.digest !== selection.digest || entry.trashed != null)
            throw Object.assign(Error('SPACE_REMOTE_FILE_CHANGED'), {code:'SPACE_REMOTE_FILE_CHANGED'});
          const annotation = entry.annotation || await remote('annotation', {id:entry.id, space_id:'personal'});
          staged.push([file.handle, {id:entry.id, space_id:'personal', digest:entry.digest,
            warehouseId:input.warehouseId, annotationRevision:annotation?.revision || 0, snapshot:annotation}]);
        }
        for (const [handle, selection] of staged) selections.set(handle, selection);
        return result.map(file => ({...file, sourceAnnotation:selections.get(file.handle)?.snapshot}));
      }
      if (action === 'upload') {
        const selection = selections.get(input.handle);
        if (!selection || selection.warehouseId !== input.warehouseId || !resource(result?.document?.id)) return result;
        try {
          // Persist the observed commit before any further network read. A new
          // session can finish indexing it without the old upload handle.
          await remote('annotation-stage-import', {...selection, documentId:result.document.id});
          const entry = await remote('stat', {id:selection.id, space_id:selection.space_id});
          if (entry.digest !== selection.digest || entry.trashed != null)
            throw Object.assign(Error('SPACE_REMOTE_FILE_CHANGED'), {code:'SPACE_REMOTE_FILE_CHANGED'});
          let versionId = currentVersion(result);
          if (!resource(versionId)) {
            const observed = await checked(() => service.call('document', {warehouseId:selection.warehouseId, id:result.document.id}));
            if (observed?.document?.id === result.document.id && (!observed.document.status || observed.document.status === 'ready') &&
                (!observed.document.warehouse_id || observed.document.warehouse_id === selection.warehouseId)) versionId = currentVersion(observed);
          }
          if (!resource(versionId)) throw Object.assign(Error('SPACE_ANNOTATION_DOCUMENT_PENDING'), {code:'SPACE_ANNOTATION_DOCUMENT_PENDING'});
          await remote('annotation-bind', {...selection, documentId:result.document.id, versionId});
          return {...result, sourceAnnotation:selection.snapshot, annotationIndex:{status:'saved'}};
        } catch (error) {
          check();
          // The import itself committed. The same handle can retry locally;
          // a durable staged receipt can also recover in a later session.
          return {...result, sourceAnnotation:selection.snapshot, annotationIndex:{status:'pending', code:error.code || 'SPACE_ANNOTATION_WRITE_FAILED'}};
        }
      }
      if (!input.warehouseId) return result;
      let imports;
      try { imports = await bindings(input.warehouseId); }
      catch (error) { check(); return {...result, annotationSearch:{incomplete:true, code:error.code || 'SPACE_ANNOTATION_UNAVAILABLE'}}; }
      if (action === 'document') {
        const binding = imports.find(item => item.documentId === input.id);
        if (!binding) {
          const receipt = recovery.remaining.find(item => item.documentId === input.id);
          return receipt ? {...result, annotationIndex:{status:'pending', code:recovery.code},
            sourceAnnotation:{snapshot:receipt.snapshot || null, current:null, needsRefresh:true, indexStatus:'pending'}} : result;
        }
        try {
          const current = await source(binding);
          return {...result, annotationIndex:{status:'saved'}, sourceAnnotation:{snapshot:binding.snapshot || null, current:current?.annotation || null,
            needsRefresh:!current || current.annotation?.needsReview === true || binding.annotationRevision !== current.annotation?.revision ||
              (!!binding.snapshot && annotationSignature(binding.snapshot) !== annotationSignature(current?.annotation)) ||
              (!!binding.versionId && binding.versionId !== currentVersion(result))}};
        } catch (error) { check(); return {...result, sourceAnnotation:{snapshot:binding.snapshot || null, current:null, needsRefresh:true, code:error.code}}; }
      }
      const query = typeof input.query === 'string' ? input.query.trim().toLocaleLowerCase() : '';
      if (!query) return result;
      const documents = [], seen = new Set((result?.items || result?.results || []).map(item => item.document_id).filter(Boolean));
      const {remaining, ...recoveryStatus} = recovery;
      const diagnostics = {...recoveryStatus, incomplete:recovery.incomplete || imports.length > 200, scanned:0};
      for (const binding of imports.slice(0, 200)) {
        if (!resource(binding.documentId) || seen.has(binding.documentId) ||
            (input.documentIds?.length && !input.documentIds.includes(binding.documentId))) continue;
        try {
          diagnostics.scanned++;
          const current = await source(binding);
          if (!current || !annotationMatches(current.annotation, query)) continue;
          const observed = await document(binding);
          if (!observed) continue;
          let segments = observed.result.segments;
          if (!Array.isArray(segments) || !segments.length || segments.some(segment => segment.text_truncated)) {
            const text = await checked(() => service.api(`/warehouses/${encodeURIComponent(input.warehouseId)}/documents/${encodeURIComponent(binding.documentId)}/text?` +
              new URLSearchParams({version_id:observed.versionId, start:'0', end:'12000'})));
            if ((text.version_id || text.document_version_id || text.version?.id) !== observed.versionId) continue;
            segments = text.segments || [{text:text.text || text.content}];
          }
          const content = segments.map(segment => segment.text || segment.content || '').join('\n').slice(0, 12000);
          if (!content.trim()) continue;
          // Guard a file move/content change while document text was in flight.
          const after = await source(binding);
          if (!after || after.annotation?.revision !== current.annotation?.revision ||
              annotationSignature(after.annotation) !== annotationSignature(current.annotation) || !annotationMatches(after.annotation, query)) continue;
          seen.add(binding.documentId);
          documents.push({documentId:binding.documentId, versionId:observed.versionId,
            title:observed.result.document.original_name || current.entry.name, text:content,
            locator:segments[0]?.source_locator || segments[0]?.locator || null, annotation:current.annotation});
          if (documents.length === 10) { diagnostics.incomplete ||= imports.length > diagnostics.scanned; break; }
        } catch (error) {
          check(); diagnostics.incomplete = true; diagnostics.code ||= error.code || 'SPACE_ANNOTATION_READ_FAILED';
        }
      }
      return {...result, annotationDocuments:documents, annotationSearch:diagnostics};
    },
  };
}
