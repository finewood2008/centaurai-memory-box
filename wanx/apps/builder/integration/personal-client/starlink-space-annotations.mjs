import {syncStarlinkAnnotation,readStarlinkAnnotation,importedAnnotationSnapshot} from './starlink-annotation-sync.mjs';
// Annotation bindings are local candidates. Every recall rechecks both the
// current space file and the warehouse document through their normal APIs.
import {createHash} from 'node:crypto';

const resource = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const currentVersion = result => result?.version?.id || result?.document?.active_version_id;
const requiredSnapshot = binding => {
  const snapshot=importedAnnotationSnapshot(binding);
  if (!snapshot) throw Object.assign(Error('SPACE_ANNOTATION_SNAPSHOT_MISSING'),{code:'SPACE_ANNOTATION_SNAPSHOT_MISSING'});
  return snapshot;
};
const annotationMatches = (annotation, query) => annotation && !annotation.needsReview &&
  [...(annotation.tags || []), annotation.description || ''].some(value => String(value).toLocaleLowerCase().includes(query));

export function createStarlinkSpaceAnnotations({space, service, check}) {
  const selections = new Map();
  const unstagedImports = new Map();
  const nextRecoveryDocument = new Map();
  const checked = async operation => { check(); try { return await operation(); } finally { check(); } };
  const remote = (action, input) => checked(() => space.operation(action, input));
  const bindings = async warehouseId => {
    const result = await remote('annotation-imports', {warehouseId});
    return (Array.isArray(result) ? result : result?.items || []).filter(item => item.warehouseId === warehouseId && item.space_id === 'personal');
  };
  async function source(binding) {
    // Revalidate file access and content only. Later Space labels never replace
    // the metadata captured with this import, including during recovery.
    const entry = await remote('stat', {id:binding.id, space_id:binding.space_id});
    if (entry.id !== binding.id || entry.kind !== 'file' || entry.trashed != null || entry.digest !== binding.digest ||
        (entry.space_id && entry.space_id !== binding.space_id)) return null;
    return {entry};
  }
  async function document(binding) {
    const result = await checked(() => service.call('document', {warehouseId:binding.warehouseId, id:binding.documentId}));
    const versionId = currentVersion(result);
    if (result?.document?.id !== binding.documentId || !resource(versionId) ||
        (result.document.status && result.document.status !== 'ready') ||
        (result.document.warehouse_id && result.document.warehouse_id !== binding.warehouseId) ||
        (binding.versionId && versionId !== binding.versionId)) return null;
    // A receipt without a version comes from the original import. A later
    // correction can keep the same uploaded digest while changing the body.
    if (!binding.versionId && result.version?.version_number !== 1) {
      if (result.version?.version_number > 1)
        throw Object.assign(Error('SPACE_ANNOTATION_DOCUMENT_CHANGED'), {code:'SPACE_ANNOTATION_DOCUMENT_CHANGED'});
      return null;
    }
    return {result, versionId};
  }
  const receiptInput = value => ({id:value.id, space_id:'personal', warehouseId:value.warehouseId, documentId:value.documentId,
    digest:value.digest, annotationRevision:value.annotationRevision, ...(value.snapshot ? {snapshot:value.snapshot} : {})});
  const receiptKey = receipt => JSON.stringify([receipt.warehouseId, receipt.documentId]);
  async function stageImport(receipt) {
    const key = receiptKey(receipt);
    unstagedImports.set(key, receipt);
    await remote('annotation-stage-import', receipt);
    unstagedImports.delete(key);
  }
  async function recover(warehouseId, documentId) {
    const matches = row => row.warehouseId === warehouseId && row.space_id === 'personal' &&
      (!documentId || row.documentId === documentId);
    const memory = [...unstagedImports.values()].filter(matches);
    let reply;
    try { reply = await remote('annotation-pending-imports', {warehouseId}); }
    catch (error) { check(); if (!memory.length) throw error; }
    const candidates = new Map((Array.isArray(reply) ? reply : reply?.items || [])
      .filter(matches).map(row => [receiptKey(row), row]));
    for (const receipt of memory) {
      // The on-disk copy wins if the previous write committed before refusing.
      if (!candidates.has(receiptKey(receipt))) candidates.set(receiptKey(receipt), receipt);
    }
    const receipts = [...candidates.values()];
    const status = {incomplete:receipts.length > 200, pendingImports:receipts.length, recoveredImports:0, remaining:[]};
    let batch = receipts;
    if (!documentId && receipts.length > 200) {
      const start = Math.max(0, receipts.findIndex(row => row.documentId === nextRecoveryDocument.get(warehouseId)));
      const end = start + 200;
      batch = receipts.slice(start, end).concat(receipts.slice(0, Math.max(0, end - receipts.length)));
      nextRecoveryDocument.set(warehouseId, receipts[end % receipts.length].documentId);
    } else if (!documentId) {
      nextRecoveryDocument.delete(warehouseId);
    }
    for (const receipt of batch) {
      try {
        if (unstagedImports.has(receiptKey(receipt))) await stageImport(receiptInput(receipt));
        requiredSnapshot(receipt);
        const current = await source(receipt);
        if (!current) throw Object.assign(Error('SPACE_REMOTE_FILE_CHANGED'), {code:'SPACE_REMOTE_FILE_CHANGED'});
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
      if (action === 'search' && resource(input.warehouseId)) {
        if (service?.capabilities?.source_annotations?.search_version === 1) {
          const options = input.annotationSearch ?? {};
          const result = await checked(() => service.api(`/warehouses/${input.warehouseId}/search`, {
            method:'POST', timeoutMs:90000,
            body:{query:input.query,document_ids:input.documentIds || [],
              entity_types:input.entityTypes || [],limit:10,annotation_search:options},
          }));
          if (options.tags?.length && result?.annotationSearch?.filtered !== true) {
            throw Object.assign(Error('SEMANTICA_ANNOTATION_SEARCH_UNAVAILABLE'),{code:'SEMANTICA_ANNOTATION_SEARCH_UNAVAILABLE'});
          }
          return result;
        }
        if (input.annotationSearch) throw Object.assign(Error('SEMANTICA_ANNOTATION_SEARCH_UNAVAILABLE'),
          {code:'SEMANTICA_ANNOTATION_SEARCH_UNAVAILABLE'});
      }
      if (!space || !['space-list','select-space-files','upload','search','document'].includes(action)) return base();
      let recovery = {incomplete:false, pendingImports:0, recoveredImports:0, remaining:[]};
      if (['search','document'].includes(action) && input.warehouseId) {
        try { recovery = await recover(input.warehouseId, action === 'document' ? input.id : undefined); }
        catch (error) { check(); recovery.incomplete = true; recovery.code = error.code || 'SPACE_ANNOTATION_UNAVAILABLE'; }
      }
      const result = await checked(base);
      if (action === 'space-list') {
        if (input.query !== undefined) {
          const found = await remote('search-annotations', {
            parent:result.parent || '', query:input.query, space_id:'personal', filesOnly:true, limit:100,
            ...(input.after !== undefined ? {after:input.after} : {}),
          });
          return {...result, searchAvailable:true,
            search:{nextCursor:found.nextCursor || null, scanLimited:found.scanLimited === true},
            items:found.items.filter(entry => entry.kind === 'file' && entry.trashed == null).map(entry => ({
              ...service.describeSpaceItem(entry), tags:entry.annotation?.tags || [], folderPath:entry.folder_path || '',
            }))};
        }

        let listing;
        try { listing = await remote('list', {parent:input.parent || '', space_id:'personal'}); }
        catch { check(); return result; }
        const annotations = new Map((listing?.items || []).filter(entry => entry.trashed == null && entry.annotation)
          .map(entry => [entry.id, entry]));
        return {...result, searchAvailable:true, items:result.items.map(item => {
          const entry = annotations.get(item.id);
          if (!entry || entry.kind !== item.kind || entry.digest !== item.digest || entry.name !== item.name) return item;
          return {...item, tags:entry.annotation.tags || [], description:entry.annotation.description || ''};
        })};
      }
      if (action === 'select-space-files') {
        const staged = [];
        for (const file of result || []) {
          const selection = input.entries.find(entry => entry.id === file.spaceId);
          if (!selection) throw Object.assign(Error('SPACE_REMOTE_FILE_CHANGED'), {code:'SPACE_REMOTE_FILE_CHANGED'});
          if (selections.has(file.handle)) continue;
          const entry = await remote('stat', {id:file.spaceId, space_id:'personal'});
          if (entry.id !== selection.id || entry.digest !== selection.digest || entry.trashed != null)
            throw Object.assign(Error('SPACE_REMOTE_FILE_CHANGED'), {code:'SPACE_REMOTE_FILE_CHANGED'});
          let annotation, annotationSelection;
          try {
            annotation = entry.annotation || await remote('annotation', {id:entry.id, space_id:'personal'});
            annotation = importedAnnotationSnapshot({snapshot:annotation,annotationRevision:annotation?.revision});
            if (!annotation) throw Object.assign(Error('SPACE_ANNOTATION_UNAVAILABLE'), {code:'SPACE_ANNOTATION_UNAVAILABLE'});
          }
          catch (error) {
            check();
            annotationSelection = {status:'pending', code:error.code || 'SPACE_ANNOTATION_UNAVAILABLE'};
          }
          staged.push([file.handle, {id:entry.id, space_id:'personal', digest:entry.digest,
            warehouseId:input.warehouseId, annotationRevision:annotation?.revision || 0, snapshot:annotation, annotationSelection},
            entry.annotationError ? null : entry.folder_path]);
        }
        for (const [handle, selection] of staged) {
          if (!selections.has(handle)) selections.set(handle, selection);
        }
        const folderPaths = new Map(staged.map(([handle, , folderPath]) => [handle, folderPath]));
        return result.map(file => ({...file,
          sourceAnnotation:structuredClone(selections.get(file.handle)?.snapshot),
          ...(selections.get(file.handle)?.annotationSelection ? {annotationSelection:selections.get(file.handle).annotationSelection} : {}),
          ...(folderPaths.get(file.handle) ? {folderPath:folderPaths.get(file.handle)} : {})}));
      }
      if (action === 'upload') {
        const selection = selections.get(input.handle);
        if (!selection || selection.warehouseId !== input.warehouseId || !resource(result?.document?.id)) return result;
        try {
          // Persist the observed commit before any further network read. A new
          // session can finish indexing it without the old upload handle.
          await stageImport(receiptInput({...selection, documentId:result.document.id}));
          const annotation = requiredSnapshot(selection);
          const entry = await remote('stat', {id:selection.id, space_id:selection.space_id});
          if (entry.digest !== selection.digest || entry.trashed != null)
            throw Object.assign(Error('SPACE_REMOTE_FILE_CHANGED'), {code:'SPACE_REMOTE_FILE_CHANGED'});
          let versionId = currentVersion(result);
          if (!resource(versionId)) {
            const observed = await document({...selection, documentId:result.document.id});
            versionId = observed?.versionId;
          }
          if (!resource(versionId)) throw Object.assign(Error('SPACE_ANNOTATION_DOCUMENT_PENDING'), {code:'SPACE_ANNOTATION_DOCUMENT_PENDING'});
          await remote('annotation-bind', {...receiptInput({...selection, snapshot:annotation,
            documentId:result.document.id}), versionId});
          const annotationSync = await syncStarlinkAnnotation({service,check,binding:{...selection,
            snapshot:annotation,
            documentId:result.document.id,versionId}});
          return {...result, sourceAnnotation:annotation, annotationIndex:{status:'saved'},annotationSync};
        } catch (error) {
          check();
          // The import itself committed. The same handle can retry locally;
          // a durable staged receipt can also recover in a later session.
          const status=error.code==='SPACE_ANNOTATION_SNAPSHOT_MISSING'?'missing_snapshot':
            error.code==='SPACE_ANNOTATION_DOCUMENT_CHANGED'?'stale':'pending';
          return {...result, sourceAnnotation:selection.snapshot, annotationIndex:{status, code:error.code || 'SPACE_ANNOTATION_WRITE_FAILED'},
            ...(status!=='pending'?{annotationSync:{status,code:error.code}}:{})};
        }
      }
      if (!input.warehouseId) return result;
      const query = action === 'search' && typeof input.query === 'string' ? input.query.trim().toLocaleLowerCase() : '';
      let imports;
      try { imports = await bindings(input.warehouseId); }
      catch (error) { check(); return {...result, annotationSearch:{incomplete:true, code:error.code || 'SPACE_ANNOTATION_UNAVAILABLE'}}; }
      if (action === 'document') {
        const binding = imports.find(item => item.documentId === input.id);
        if (!binding) {
          const receipt = recovery.remaining.find(item => item.documentId === input.id);
          const snapshot=receipt?importedAnnotationSnapshot(receipt):null;
          const status=receipt&&!snapshot?'missing_snapshot':
            recovery.code==='SPACE_ANNOTATION_DOCUMENT_CHANGED'?'stale':'pending';
          return receipt ? {...result, annotationIndex:{status, code:recovery.code},annotationSync:{status,code:recovery.code},
            sourceAnnotation:{snapshot, current:null, needsRefresh:true, indexStatus:status}} :
            {...result,...await readStarlinkAnnotation({service,warehouseId:input.warehouseId,documentId:input.id,
              versionId:currentVersion(result),check})};
        }
        try {
          const snapshot=importedAnnotationSnapshot(binding);
          const current = snapshot ? await source(binding) : null;
          const matches = current && !!binding.versionId && binding.versionId === currentVersion(result);
          const annotationSync = !snapshot ? {status:'missing_snapshot',code:'SPACE_ANNOTATION_SNAPSHOT_MISSING'} :
            matches ? await syncStarlinkAnnotation({service,binding,check}) : {status:'stale'};
          return {...result, annotationSync, annotationIndex:{status:snapshot?'saved':'missing_snapshot'},
            sourceAnnotation:{snapshot,current:null,needsRefresh:!matches,
              ...(current?.entry.folder_path ? {folderPath:current.entry.folder_path} : {})}};
        } catch (error) { check(); return {...result, annotationSync:{status:'stale',code:error.code},
          sourceAnnotation:{snapshot:importedAnnotationSnapshot(binding), current:null, needsRefresh:true, code:error.code}}; }
      }
      // Older servers apply delivery protection and type filters only to their
      // own evidence. A raw document read cannot reproduce those constraints.
      if (!query || result?.sensitive || input.entityTypes?.length) return result;
      const resultKey = Array.isArray(result?.items) ? 'items' : 'results';
      const nativeResults = result?.[resultKey] || [];
      const documents = [], seen = new Set(nativeResults.map(item => item.document_id).filter(Boolean));
      const resultVersions = new Set(nativeResults.map(item => JSON.stringify([item.document_id, item.document_version_id || item.version_id])));
      const spaceStatuses = new Map();
      await Promise.all(imports.filter(binding => binding.versionId && resultVersions.has(JSON.stringify([binding.documentId, binding.versionId])))
        .map(async binding => {
          try {
            const entry = await remote('stat', {id:binding.id, space_id:binding.space_id});
            if (entry.id === binding.id && entry.kind === 'file' && entry.trashed == null &&
                (!entry.space_id || entry.space_id === binding.space_id) && entry.digest) {
              spaceStatuses.set(binding.documentId, {version:binding.versionId,
                status:entry.digest === binding.digest ? 'current' : 'updated',
                folderPath:entry.annotationError ? null : entry.folder_path});
            }
          } catch { check(); }
        }));
      const markedResults = nativeResults.map(item => {
        const observed = spaceStatuses.get(item.document_id);
        return observed && observed.version === (item.document_version_id || item.version_id)
          ? {...item, spaceSourceStatus:observed.status, ...(observed.folderPath ? {spaceFolderPath:observed.folderPath} : {})} : item;
      });
      const {remaining, ...recoveryStatus} = recovery;
      const candidates = imports.filter(binding => resource(binding.documentId) &&
        (!input.documentIds?.length || input.documentIds.includes(binding.documentId)));
      const cursorPrefix = createHash('sha256').update(JSON.stringify([input.warehouseId, query,
        candidates.map(({documentId,versionId,digest}) => [documentId,versionId,digest])])).digest('hex');
      const cursor = input.annotationAfter;
      let offset = 0;
      if (cursor !== undefined) {
        offset = typeof cursor === 'string' && cursor.length <= 193 && cursor.startsWith(cursorPrefix+'.')
          ? candidates.findIndex(binding => binding.documentId === cursor.slice(65)) + 1 : 0;
        if (!offset) throw Object.assign(Error('SPACE_TAG_RESULTS_CHANGED'), {code:'SPACE_TAG_RESULTS_CHANGED'});
      }
      const diagnostics = {...recoveryStatus, scanned:0, nextCursor:null};
      while (offset < candidates.length && diagnostics.scanned < 200 && documents.length < 10) {
        const binding = candidates[offset++];
        if (seen.has(binding.documentId)) continue;
        try {
          const annotation = importedAnnotationSnapshot(binding);
          if (!annotationMatches(annotation, query)) continue;
          diagnostics.scanned++;
          const current = await source(binding);
          if (!current) continue;
          const observed = await document(binding);
          if (!observed) continue;
          // Revalidate the source digest after the warehouse read so content that
          // changed mid-flight cannot publish an annotation hit.
          const after = await source(binding);
          if (!after) continue;
          // The owner document API supplies identity and version. Search excerpts
          // belong to the warehouse's protected evidence path.
          seen.add(binding.documentId);
          documents.push({documentId:binding.documentId, versionId:observed.versionId,
            title:observed.result.document.original_name || current.entry.name,
            ...(current.entry.folder_path ? {folderPath:current.entry.folder_path} : {}),
            annotation});
        } catch (error) {
          check(); diagnostics.incomplete = true; diagnostics.code ||= error.code || 'SPACE_ANNOTATION_READ_FAILED';
        }
      }
      if (offset < candidates.length) diagnostics.nextCursor = cursorPrefix+'.'+candidates[offset-1].documentId;
      diagnostics.verificationIncomplete = diagnostics.incomplete;
      diagnostics.incomplete ||= !!diagnostics.nextCursor;
      return {...result, ...(Array.isArray(result?.[resultKey]) ? {[resultKey]:markedResults} : {}),
        annotationDocuments:documents, annotationSearch:diagnostics};
    },
  };
}
