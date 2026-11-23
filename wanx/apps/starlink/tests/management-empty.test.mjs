import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(process.env.STARLINK_APP_SOURCE || new URL('../ui/app.js', import.meta.url), 'utf8');
const managementSource = source.slice(source.indexOf('function renderManagement() {'), source.indexOf('async function loadImportFailure('));
const warehouseSource = source.slice(source.indexOf('function currentWarehouse() {'), source.indexOf('function warehouseStatus(w) {'));

function render({ warehouse = null, importFailure } = {}) {
  const elements = new Map();
  const $ = selector => {
    if (!elements.has(selector)) elements.set(selector, {});
    return elements.get(selector);
  };
  const state = { warehouses: warehouse ? [warehouse] : [], warehouseId: warehouse?.id ?? null,
    importFailure, managementStats: null, runtime: null };
  let processingRenders = 0;
  vm.runInNewContext(`${warehouseSource}\n${managementSource}\nrenderManagement();`, {
    state, $, bytes: String, esc: String, renderProcessingSummary: () => { processingRenders++; },
  });
  return { $, processingRenders };
}

for (const importFailure of [null, undefined]) {
  test(`management without a warehouse or ${String(importFailure)} import failure shows the new warehouse prompt`, () => {
    const { $, processingRenders } = render({ importFailure });
    assert.equal($('#manage-name').textContent, '从一张星图开始');
    assert.equal($('#manage-status').hidden, true);
    assert.equal($('#manage-status').textContent, '');
    assert.equal($('#warehouse-stats').innerHTML, '');
    assert.match($('#manage-description').textContent, /原始资料、正文版本与知识来源/);
    assert.equal(processingRenders, 1);
  });
}

const warehouse = { id: 'failed', name: '迁入失败仓', state: 'import_failed' };

test('management keeps the selected failed import loading message', () => {
  const { $ } = render({ warehouse, importFailure: { id: warehouse.id, loading: true } });
  assert.equal($('#manage-name').textContent, warehouse.name);
  assert.equal($('#manage-status').hidden, false);
  assert.match($('#manage-status').textContent, /正在读取失败原因/);
});

test('management keeps the selected failed import error message', () => {
  const { $ } = render({ warehouse, importFailure: { id: warehouse.id, error: '磁盘空间不足' } });
  assert.equal($('#manage-status').hidden, false);
  assert.match($('#manage-status').textContent, /迁入未完成：磁盘空间不足/);
  assert.doesNotMatch($('#manage-status').textContent, /可能已过期/);
});

test('management does not reuse another warehouse import failure', () => {
  const { $ } = render({ warehouse, importFailure: { id: 'other', loading: true, error: '其他仓错误' } });
  assert.match($('#manage-status').textContent, /记录可能已过期/);
  assert.doesNotMatch($('#manage-status').textContent, /其他仓错误|正在读取失败原因/);
});
