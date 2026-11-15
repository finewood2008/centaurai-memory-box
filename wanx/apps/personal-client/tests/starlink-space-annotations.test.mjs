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
    version:{id:versionId}, segments:[{id:'segment_1', text, source_locator:{page:1}}]};
  let active = true, failBinding = false, failStage = false, detailHook = null, textVersion = versionId, denied = false;
  let uploadResult = {document:{id:documentId, active_version_id:versionId}};
  const records = [], receipts = [], calls = [];
  const check = () => { if (!active) throw Object.assign(Error('HOST_SESSION_EXPIRED'), {code:'HOST_SESSION_EXPIRED'}); };
  const space = {async operation(action, input) {
    calls.push({kind:'space', action, input});
    if (action === 'stat') { if (denied) throw Object.assign(Error('SPACE_FORBIDDEN'), {code:'SPACE_FORBIDDEN', status:403}); return structuredClone(entry); }
    if (action === 'annotation-imports') return structuredClone(records);
    if (action === 'annotation-pending-imports') return structuredClone(receipts);
    if (action === 'annotation-stage-import') {
      if (failStage) throw Object.assign(Error('SECURE_STORAGE_WRITE_FAILED'), {code:'SECURE_STORAGE_WRITE_FAILED'});
      receipts.splice(0, receipts.length, structuredClone(input)); return {saved:true};
    }
    if (action === 'annotation') return structuredClone(entry.annotation);
    if (action === 'annotation-bind') {
      if (failBinding) throw Object.assign(Error('SECURE_STORAGE_WRITE_FAILED'), {code:'SECURE_STORAGE_WRITE_FAILED'});
      records.splice(0, records.length, structuredClone(input)); receipts.splice(0); return {saved:true};
    }
    throw Error(action);
  }};
  const service = {
    async call(action, input) {
      calls.push({kind:'starlink', action, input});
      assert.equal(action, 'document');
      if (detailHook) await detailHook();
      return structuredClone(detail);
    },
    async api(path) { calls.push({kind:'starlink', path}); return {version_id:textVersion, text}; },
  };
  const create = () => createStarlinkSpaceAnnotations({space, service, check});
  let decorator = create();
  return {
    get decorator() { return decorator; }, restart() { active = true; decorator = create(); }, records, receipts, calls, annotation,
    setEntry(value) { entry = {...entry, ...value}; }, setDetail(value) { detail = value; }, get detail() { return detail; },
    failBinding(value) { failBinding = value; }, detailHook(value) { detailHook = value; }, expire() { active = false; },
    failStage(value) { failStage = value; }, deny(value) { denied = value; },
    textVersion(value) { textVersion = value; },
    uploadResponse(value) { uploadResult = value; },
    async select() {
      return decorator.run('select-space-files', {warehouseId, entries:[{id:fileId, digest:'digest-1'}]},
        async () => [{handle:'handle_1', spaceId:fileId, name:'test.txt', source:'space'}]);
    },
    async upload() { return decorator.run('upload', {warehouseId, handle:'handle_1'}, async () => structuredClone(uploadResult)); },
    async search(query = tag, input = {}) { return decorator.run('search', {warehouseId, query, ...input}, async () => ({items:[]})); },
  };
}

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
  assert.deepEqual(result.annotationDocuments[0], {documentId, versionId, title:'test.txt', text,
    locator:{page:1}, annotation:f.annotation});
  assert.equal(Object.hasOwn(result.annotationDocuments[0], 'evidenceId'), false);
  assert.equal(text.includes(tag), false, 'the hit is supplied only by the source annotation');
});

test('current annotation changes affect recall and stale content or pending review cannot recall old labels', async () => {
  const f = fixture(); await f.select(); await f.upload();
  f.setEntry({annotation:{...f.annotation, tags:['蓝鲸'], revision:3}});
  assert.equal((await f.search()).annotationDocuments.length, 0);
  assert.equal((await f.search('蓝鲸')).annotationDocuments.length, 1);
  f.setEntry({annotation:{...f.annotation, needsReview:true}});
  assert.equal((await f.search()).annotationDocuments.length, 0);
  f.setEntry({annotation:f.annotation, digest:'digest-2'});
  assert.equal((await f.search()).annotationDocuments.length, 0);
});

test('warehouse filters and explicit document filters are preserved for annotation recall', async () => {
  const f = fixture(); await f.select(); await f.upload();
  assert.equal((await f.search(tag, {warehouseId:otherWarehouseId})).annotationDocuments.length, 0);
  assert.equal((await f.search(tag, {documentIds:['other-document']})).annotationDocuments.length, 0);
  assert.equal(f.calls.filter(call => call.kind === 'starlink' && call.action === 'document').length, 0);
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
  assert.equal(result.annotationDocuments[0].text, text);
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

test('staging failure stops followup network reads, exposes pending, and can retry the committed handle', async () => {
  const f = fixture(); await f.select(); f.failStage(true);
  const before = f.calls.length, pending = await f.upload();
  assert.deepEqual(pending.annotationIndex, {status:'pending', code:'SECURE_STORAGE_WRITE_FAILED'});
  assert.deepEqual(f.calls.slice(before).map(call => call.action), ['annotation-stage-import']);
  assert.equal(f.receipts.length, 0); assert.equal(f.records.length, 0);
  f.failStage(false); assert.equal((await f.upload()).annotationIndex.status, 'saved');
});

test('missing segments use the version pinned text API and reject an unexpected returned version', async () => {
  const f = fixture(); await f.select(); await f.upload();
  f.setDetail({...f.detail, segments:[]});
  assert.equal((await f.search()).annotationDocuments[0].text, text);
  assert.match(f.calls.find(call => call.path)?.path || '', /version_id=version_1/);
  f.textVersion('version_2');
  assert.equal((await f.search()).annotationDocuments.length, 0);
});

test('document details show snapshot, current annotation, and refresh state', async () => {
  const f = fixture(); await f.select(); await f.upload();
  const call = () => f.decorator.run('document', {warehouseId, id:documentId}, async () => f.detail);
  assert.equal((await call()).sourceAnnotation.needsRefresh, false);
  f.setEntry({annotation:{...f.annotation, revision:3, tags:['蓝鲸']}});
  const changed = await call();
  assert.equal(changed.sourceAnnotation.needsRefresh, true);
  assert.deepEqual(changed.sourceAnnotation.snapshot.tags, [tag]);
  assert.deepEqual(changed.sourceAnnotation.current.tags, ['蓝鲸']);
});

test('inherited label changes are detected even when the child annotation revision stays unchanged', async () => {
  const f = fixture(); await f.select(); await f.upload();
  f.setEntry({annotation:{...f.annotation, tags:[tag, '蓝鲸'], provenance:[...f.annotation.provenance,
    {tag:'蓝鲸', source:'inherited', itemId:'b'.repeat(32)}]}});
  const detail = await f.decorator.run('document', {warehouseId, id:documentId}, async () => f.detail);
  assert.equal(detail.sourceAnnotation.current.revision, f.annotation.revision);
  assert.equal(detail.sourceAnnotation.needsRefresh, true);
  f.setEntry({annotation:f.annotation});
  f.detailHook(() => f.setEntry({annotation:{...f.annotation, tags:[tag, '蓝鲸']}}));
  assert.equal((await f.search()).annotationDocuments.length, 0, 'late changes to a parent must not publish the earlier inherited labels');
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
          version:{id:versionId}, segments:[{id:'real_segment_1', text}],
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
  assert.equal(result.matches[0].documentId, documentId);
  assert.equal(result.matches[0].versionId, versionId);
  assert.equal(result.matches[0].snippet, text);
  assert.equal(result.matches[0].annotation.tags.includes(tag), true);
  assert.equal(Object.hasOwn(result.matches[0], 'evidenceId'), false);
  assert.equal(requests.filter(input => input.path.endsWith('/imports') && input.method === 'POST').length, 1);
});
