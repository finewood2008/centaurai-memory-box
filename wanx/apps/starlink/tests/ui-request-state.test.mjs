import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import {pendingAnnotationHTML} from '../ui/import-annotation.mjs';

const source = await readFile(new URL('../ui/app.js', import.meta.url), 'utf8');
const section = (start, end) => source.slice(source.indexOf(start), source.indexOf(end));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function fixture() {
  const nodes = new Map(), calls = [], notices = [];
  const $ = key => {
    if (!nodes.has(key)) nodes.set(key, { value: '', innerHTML: '', textContent: '', disabled: false, open: true, classList: {toggle(){}}, showModal() { this.open = true; }, replaceChildren() { this.innerHTML = ''; } });
    return nodes.get(key);
  };
  const state = { ready: true, generation: 1, warehouseId: 'warehouse', sourceRequest: 0, importContext: 'standard',
    uploading: false, spaceSelecting: false,
    importFiles: { standard: [], conversation: [] },
    get files() { return this.importFiles[this.importContext]; },
    set files(files) { this.importFiles[this.importContext] = files; },
  };
  const context = vm.createContext({ state, bridge: null, $, CSS: {escape: String}, crypto: { randomUUID }, document: { querySelectorAll: () => [] },
    currentWarehouse: () => ({ state: 'active' }), onboarding: { visible: false }, basicMaterialWarehouse: null,
    esc: value => String(value ?? ''), highlight: value => value, icon: () => '', locator: () => '', bytes: () => '', actualModel: () => '', doc: () => null,
    pendingAnnotationHTML,
    errorText: error => error.message, toast: text => notices.push(text), refresh: async () => {},
    call: (action, input) => { const pending = deferred(); calls.push({ action, input, ...pending }); return pending.promise; },
  });
  return { state, $, calls, context, notices };
}

function importFixture() {
  const h = fixture(); h.state.view = 'conversation';
  h.state.importFiles.conversation = [{ handle: 'completed-file', done: true }];
  let opened = 0;
  h.$('#import-dialog').open = false; h.$('#import-dialog').showModal = () => { opened++; h.$('#import-dialog').open = true; };
  Object.assign(h.context, { conversationFlow: { state: { loaded: true, busy: false }, saved: {} }, warehouseAction: async () => false,
    renderPending() {}, loadSpace: async () => {} });
  h.context.document.querySelectorAll = selector => selector === '[data-action="import"]' ? [h.$('#page-primary')] : [];
  vm.runInContext(section('function canCreateWarehouse()', 'function connection(') + section('async function action(', 'document.addEventListener("click"'), h.context);
  return { ...h, get opened() { return opened; } };
}

test('repeated import clicks share one opening operation and preserve its disabled state', async () => {
  const h = importFixture();
  const first = h.context.action('import'), second = h.context.action('import'); await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.calls.length, 1); assert.equal(h.$('#page-primary').disabled, true);
  h.calls[0].resolve({}); await Promise.all([first, second]);
  assert.equal(h.opened, 1); assert.equal(h.$('#page-primary').disabled, false);
});

test('leaving a page while import is opening cannot show its dialog in the new page', async () => {
  const h = importFixture();
  const opening = h.context.action('import'); await new Promise(resolve => setImmediate(resolve));
  h.state.view = 'tasks'; h.calls[0].resolve({}); await opening;
  assert.equal(h.opened, 0); assert.equal(h.$('#page-primary').disabled, false);
});

test('failed import opening releases its lock so the user can retry', async () => {
  const h = importFixture();
  const first = h.context.action('import'); await new Promise(resolve => setImmediate(resolve));
  h.calls[0].reject(Error('release failed')); await assert.rejects(first, /release failed/);
  assert.equal(h.$('#page-primary').disabled, false);
  const retry = h.context.action('import'); await new Promise(resolve => setImmediate(resolve));
  h.calls.at(-1).resolve({}); await retry; assert.equal(h.opened, 1);
});

test('a disabled import entry cannot start a second material mutation', async () => {
  const h = importFixture(); h.context.conversationFlow.saved.pending = { action: 'upload' };
  h.context.syncControls(); assert.equal(h.$('#page-primary').disabled, true);
  await h.context.action('import'); assert.equal(h.calls.length, 0); assert.equal(h.opened, 0);
});

test('basic material libraries can use the shared import entry without a loaded conversation', async () => {
  const h = importFixture(); h.context.basicMaterialWarehouse = h.state.warehouseId;
  h.context.conversationFlow.state.loaded = false;
  h.context.syncControls(); assert.equal(h.$('#page-primary').disabled, false);
  const opening = h.context.action('import'); await new Promise(resolve => setImmediate(resolve));
  h.calls[0].resolve({}); await opening;
  assert.equal(h.opened, 1); assert.equal(h.state.importContext, 'standard');
});

test('batch recovery and conversation intake keep independent selections and retain the draft note', async () => {
  const h = importFixture();
  const batch = [{handle:'accepted',done:true},{handle:'retry',error:Error('timeout')}];
  const intake = [{handle:'material-review'}];
  h.state.importFiles.standard = batch;
  h.state.importFiles.conversation = intake;
  h.$('#import-note').value = '核对交付时间';
  await h.context.action('import');
  assert.equal(h.state.files,intake);
  assert.equal(Boolean(h.$('#confirm-import').disabled),false);
  assert.equal(h.$('#import-note-field').hidden,false);
  h.$('#import-dialog').open = false;
  assert.equal(h.$('#page-batch-import').hidden, false);
  assert.equal(h.$('#page-batch-import').disabled, false);
  assert.equal(h.$('#page-batch-import').textContent, '继续批量导入');
  await h.context.action('import-batch');
  assert.equal(h.state.files,batch);
  assert.equal(h.$('#import-note-field').hidden,true);
  h.$('#import-dialog').open = false;
  h.state.view = 'conversation';
  await h.context.action('import');
  assert.equal(h.state.files,intake);
  assert.equal(h.$('#import-note').value,'核对交付时间');
  assert.equal(h.calls.length,0);
});

for (const code of ['SPACE_REMOTE_FILE_CHANGED', 'SEMANTICA_FILE_CONTENT_MISMATCH', 'SEMANTICA_FILE_ENCRYPTED']) test(`batch import only retries recoverable files (${code})`, async () => {
  const h = fixture();
  h.state.files = ['ready', 'timeout', 'changed'].map(handle => ({ handle, name: handle, source: 'space' }));
  vm.runInContext(section('function canCreateWarehouse()', 'function connection(') +
    section('function pendingFileStatus(', 'async function uploadConversationFile()'), h.context);
  const upload = h.context.uploadFiles();
  const initialRows = h.$('#file-list').innerHTML;
  h.calls[0].resolve({ document: { id: 'stored' } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.$('#file-list').innerHTML, initialRows);
  assert.equal(h.$('#file-list [data-import-status="ready"]').textContent, '已交给盒端处理');
  assert.equal(h.$('#import-batch-status').textContent, '已提交 1 份');
  h.calls[1].reject(Error('读取万象空间超时'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.$('#file-list').innerHTML, initialRows);
  assert.equal(h.$('#file-list [data-import-status="timeout"]').textContent, '读取万象空间超时');
  h.calls[2].reject(Object.assign(Error('文件已变化，请移除后重新选择'), { code }));
  await upload;
  assert.equal(h.$('#import-batch-status').textContent, '已提交 1 份 · 1 份可重试 · 1 份需重新选择');
  assert.equal(h.$('#confirm-import').textContent, '重试 1 份');
  assert.match(h.$('#file-list').innerHTML, /changed[\s\S]*?移除旧选择[\s\S]*?文件已变化/);
  assert.ok(h.$('#file-list').innerHTML.indexOf('timeout') < h.$('#file-list').innerHTML.indexOf('ready'));

  const retry = h.context.uploadFiles();
  assert.equal(h.calls[3].input.handle, 'timeout');
  h.calls[3].resolve({ document: { id: 'recovered' } });
  await retry;
  assert.equal(h.calls.length, 4);
  assert.equal(h.$('#import-batch-status').textContent, '已提交 2 份 · 1 份需重新选择');
  assert.equal(h.$('#confirm-import').disabled, true);
  assert.equal(h.$('#import-dialog').open, true);
});

test('selecting all Space matches resumes a failed page before staging bounded groups', async () => {
  const h = fixture();
  const rows = Array.from({length:225}, (_, n) => ({id:`file-${n}`,digest:`hash-${n}`,kind:'file'}));
  h.state.space = {parent:'folder'};
  h.state.spaceRequest = 0;
  h.state.spaceResults = {items:[],search:{nextCursor:'next',scanLimited:false}};
  h.$('#space-query').value = '培训';
  h.context.renderPending = h.context.renderSpace = () => {};
  vm.runInContext(section('function canCreateWarehouse()', 'function connection(') +
    section('function matchingSpaceItems(', 'function renderSpace()') +
    section('async function loadSpace(', 'async function removePending(') +
    section('async function selectSpaceItems(', '$("#space-select-visible").addEventListener'), h.context);

  const first = h.context.selectSpaceItems([], true);
  h.calls[0].reject(Error('page failed'));
  await first;
  assert.equal(h.state.files.length,0);
  assert.equal(h.state.spaceResults.items.length,0);

  const second = h.context.selectSpaceItems([], true);
  assert.equal(h.calls[1].input.after,'next');
  h.calls[1].resolve({items:rows.slice(0,100),search:{nextCursor:'middle',scanLimited:true}});
  await new Promise(resolve => setImmediate(resolve));
  h.calls[2].resolve({items:rows.slice(100,200),search:{nextCursor:'last',scanLimited:false}});
  await new Promise(resolve => setImmediate(resolve));
  h.calls[3].resolve({items:[rows[199],...rows.slice(200)],search:{scanLimited:false}});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.state.spaceResults.search.scanLimited,true);
  assert.equal(h.calls[4].input.entries.length,200);
  h.calls[4].resolve(rows.slice(0,200).map(row=>({spaceId:row.id,handle:row.id})));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.calls[5].input.entries.length,25);
  h.calls[5].reject(Error('second selection group failed'));
  await assert.rejects(second,/second selection group failed/);
  assert.equal(h.state.files.length,200);

  const last = h.context.selectSpaceItems(h.context.selectableSpaceItems());
  assert.equal(h.calls[6].input.entries.length,25);
  assert.equal(h.calls[6].input.entries[0].id,'file-200');
  h.calls[6].resolve(rows.slice(200).map(row=>({spaceId:row.id,handle:row.id})));
  await last;
  assert.equal(new Set(h.state.files.map(file=>file.spaceId)).size,225);
  assert.equal(h.state.spaceSelecting,false);
});

const detail = id => ({ document: { id, original_name: id, segment_count: 2 }, version: { id: 'version-' + id }, segments: [{ id: 's-' + id, text: 'original' }] });
const sourceReads = section('async function sourceRange(', 'function renderSource()') + section('async function sourceMore(', 'async function saveCorrection()');
test('closing and reopening a source ignores the previous document response', async () => {
  const h = fixture(); vm.runInContext(sourceReads, h.context); h.context.renderSource = () => {};
  const first = h.context.showSource('first'); h.$('#source-dialog').open = false;
  const second = h.context.showSource('second');
  h.calls[1].resolve(detail('second')); await second;
  h.calls[0].resolve(detail('first')); await first;
  assert.equal(h.state.source.document.id, 'second');
});
test('an older graph citation finds its precise fragment in the pinned version', async () => {
  const h = fixture(); vm.runInContext(sourceReads, h.context); h.context.renderSource = () => {};
  const opening = h.context.showSource('doc', { document_version_id: 'old', segment_id: 'cited',
    locator_json: JSON.stringify({ page: 18, source_char_start: 5 }) });
  h.calls[0].resolve(detail('doc'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.calls[1].input.versionId, 'old');
  assert.equal(h.calls[1].input.start, 0);
  h.calls[1].resolve({ document_id: 'doc', version_id: 'old', start: 0, end: 100, total_chars: 200,
    locators: [{ segment_id: 'other', start: 0, end: 100 }] });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.calls[2].input.start, 100);
  h.calls[2].resolve({ document_id: 'doc', version_id: 'old', start: 100, end: 200, total_chars: 200,
    locators: [{ segment_id: 'cited', start: 140, end: 150 }] });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.calls[3].input.versionId, 'old');
  assert.equal(h.calls[3].input.start, 145);
  h.calls[3].resolve({ document_id: 'doc', version_id: 'old', start: 145, end: 200, total_chars: 200, text: '引用段落和下文' });
  await opening;
  assert.equal(h.state.source.pinnedStart, 145);
  assert.equal(h.state.source.pinned.version_id, 'old');
  assert.equal(h.state.source.pinnedText, '引用段落和下文');
});

test('source pagination cannot append a duplicate page or repaint a different document', async () => {
  const h = fixture(); vm.runInContext(sourceReads, h.context);
  let renders = 0; h.context.renderSource = () => { renders++; };
  const first = detail('first'); h.state.source = first;
  const pending = h.context.sourceMore(); const repeated = h.context.sourceMore();
  assert.equal(h.calls.length, 1, 'one page request at a time');
  h.state.source = detail('second'); const before = renders;
  h.calls[0].resolve({ version: first.version, segments: [{ id: 'next', text: 'next' }] }); await pending;
  await repeated;
  assert.equal(first.segments.length, 1); assert.equal(renders, before);
});
test('reading earlier context keeps the cited version and rejects a mismatched range', async () => {
  const h = fixture(); vm.runInContext(sourceReads, h.context); h.context.renderSource = () => {};
  h.state.source = {...detail('material'), pinned:{version_id:'earlier', end:3600},
    pinnedStart:3000, pinnedText:'引用原文'};
  const reading = h.context.sourceMore(true);
  assert.equal(h.calls[0].input.versionId, 'earlier');
  assert.equal(h.calls[0].input.start, 1800);
  assert.equal(h.calls[0].input.end, 3000);
  h.calls[0].resolve({document_id:'material', version_id:'earlier', start:1800, end:3000, text:'上文'});
  await reading;
  assert.equal(h.state.source.pinnedContext.text, '上文');
  const mismatch = h.context.sourceMore(true);
  h.calls[1].resolve({document_id:'material', version_id:'earlier', start:600, end:1801, text:'错误范围'});
  await assert.rejects(mismatch, /SOURCE_VERSION_CONFLICT/);
  assert.equal(h.state.source.pinnedContext.start, 1800);
  assert.equal(h.state.source.pinnedText, '引用原文');
});

test('failed correction preserves edited text and retries the same unchanged operation', async () => {
  const h = fixture(); vm.runInContext(section('function renderSource()', 'function matchingSpaceItems()'), h.context);
  h.state.source = detail('first'); h.state.sourceTotal = 1; h.state.editing = true;
  h.context.document.querySelectorAll = () => [{ dataset: { segment: 's-first' }, value: 'edited text' }];
  const first = h.context.saveCorrection(); h.calls[0].reject(Error('response lost')); await first;
  assert.match(h.$('#source-body').innerHTML, />edited text<\/textarea>/);
  const second = h.context.saveCorrection(); h.calls[1].reject(Error('still offline')); await second;
  assert.equal(h.calls[0].input.operationId, h.calls[1].input.operationId);
});
test('correction completion cannot replace a newer source', async () => {
  const h = fixture(); vm.runInContext(section('async function saveCorrection()', 'function matchingSpaceItems()'), h.context);
  h.context.renderSource = () => {}; h.state.source = detail('first'); h.state.editing = true;
  const saving = h.context.saveCorrection(); h.state.source = detail('second'); h.calls[0].resolve({ saved: true });
  await new Promise(resolve => setImmediate(resolve));
  h.calls[1]?.resolve(detail('first')); await saving;
  assert.equal(h.state.source.document.id, 'second');
});
test('a successful correction replaces its source and releases the saving state', async () => {
  const h = fixture(); vm.runInContext(section('async function saveCorrection()', 'function matchingSpaceItems()'), h.context);
  h.context.renderSource = () => {}; h.state.source = detail('first'); h.state.editing = true;
  const saving = h.context.saveCorrection(); h.calls[0].resolve({ saved: true });
  await new Promise(resolve => setImmediate(resolve));
  const updated = detail('first'); updated.version.id = 'new-version';
  h.calls[1].resolve(updated); await saving;
  assert.equal(h.state.source.version.id, 'new-version');
  assert.equal(h.state.saving, false); assert.equal(h.state.editing, false);
});
test('source close events preserve a reopened dialog and cancel cannot interrupt a save', () => {
  const h = fixture(), events = {};
  h.$('#source-dialog').addEventListener = (name, callback) => { events[name] = callback; };
  vm.runInContext(section('$("#source-dialog").addEventListener("cancel"', '$("#import-link-existing").addEventListener('), h.context);
  const current = detail('second'); h.state.source = current;
  events.close(); assert.equal(h.state.source, current, 'a queued close event must not clear a reopened dialog');
  h.state.saving = true; let canceled = false;
  events.cancel({ preventDefault() { canceled = true; } }); assert.equal(canceled, true);
  h.$('#source-dialog').open = false; events.close(); assert.equal(h.state.source, null);
});
test('changing model scope blocks saves until its configuration is loaded and uses the matching catalog', async () => {
  const h = fixture(); h.state.modelConfig = { revision: 1 }; h.state.modelCatalog = [];
  h.$('#model-scope').value = 'default'; h.$('#model-mode').value = 'automatic';
  vm.runInContext(section('async function loadModels()', 'function renderModelEditor()') + section('async function saveModels()', 'const reprocessPlans ='), h.context);
  h.context.updateModelControls = () => {}; h.context.renderModelEditor = () => {};
  const loading = h.context.loadModels();
  assert.equal(h.state.modelConfig, null, 'the previous scope cannot remain writable');
  await h.context.saveModels();
  assert.deepEqual(h.calls.map(call => call.action), ['processing', 'model-catalog']);
  assert.equal(h.calls[1].input.scope, 'default');
  h.calls[0].reject(Error('scope read failed')); h.calls[1].resolve({ items: [] }); await loading;
  assert.equal(h.state.modelConfig, null, 'failed reads must keep saves blocked');
});

test('model recovery displays the budget and return action only for the interrupted warehouse', () => {
  const h = fixture();
  h.context.renderThinkingOptions = () => {};
  vm.runInContext(section('function updateModelControls()', 'async function saveModels()'), h.context);
  h.state.modelOnboarding = {warehouseId:h.state.warehouseId,required:9159};
  h.context.updateModelControls();
  assert.equal(h.$('#model-onboarding').hidden,false);
  assert.match(h.$('#model-onboarding-budget').textContent,/9159 个 token/);
  h.state.modelSaving = true;
  h.context.updateModelControls();
  assert.equal(h.$('#model-onboarding-return').disabled,true);
  h.state.warehouseId = 'different-warehouse';
  h.context.updateModelControls();
  assert.equal(h.$('#model-onboarding').hidden,true);
});
