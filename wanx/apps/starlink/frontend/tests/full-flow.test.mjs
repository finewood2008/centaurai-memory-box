import test from 'node:test';
import assert from 'node:assert/strict';
import {requestJson} from '../src/request.ts';
import {readDocumentLibrary} from '../src/documentLibrary.ts';

test('API errors retain useful conflict messages and do not stringify objects or validation inputs', async () => {
  const original = globalThis.fetch;
  try {
    for (const [body, message] of [
      [{detail: {code: 'CORRECTION_BASE_CHANGED', message: '草稿基础已变化，请重新核对'}}, '草稿基础已变化，请重新核对'],
      [{detail: '材料不存在'}, '材料不存在'],
      [{message: '当前空间无权访问'}, '当前空间无权访问'],
      [{detail: [{loc: ['body', 'name'], msg: 'invalid', input: 'private-value'}]}, '提交内容不符合要求，请检查填写的字段后重试'],
    ]) {
      globalThis.fetch = async () => new Response(JSON.stringify(body), {status: 409});
      await assert.rejects(requestJson('/api/test'), {message});
    }
    globalThis.fetch = async () => new Response('gateway unavailable', {status: 502});
    await assert.rejects(requestJson('/api/test'), {message: 'HTTP 502'});
  } finally { globalThis.fetch = original; }
});

test('material library loads old documents beyond the API default page and preserves workspace encoding', async () => {
  const all = Array.from({length: 1001}, (_, i) => ({id: String(i)}));
  const offsets = [];
  const items = await readDocumentLibrary('space & two', async url => {
    const query = new URL(url, 'http://local').searchParams;
    assert.equal(query.get('workspace_id'), 'space & two');
    const offset = Number(query.get('offset')); offsets.push(offset);
    return {items: all.slice(offset, offset + Number(query.get('limit'))), total: all.length};
  });
  assert.deepEqual(items, all);
  assert.deepEqual(offsets, [0, 500, 1000]);
});

test('material refresh never commits a partial library after a later page fails', async () => {
  let visible = [{id: 'original-selected-material'}];
  await assert.rejects(readDocumentLibrary('default', async url => {
    if (new URL(url, 'http://local').searchParams.get('offset') !== '0') throw Error('offline');
    return {items: [{id: 'new-material'}], total: 2};
  }).then(items => {visible = items;}), /offline/);
  assert.deepEqual(visible, [{id: 'original-selected-material'}]);
});

test('material pagination terminates after concurrent deletion and deduplicates shifted pages', async () => {
  const pages = [{items: [{id:'a'}, {id:'b'}], total:5}, {items:[{id:'b'}, {id:'c'}], total:5}, {items:[], total:4}];
  const result = await readDocumentLibrary('default', async () => pages.shift());
  assert.deepEqual(result.map(item => item.id), ['a','b','c']);
  assert.equal(pages.length, 0);
});
