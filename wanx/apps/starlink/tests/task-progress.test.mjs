import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../ui/app.js', import.meta.url), 'utf8');
const context = vm.createContext({});
vm.runInContext(source.slice(source.indexOf('const jobNames ='), source.indexOf('function renderTasks()')), context);

test('task progress shows combined extraction and completed streaming batches', () => {
  assert.equal(context.taskProgress({status: 'running', stage: 'extracting_joint', completed_units: 3,
    metrics: {extraction_protocol: 'joint-ontology-facts-v1'}}), '联合抽取类型、实体和关系 · 已完成 3 批次');
});
test('existing discovery progress displays review rounds, completed batches and recovery', () => {
  assert.equal(context.taskProgress({status: 'running', metrics: {ontology_discovery_progress: {
    phase: 'document_review', state: 'recovering', review_round: 2, completed_batches: 8, requests: 10}}}),
    '复核本体建议 · 第 2 轮 · 已完成 8 批次 · 已发起 10 次请求 · 正在拆分重试');
});
test('terminal and queued states override stale in-progress metrics', () => {
  for (const [status, label] of [['failed', '失败'], ['succeeded', '已完成'], ['cancelled', '已取消'], ['queued', '排队中']]) {
    assert.equal(context.taskProgress({status, stage: 'extracting_joint',
      metrics: {extraction_protocol: 'joint-ontology-facts-v1'}}), label);
  }
});
test('untrusted progress counts cannot become displayed HTML', () => {
  const result = context.taskProgress({status: 'running', metrics: {ontology_discovery_progress: {
    phase: 'document_review', review_round: '<script>', completed_batches: -1, requests: 'Infinity'}}});
  assert.equal(result, '复核本体建议 · 第 0 轮 · 已完成 0 批次 · 已发起 0 次请求');
});

test('completed extraction needing evidence review is not labelled as fully finished',()=>{
  assert.equal(context.taskProgress({status:'succeeded',metrics:{joint_validation:{publication_blocked:true}}}),'待核对抽取结果');
  assert.equal(context.taskProgress({status:'failed',metrics:{joint_validation:{publication_blocked:true}}}),'失败');
});
