import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createStarlinkSpaceAnnotations} from '../../builder/integration/personal-client/starlink-space-annotations.mjs';

const warehouseId = '10000000-0000-4000-8000-000000000001';
const otherWarehouseId = '20000000-0000-4000-8000-000000000002';
const fileId = 'a'.repeat(32), documentId = 'document_1', versionId = 'version_1';
const text = '专用合成测试正文：此资料记录五月交付日期。';
const tag = '橙色松鼠';

function fixture() {
  const annotation = {tags:[tag], description:'合成测试分类', revision:2, needsReview:false,
    provenance:[{tag, source:'inherited', itemId:'b'.repeat(32)}]};
  let entry = {id:fileId, name:'test.txt', digest:'digest-1', kind:'file', space_id:'personal', annotation};
  let detail = {document:{id:documentId, original_name:'test.txt', active_version_id:versionId, status:'ready', warehouse_id:warehouseId},
    version:{id:versionId, version_number:1}, segments:[{id:'segment_1', text, source_locator:{page:1}}]};
  let active = true, failBinding = false, failStage = false, detailHook = null, textVersion = versionId, denied = false;
  let uploadResult = {document:{id:documentId, active_version_id:versionId}};
  const records = [], receipts = [], calls = [];
  const check = () => { if (!active) throw Object.assign(Error('HOST_SESSION_EXPIRED'), {code:'HOST_SESSION_EXPIRED'}); };
  const space = {async operation(action, input) {
    calls.push({kind:'space', action, input});
    if (action === 'search-annotations') return {items:[{...structuredClone(entry),folder_path:'nested'}],nextCursor:fileId,scanLimited:true};
    if (action === 'list') return {items:[structuredClone(entry)]};
    if (action === 'stat') { if (denied) throw Object.assign(Error('SPACE_FORBIDDEN'), {code:'SPACE_FORBIDDEN', status:403}); return structuredClone(entry); }
    if (action === 'annotation-imports') return structuredClone(records);
    if (action === 'annotation-pending-imports') return structuredClone(receipts);
    if (action === 'annotation-stage-import') {
      if (failStage) throw Object.assign(Error('SECURE_STORAGE_WRITE_FAILED'), {code:'SECURE_STORAGE_WRITE_FAILED'});
      receipts.splice(0, receipts.length, structuredClone(input)); return {saved:true};
    }
    if (action === 'annotation') {
      if (!entry.annotation) throw Object.assign(Error('SPACE_ANNOTATION_UNAVAILABLE'), {code:'SPACE_ANNOTATION_UNAVAILABLE'});
      return structuredClone(entry.annotation);
    }
    if (action === 'annotation-bind') {
      if (failBinding) throw Object.assign(Error('SECURE_STORAGE_WRITE_FAILED'), {code:'SECURE_STORAGE_WRITE_FAILED'});
      records.splice(0, records.length, structuredClone(input)); receipts.splice(0); return {saved:true};
    }
    throw Error(action);
  }};
  const service = {
    describeSpaceItem({id,name,kind,digest}) { return {id,name,kind,digest,format:'txt',problem:null}; },
    async call(action, input) {
      calls.push({kind:'starlink', action, input});
      assert.equal(action, 'document');
      if (detailHook) await detailHook();
      return structuredClone(detail);
    },
    async api(path) { calls.push({kind:'starlink', path}); throw Error('Unexpected raw source read'); },
  };
  const create = () => createStarlinkSpaceAnnotations({space, service, check});
  let decorator = create();
  return {
    get decorator() { return decorator; }, restart() { active = true; decorator = create(); }, records, receipts, calls, annotation, service,
    setEntry(value) { entry = {...entry, ...value}; }, setDetail(value) { detail = value; }, get detail() { return detail; },
    failBinding(value) { failBinding = value; }, detailHook(value) { detailHook = value; }, expire() { active = false; },
    failStage(value) { failStage = value; }, deny(value) { denied = value; },
    uploadResponse(value) { uploadResult = value; },
    async select() {
      return decorator.run('select-space-files', {warehouseId, entries:[{id:fileId, digest:'digest-1'}]},
        async () => [{handle:'handle_1', spaceId:fileId, name:'test.txt', source:'space'}]);
    },
    async upload() { return decorator.run('upload', {warehouseId, handle:'handle_1'}, async () => structuredClone(uploadResult)); },
    async search(query = tag, input = {}) { return decorator.run('search', {warehouseId, query, ...input}, async () => ({items:[]})); },
  };
}

test('the Space picker only shows annotations from matching current entries', async () => {
  const f = fixture();
  const matching = {id:fileId, name:'test.txt', digest:'digest-1', kind:'file'};
  const stale = {...matching, digest:'old-digest'};
  const other = {...matching, id:'c'.repeat(32)};
  const items = [matching, stale, other];
  const result = await f.decorator.run('space-list', {parent:'folder-1'}, async () => ({items}));
  assert.deepEqual(result.items, [{...matching, tags:[tag], description:'合成测试分类'}, stale, other]);
  assert.deepEqual(f.calls, [{kind:'space', action:'list', input:{parent:'folder-1', space_id:'personal'}}]);
});

test('the Starlink Space search stays inside the requested folder and reports a partial result', async () => {
  const f = fixture();
  const result = await f.decorator.run('space-list', {parent:'folder-1',query:tag,after:'b'.repeat(32)}, async () => ({
    parent:'folder-1',breadcrumbs:[],items:[],
  }));
  assert.deepEqual(result.search,{nextCursor:fileId,scanLimited:true});
  assert.deepEqual(result.items,[{id:fileId,name:'test.txt',kind:'file',digest:'digest-1',
    format:'txt',problem:null,tags:[tag],folderPath:'nested'}]);
  assert.deepEqual(f.calls,[{kind:'space',action:'search-annotations',
    input:{parent:'folder-1',query:tag,space_id:'personal',filesOnly:true,limit:100,after:'b'.repeat(32)}}]);
});

test('tag search pages through verified material versions and rejects a stale cursor', async () => {
  const records = Array.from({length:23}, (_, i) => ({id:`file-${i}`, documentId:`doc-${i}`,
    versionId:`version-${i}`, warehouseId, space_id:'personal', digest:'same', annotationRevision:1,
    snapshot:{tags:[tag], description:'', provenance:[], revision:1, needsReview:false}}));
  const space = {async operation(action, input) {
    if (action === 'annotation-imports') return records;
    if (action === 'annotation-pending-imports') return [];
    assert.equal(action, 'stat');
    return {id:input.id, kind:'file', digest:'same', name:'test.txt', annotation:{tags:[tag], revision:1}};
  }};
  const service = {async call(action, {id}) {
    assert.equal(action, 'document');
    const record = records.find(row => row.documentId === id);
    return {document:{id, status:'ready', warehouse_id:warehouseId}, version:{id:record.versionId}};
  }};
  const link = createStarlinkSpaceAnnotations({space, service, check() {}});
  const search = (query, annotationAfter) => link.run('search', {warehouseId, query, annotationAfter},
    async () => ({items:[{document_id:'doc-0'}]}));
  const first = await search(tag);
  const second = await search(tag, first.annotationSearch.nextCursor);
  const last = await search(tag, second.annotationSearch.nextCursor);
  assert.deepEqual([first, second, last].map(result => result.annotationDocuments.length), [10,10,2]);
  assert.equal(first.annotationSearch.verificationIncomplete, false);
  assert.equal(last.annotationSearch.nextCursor, null);
  assert.deepEqual([first, second, last].flatMap(result => result.annotationDocuments.map(row => [row.documentId,row.versionId])),
    records.slice(1).map(row => [row.documentId,row.versionId]));
  await assert.rejects(search('另一个标签', first.annotationSearch.nextCursor), {code:'SPACE_TAG_RESULTS_CHANGED'});
  records[12] = {...records[12], versionId:'new-version'};
  await assert.rejects(search(tag, first.annotationSearch.nextCursor), {code:'SPACE_TAG_RESULTS_CHANGED'});
});

test('space tag snapshot survives importer restart and recalls real Starlink text with real document version', async () => {
  const f = fixture();
  const files = await f.select();
  assert.deepEqual(files[0].sourceAnnotation.provenance, f.annotation.provenance);
  assert.equal((await f.upload()).annotationIndex.status, 'saved');
  assert.equal(f.records[0].snapshot.tags[0], tag);
  f.restart();
  const result = await f.search();
  assert.equal(result.items.length, 0);
  assert.equal(result.annotationDocuments.length, 1);
  assert.deepEqual(result.annotationDocuments[0], {documentId, versionId, title:'test.txt', annotation:f.annotation});
  assert.equal(Object.hasOwn(result.annotationDocuments[0], 'evidenceId'), false);
  assert.equal(text.includes(tag), false, 'the hit is supplied only by the source annotation');
});

test('Space edits do not replace imported tags, description or review state in recall', async () => {
  const f = fixture(); await f.select(); await f.upload();
  f.setEntry({annotation:{...f.annotation, tags:['蓝鲸'], revision:3}});
  assert.equal((await f.search()).annotationDocuments.length, 1);
  assert.equal((await f.search('蓝鲸')).annotationDocuments.length, 0);
  assert.equal((await f.search(f.annotation.description)).annotationDocuments.length, 1);
  f.setEntry({annotation:{...f.annotation, needsReview:true}});
  assert.equal((await f.search()).annotationDocuments.length, 1);
  f.setEntry({annotation:f.annotation, digest:'digest-2'});
  assert.equal((await f.search()).annotationDocuments.length, 0);
});

test('a shorter stored tag does not match a different, longer tag query', async () => {
  const f = fixture();
  f.setEntry({annotation:{...f.annotation, tags:['木杉项目']}});
  await f.select();
  await f.upload();

  assert.equal((await f.search('木杉项目')).annotationDocuments.length, 1);
  assert.deepEqual((await f.search('木杉项目记录')).annotationDocuments, []);
});

test('native search identifies earlier and current Space imports without changing excerpts', async () => {
  const f = fixture();
  await f.select();
  await f.upload();
  const previous = {document_id:documentId, document_version_id:versionId, text:'五月十八日'};
  const current = {document_id:'new-document', document_version_id:'new-version', text:'六月九日'};
  const unbound = {...current, document_version_id:'another-version'};
  f.records.push({...f.records[0], documentId:current.document_id, versionId:current.document_version_id, digest:'digest-2'});
  f.setEntry({digest:'digest-2'});
  const items = [previous, current, unbound];
  const search = () => f.decorator.run('search', {warehouseId, query:'交付'}, async () => ({items}));
  assert.deepEqual((await search()).items, [
    {...previous, spaceSourceStatus:'updated'}, {...current, spaceSourceStatus:'current'}, unbound,
  ]);
  f.setEntry({folder_path:'教务 / 春季'});
  assert.deepEqual((await search()).items, [
    {...previous, spaceSourceStatus:'updated', spaceFolderPath:'教务 / 春季'},
    {...current, spaceSourceStatus:'current', spaceFolderPath:'教务 / 春季'}, unbound,
  ]);
  f.deny(true);
  assert.deepEqual((await search()).items, items);
});

test('warehouse filters and explicit document filters are preserved for annotation recall', async () => {
  const f = fixture(); await f.select(); await f.upload();
  assert.equal((await f.search(tag, {warehouseId:otherWarehouseId})).annotationDocuments.length, 0);
  assert.equal((await f.search(tag, {documentIds:['other-document']})).annotationDocuments.length, 0);
  assert.equal(f.calls.filter(call => call.kind === 'starlink' && call.action === 'document').length, 0);
});

test('legacy annotation recall preserves delivery protection and explicit graph type filters', async () => {
  const f = fixture();
  await f.select();
  await f.upload();
  const native = {items:[], sensitive:{status:'detection_pending', withheld:1}};
  const from = f.calls.length;
  assert.deepEqual(await f.decorator.run('search', {warehouseId, query:tag}, async () => native), native);
  assert.deepEqual(await f.search(tag, {entityTypes:['Person']}), {items:[]});
  assert.equal(f.calls.slice(from).some(call => call.kind === 'starlink'), false);
});

test('changed warehouse document versions and wrong source IDs are excluded', async () => {
  const f = fixture(); await f.select(); await f.upload();
  f.setDetail({...f.detail, version:{id:'version_2'}});
  assert.equal((await f.search()).annotationDocuments.length, 0);
  f.setDetail({...f.detail, version:{id:versionId}, document:{...f.detail.document, id:'other-document'}});
  assert.equal((await f.search()).annotationDocuments.length, 0);
});

test('late source content changes and account changes cannot publish annotation text', async () => {
  const f = fixture(); await f.select(); await f.upload();
  f.detailHook(() => f.setEntry({digest:'digest-2'}));
  assert.equal((await f.search()).annotationDocuments.length, 0);
  f.setEntry({digest:'digest-1'});
  f.detailHook(() => f.expire());
  await assert.rejects(f.search(), {code:'HOST_SESSION_EXPIRED'});
});

test('binding write failure is reported after committed import and the same handle can retry it', async () => {
  const f = fixture(); await f.select(); f.failBinding(true);
  const pending = await f.upload();
  assert.equal(pending.document.id, documentId);
  assert.deepEqual(pending.annotationIndex, {status:'pending', code:'SECURE_STORAGE_WRITE_FAILED'});
  assert.equal(f.records.length, 0);
  f.failBinding(false);
  assert.equal((await f.upload()).annotationIndex.status, 'saved');
  assert.equal(f.records.length, 1);
});

test('an asynchronous import binds only a real observed version and exposes pending state until ready', async () => {
  const f = fixture(); await f.select();
  f.uploadResponse({document:{id:documentId}});
  const ready = f.detail;
  f.setDetail({document:{id:documentId, status:'processing'}, segments:[]});
  assert.deepEqual((await f.upload()).annotationIndex, {status:'pending', code:'SPACE_ANNOTATION_DOCUMENT_PENDING'});
  assert.equal(f.records.length, 0);
  f.setDetail(ready);
  assert.equal((await f.upload()).annotationIndex.status, 'saved');
  assert.equal(f.records[0].versionId, versionId);
});

test('durable commit receipts recover pending imports in a new session without selecting or uploading again', async () => {
  const f = fixture(); await f.select(); f.uploadResponse({document:{id:documentId}});
  const ready = f.detail;
  f.setDetail({document:{id:documentId, status:'processing'}, segments:[]});
  assert.equal((await f.upload()).annotationIndex.status, 'pending');
  assert.equal(f.receipts.length, 1);
  assert.equal(f.records.length, 0);
  f.restart(); f.setDetail(ready);
  const result = await f.search();
  assert.equal(result.annotationDocuments[0].documentId, documentId);
  assert.equal(Object.hasOwn(result.annotationDocuments[0], 'text'), false);
  assert.equal(result.annotationSearch.recoveredImports, 1);
  assert.equal(result.annotationSearch.pendingImports, 0);
  assert.equal(f.receipts.length, 0);
  assert.equal(f.records[0].versionId, versionId);
  assert.equal(f.calls.filter(call => call.action === 'annotation-stage-import').length, 1);
});

test('pending receipt recovery retains failed permissions and invalid sessions without publishing document text', async () => {
  const f = fixture(); await f.select(); f.failBinding(true); await f.upload(); f.failBinding(false); f.restart();
  f.deny(true);
  const denied = await f.search();
  assert.deepEqual(denied.annotationDocuments, []);
  assert.equal(denied.annotationSearch.incomplete, true);
  assert.equal(f.receipts.length, 1); assert.equal(f.records.length, 0);
  f.deny(false); f.detailHook(() => f.expire());
  await assert.rejects(f.search(), {code:'HOST_SESSION_EXPIRED'});
  assert.equal(f.receipts.length, 1); assert.equal(f.records.length, 0);
});

test('later import receipts recover even when the first 200 lack snapshots', async () => {
  const f = fixture();
  await f.select(); f.failBinding(true); await f.upload(); f.failBinding(false);
  const valid = f.receipts[0];
  const blocked = Array.from({length:200}, (_, index) => ({
    ...valid, documentId:'old_' + index, snapshot:undefined, annotationRevision:0,
  }));
  f.receipts.unshift(...blocked);
  assert.equal((await f.search()).annotationSearch.recoveredImports, 0);
  assert.equal((await f.search()).annotationSearch.recoveredImports, 1);
  assert.deepEqual(f.records.map(row => row.documentId), [valid.documentId]);
});

test('a pending import cannot attach its annotation to a corrected document version', async () => {
  const f = fixture();
  await f.select();
  f.failBinding(true);
  assert.equal((await f.upload()).annotationIndex.status, 'pending');
  f.restart(); f.failBinding(false);
  f.setDetail({...f.detail, document:{...f.detail.document, active_version_id:'corrected'},
    version:{id:'corrected', version_number:2}});
  const material = await f.decorator.run('document', {warehouseId, id:documentId}, async () => f.detail);
  assert.equal(material.annotationSync.status, 'stale');
  assert.equal(material.version.id, 'corrected');
  assert.deepEqual(material.sourceAnnotation.snapshot.tags, [tag]);
  assert.equal(f.records.length, 0);
  assert.equal(f.receipts.length, 1);
});

test('a pending import waits for proof of the original document version', async () => {
  const f = fixture();
  await f.select();
  f.failBinding(true);
  await f.upload();
  f.restart();
  f.failBinding(false);
  const ready = f.detail;
  f.setDetail({...ready, version:{id:versionId}});
  const read = () => f.decorator.run('document', {warehouseId, id:documentId}, async () => f.detail);
  const pending = await read();
  assert.deepEqual(pending.annotationIndex, {status:'pending', code:'SPACE_ANNOTATION_DOCUMENT_PENDING'});
  assert.equal(f.records.length, 0);
  assert.equal(f.receipts.length, 1);
  f.setDetail(ready);
  assert.equal((await read()).annotationIndex.status, 'saved');
  assert.equal(f.records[0].versionId, versionId);
  assert.equal(f.receipts.length, 0);
});

test('staging failure stops followup network reads, exposes pending, and can retry the committed handle', async () => {
  const f = fixture(); await f.select(); f.failStage(true);
  const before = f.calls.length, pending = await f.upload();
  assert.deepEqual(pending.annotationIndex, {status:'pending', code:'SECURE_STORAGE_WRITE_FAILED'});
  assert.deepEqual(f.calls.slice(before).map(call => call.action), ['annotation-stage-import']);
  assert.equal(f.receipts.length, 0); assert.equal(f.records.length, 0);
  f.failStage(false); assert.equal((await f.upload()).annotationIndex.status, 'saved');
});

test('missing segments still allow an authorized reference without requesting raw text', async () => {
  const f = fixture(); await f.select(); await f.upload();
  f.setDetail({...f.detail, segments:[]});
  assert.equal((await f.search()).annotationDocuments[0].versionId, versionId);
  assert.equal(f.calls.some(call => call.path), false);
  f.setDetail({...f.detail, version:{id:'version_2'}});
  assert.equal((await f.search()).annotationDocuments.length, 0);
});

test('document details keep the original snapshot after Space metadata changes', async () => {
  const f = fixture(); await f.select(); await f.upload();
  const call = () => f.decorator.run('document', {warehouseId, id:documentId}, async () => f.detail);
  assert.equal((await call()).sourceAnnotation.needsRefresh, false);
  f.setEntry({annotation:{...f.annotation, revision:3, tags:['蓝鲸']}});
  const changed = await call();
  assert.equal(changed.sourceAnnotation.needsRefresh, false);
  assert.deepEqual(changed.sourceAnnotation.snapshot.tags, [tag]);
  assert.equal(changed.sourceAnnotation.current, null);
});

test('inherited label changes never replace the imported provenance, including changes during a read', async () => {
  const f = fixture(); await f.select(); await f.upload();
  f.setEntry({annotation:{...f.annotation, tags:[tag, '蓝鲸'], provenance:[...f.annotation.provenance,
    {tag:'蓝鲸', source:'inherited', itemId:'b'.repeat(32)}]}});
  const detail = await f.decorator.run('document', {warehouseId, id:documentId}, async () => f.detail);
  assert.equal(detail.sourceAnnotation.snapshot.revision, f.annotation.revision);
  assert.equal(detail.sourceAnnotation.current, null);
  assert.equal(detail.sourceAnnotation.needsRefresh, false);
  f.setEntry({annotation:f.annotation});
  f.detailHook(() => f.setEntry({annotation:{...f.annotation, tags:[tag, '蓝鲸']}}));
  assert.equal((await f.search()).annotationDocuments.length, 1);
  assert.equal((await f.search('蓝鲸')).annotationDocuments.length, 0);
});

test('native results are preserved and do not get a duplicate annotation document', async () => {
  const f = fixture(); await f.select(); await f.upload();
  const item = {evidence_id:'evidence_1', document_id:documentId, text};
  const result = await f.decorator.run('search', {warehouseId, query:tag}, async () => ({items:[item]}));
  assert.deepEqual(result.items, [item]);
  assert.deepEqual(result.annotationDocuments, []);
});

test('an importer without annotation persistence keeps existing Starlink behavior', async () => {
  const original = {items:[{id:'original-evidence'}]};
  const result = await createStarlinkSpaceAnnotations({check:() => {}}).run('search', {warehouseId, query:tag}, async () => original);
  assert.equal(result, original);
});

test('capable warehouse search stays on the server and rejects any broadened strict response', async () => {
  const f = fixture();
  f.service.capabilities = {source_annotations:{search_version:1}};
  const calls = [];
  let reply = {items:[], annotationDocuments:[], annotationSearch:{filtered:true,emptyScope:true}};
  f.service.api = async (path, options) => { calls.push({path, options}); return reply; };
  const input = {warehouseId, query:'', annotationSearch:{tags:['甲,乙'],match:'all'}};
  const run = () => f.decorator.run('search', input, async () => assert.fail('legacy search must not run'));
  assert.deepEqual(await run(), reply);
  assert.deepEqual(calls[0].options.body.annotation_search, input.annotationSearch);
  assert.equal(calls[0].path, '/warehouses/' + warehouseId + '/search');
  assert.equal(f.calls.length, 0, 'new servers do not scan Space bindings for search');
  reply = {items:[{id:'foreign'}]};
  await assert.rejects(run, {code:'SEMANTICA_ANNOTATION_SEARCH_UNAVAILABLE'});
  f.service.capabilities = {};
  await assert.rejects(run, {code:'SEMANTICA_ANNOTATION_SEARCH_UNAVAILABLE'});
});

test('committed local bindings retry failed server metadata after restart without another file upload', async () => {
  const f = fixture();
  f.service.capabilities={source_annotations:{version:1}};
  let fail=true, writes=0, written;
  f.service.api=async (_path, options={})=>{
    if(fail)throw Object.assign(Error('offline'),{code:'SEMANTICA_CONNECTION_FAILED'});
    if(options.method==='PUT') {
      writes++;
      written=options.body;
      return {document_id:documentId,document_version_id:versionId,revision:1,index_status:'not_indexed'};
    }
    return {document_id:documentId,revision:0,annotation:null};
  };
  await f.select(); const uploaded=await f.upload();
  assert.equal(uploaded.document.id,documentId);
  assert.equal(uploaded.annotationIndex.status,'saved');
  assert.equal(uploaded.annotationSync.status,'pending');
  assert.equal(f.records.length,1);
  f.setEntry({annotation:{...f.annotation,revision:3,tags:['后续标签'],description:'后续说明',needsReview:true}});
  f.restart();fail=false;
  const detail=await f.decorator.run('document',{warehouseId,id:documentId},async()=>f.detail);
  assert.equal(detail.annotationSync.status,'saved');
  assert.equal(writes,1);
  assert.deepEqual(written.tags,f.annotation.tags);
  assert.equal(written.description,f.annotation.description);
  assert.equal(written.source.revision,f.annotation.revision);
  assert.equal(written.needs_review,false);
  assert.equal(detail.sourceAnnotation.needsRefresh,false);
});

test('chooser results cannot mutate the saved import snapshot and upload never refreshes annotations',async()=>{
  const f=fixture(), [selected]=await f.select();
  selected.sourceAnnotation.tags.push('客户端临时修改');
  selected.sourceAnnotation.description='预览对象被修改';
  f.setEntry({annotation:{...f.annotation,revision:8,tags:['空间新标签'],description:'空间新说明'}});
  const before=f.calls.length;
  const uploaded=await f.upload();
  assert.deepEqual(uploaded.sourceAnnotation,f.annotation);
  assert.deepEqual(f.records[0].snapshot,f.annotation);
  assert.equal(f.calls.slice(before).some(row=>row.action==='annotation'),false);
  f.restart();
  assert.equal((await f.search()).annotationDocuments.length,1);
  assert.equal((await f.search('空间新标签')).annotationDocuments.length,0);
  assert.equal((await f.search('客户端临时修改')).annotationDocuments.length,0);
});

test('a failed local bind recovers its old snapshot even if the Space annotation service is unavailable',async()=>{
  const f=fixture();await f.select();f.failBinding(true);await f.upload();
  f.setEntry({annotation:undefined});f.failBinding(false);f.restart();
  const before=f.calls.length, result=await f.search();
  assert.deepEqual(result.annotationDocuments[0].annotation,f.annotation);
  assert.deepEqual(f.records[0].snapshot,f.annotation);
  assert.equal(f.receipts.length,0);
  assert.equal(f.calls.slice(before).some(row=>row.action==='annotation'),false);
});

test('legacy bindings without snapshots keep native search and skip current Space labels',async()=>{
  const f=fixture();await f.select();await f.upload();delete f.records[0].snapshot;
  const laterTag = '导入后的标签';
  f.setEntry({annotation:{...f.annotation, tags:[laterTag], revision:f.annotation.revision+1}});
  f.service.capabilities={source_annotations:{version:1}};
  f.service.api=async()=>{throw Error('must not read or write server metadata without snapshot');};
  const item={id:'native_evidence',document_id:'native_document',text};
  const before=f.calls.length;
  const result=await f.decorator.run('search',{warehouseId,query:laterTag},async()=>({items:[item]}));
  assert.deepEqual(result.items,[item]);
  assert.deepEqual(result.annotationDocuments,[]);
  assert.equal(f.calls.slice(before).some(row=>row.action==='stat'||row.action==='document'),false);
  const detail=await f.decorator.run('document',{warehouseId,id:documentId},async()=>f.detail);
  assert.equal(detail.annotationSync.status,'missing_snapshot');
  assert.equal(detail.sourceAnnotation.snapshot,null);
  assert.equal(f.calls.slice(before).some(row=>row.action==='annotation'||row.action==='annotation-bind'),false);
});

test('review-pending import snapshots cannot be activated by reviewing the later Space annotation',async()=>{
  const f=fixture();f.setEntry({annotation:{...f.annotation,needsReview:true}});
  await f.select();await f.upload();f.setEntry({annotation:f.annotation});f.restart();
  assert.deepEqual((await f.search()).annotationDocuments,[]);
});

test('missing import snapshots cannot be filled with newer Space metadata after restart', async () => {
  const f = fixture(); f.setEntry({annotation:undefined});
  const files = await f.select();
  assert.equal(files.length, 1);
  assert.equal(files[0].annotationSelection.status, 'pending');
  assert.equal((await f.upload()).annotationIndex.status, 'missing_snapshot');
  assert.equal(f.receipts.length, 1);
  f.setEntry({annotation:f.annotation}); f.restart();
  const before=f.calls.length;
  assert.deepEqual((await f.search()).annotationDocuments,[]);
  assert.equal(f.records.length, 0);
  assert.equal(f.receipts.length, 1);
  const detail=await f.decorator.run('document',{warehouseId,id:documentId},async()=>f.detail);
  assert.equal(detail.annotationSync.status,'missing_snapshot');
  assert.equal(detail.sourceAnnotation.snapshot,null);
  assert.equal(f.calls.slice(before).some(row=>row.action==='annotation'||row.action==='annotation-bind'),false);
});

test('a selection without a snapshot stays unannotated even when labels appear before upload and same-handle retry',async()=>{
  const f=fixture();f.setEntry({annotation:undefined});await f.select();
  f.setEntry({annotation:f.annotation});const before=f.calls.length;
  assert.equal((await f.upload()).annotationSync.status,'missing_snapshot');
  assert.equal((await f.upload()).annotationSync.status,'missing_snapshot');
  assert.equal(f.records.length,0);
  assert.equal(f.calls.slice(before).some(row=>row.action==='annotation'||row.action==='annotation-bind'),false);
});

for (const delayed of [false, true]) test(`synthetic Space to Starlink to Agent loop uses real client services and persisted ${delayed?'pending receipts':'inherited labels'}`, async t => {
  const [{createPersonalSpace}, {createPersonalDataService}, {createCodexContextSources}] = await Promise.all([
    import('../shell/personal-space.mjs'),
    import('../../builder/integration/personal-client/data-service.mjs'),
    import('../shell/codex-context-sources.mjs'),
  ]);
  const folderId = 'b'.repeat(32), body = Buffer.from(text), digest = createHash('sha256').update(body).digest('hex');
  const file = {id:fileId, parent:folderId, name:'test.txt', kind:'file', size:body.length, digest, modified:1, space_id:'personal'};
  const folder = {id:folderId, parent:'', name:'验收目录', kind:'folder', space_id:'personal'};
  let savedAnnotations = null, uploaded = Buffer.alloc(0), documentReady = !delayed;
  const subscribers = new Set(), requests = [];
  const state = {phase:'ready', account:{phase:'authenticated', accountId:'synthetic-owner'}, connection:{deviceId:'synthetic-box'}};
  const json = value => ({status:200, headers:{'content-type':'application/json'}, body:Buffer.from(JSON.stringify(value))});
  const client = {snapshot:() => state, subscribe(fn) { subscribers.add(fn); return () => subscribers.delete(fn); },
    async applicationConnection() { return {
      context:() => ({accountId:'synthetic-owner', boxId:'synthetic-box', user:{id:1}}), subscribe:() => () => {}, close() {},
      async request(input) {
        requests.push(input);
        if (input.path === '/api/personal-space/overview') return json({protocolVersion:1});
        if (input.path === `/api/personal-space/files/${fileId}`) return json(file);
        if (input.path === `/api/personal-space/files/${folderId}`) return json(folder);
        if (input.path.startsWith(`/api/personal-space/files/${fileId}/content?`))
          return {status:200, headers:{'x-content-sha256':digest, etag:digest}, body};
        if (input.path === '/api/semantica/capabilities') return json({accepted_suffixes:['txt']});
        const prefix = `/api/semantica/warehouses/${warehouseId}`;
        if (input.path === prefix + '/imports' && input.method === 'POST') {
          const begun = JSON.parse(input.body); assert.equal(begun.sha256, digest);
          return json({upload_handle:'import_1', offset:0});
        }
        if (input.path === prefix + '/imports/import_1' && input.method === 'PATCH') {
          const chunk = JSON.parse(input.body); assert.equal(chunk.offset, uploaded.length);
          uploaded = Buffer.concat([uploaded, Buffer.from(chunk.content_base64, 'base64')]); return json({offset:uploaded.length});
        }
        if (input.path === prefix + '/imports/import_1/commit') {
          assert.equal(uploaded.toString(), text);
          return json({document:{id:documentId, ...(!delayed?{active_version_id:versionId}:{})}});
        }
        if (input.path === prefix + '/search') {
          assert.equal(JSON.parse(input.body).query, tag); return json({items:[]});
        }
        if (input.path.startsWith(prefix + `/documents/${documentId}?`)) return json(documentReady?{
          document:{id:documentId, active_version_id:versionId, warehouse_id:warehouseId, original_name:file.name, status:'ready'},
          version:{id:versionId, version_number:1}, segments:[{id:'real_segment_1', text}],
        }:{document:{id:documentId, warehouse_id:warehouseId, status:'processing'}, segments:[]});
        throw Error('Unexpected synthetic endpoint: ' + input.path);
      },
    }; },
  };
  const annotationStore = {async load() { return structuredClone(savedAnnotations); }, async save(value) { savedAnnotations = structuredClone(value); }};
  const createSpace = () => createPersonalSpace({client, serviceURL:'https://synthetic.invalid',
    store:{async load() { return []; }, async save() {}}, annotationStore,
    chooseUploads:async () => [], chooseDownload:async () => null});
  let space = await createSpace();
  t.after(async () => space.close());
  const initial = await space.operation('annotation', {id:folderId});
  await space.operation('set-annotation', {id:folderId, expectedRevision:initial.revision, tags:[tag], description:'', reviewed:true});
  const createData = () => createPersonalDataService({client, personalSpace:space, applications:{}});
  let data = createData();
  t.after(() => data.close());
  const files = await data.action('select-space-files', {warehouseId, entries:[{id:fileId, digest}]});
  assert.equal(files[0].sourceAnnotation.provenance.find(item => item.tag === tag).source, 'inherited');
  const imported = await data.action('upload', {warehouseId, handle:files[0].handle});
  assert.equal(imported.annotationIndex.status, delayed?'pending':'saved');
  data.close(); await space.close();
  documentReady = true;
  space = await createSpace(); data = createData();
  const sources = createCodexContextSources({space, starlink:(action, input) => data.action(action, input)});
  const result = await sources.call({warehouseId}, 'starlink_search', {query:tag}, () => {});
  assert.deepEqual(result.matches, []);
  const [related] = result.relatedDocuments;
  assert.equal(related.documentId, documentId);
  assert.equal(related.versionId, versionId);
  assert.equal(Object.hasOwn(related, 'snippet'), false);
  assert.equal(Object.hasOwn(related, 'annotation'), false);
  assert.equal(JSON.stringify(result).includes(text), false);
  assert.equal(Object.hasOwn(related, 'evidenceId'), false);
  assert.equal(requests.filter(input => input.path.endsWith('/imports') && input.method === 'POST').length, 1);
});
