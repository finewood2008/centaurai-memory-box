import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(process.env.STARLINK_APP_SOURCE || new URL('../ui/app.js', import.meta.url), 'utf8');
const formatter = source.slice(source.indexOf('function actualModel('), source.indexOf('function modelUsage('));
const render = source.slice(source.indexOf('function renderSource()'), source.indexOf('async function sourceMore('));

function renderedModel(processing) {
  const nodes = new Map();
  const $ = selector => { if (!nodes.has(selector)) nodes.set(selector, {}); return nodes.get(selector); };
  const state = { sourceTotal: 1, editing: false, saving: false, sourceEvidence: null,
    // The current default is not evidence of which model handled an old source.
    processing: { revision: 9, extraction: { name: 'current-default-cloud', location: 'cloud' } },
    runtime: { model: 'current-default-cloud' },
    source: { document: { original_name: 'synthetic-integration.txt', document_format: 'txt', size_bytes: 231, processing },
      processing: { text_ready: true, index_ready: true, graph_status: 'published' },
      version: { version_number: 1 }, segments: [{ id: 'segment-1', text: '合成材料原文', source_locator: { line_number: 1 } }] } };
  const context = { state, $, esc: value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;'),
    bytes: value => value + ' B', locator: () => '第 1 行' };
  vm.createContext(context); vm.runInContext(formatter + render, context);
  context.renderSource();
  return nodes.get('#source-body').innerHTML.match(/<p class="model-actual">([^<]+)<\/p>/)?.[1];
}

test('source dialog treats the actual legacy-local empty placeholder as unrecorded, not evidence of local inference', () => {
  const actualBoxShape = { checked_at: null, source: 'legacy', revision: 0, sensitive_follow: true,
    extraction: { id: 'legacy-local', name: '', model: '', provider: '现有本地服务', location: 'local',
      available: false, route: 'legacy', revision: 'legacy-local' },
    sensitive: { id: 'legacy-local', name: '', model: '', provider: '现有本地服务', location: 'local',
      available: false, route: 'legacy', revision: 'legacy-local' } };
  const value = renderedModel(actualBoxShape);
  assert.equal(value, '实际知识处理：历史处理记录未提供模型配置');
  assert.doesNotMatch(value, /本地|云端|配置 v0|current-default-cloud/);
});

test('source dialog keeps recorded cloud and local models separate from the current default', () => {
  assert.equal(renderedModel({ revision: 4, extraction: { name: 'recorded-cloud-model', location: 'cloud' },
    inference_options: { thinking_mode: 'off' } }), '实际知识处理：recorded-cloud-model · 云端 / 外部服务 · 思考：关闭 · 配置 v4');
  assert.equal(renderedModel({ revision: 0, extraction: { name: 'recorded-local-model', location: 'local' },
    inference_options: { thinking_mode: 'auto' } }), '实际知识处理：recorded-local-model · 本地 · 思考：模型默认 · 配置 v0');
});

test('source dialog does not invent location, thinking defaults or configuration revision when metadata is absent', () => {
  assert.equal(renderedModel({ extraction: { model: 'known-historical-model' } }),
    '实际知识处理：known-historical-model · 运行位置未记录 · 思考设置未记录 · 配置版本未记录');
  assert.equal(renderedModel(null), '实际知识处理：历史处理记录未提供模型配置');
});

test('an unavailable automatic default still explains its current availability instead of claiming inference happened', () => {
  assert.equal(renderedModel({ mode: 'automatic', extraction: { name: 'WANX 默认模型', available: false, location: 'cloud' } }),
    '实际知识处理：万象底座默认模型暂不可用，请检查万象模型设置');
});
