import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import * as Meetings from '../resources/accessory-preview/lib/meetings.mjs';
import { createMedia, media } from '../resources/accessory-preview/lib/media.mjs';

test('summary retry keeps the underlying error when the box refuses another attempt', async () => {
  const service = createMedia({
    context: async () => ({ connection: 'ready' }),
    request: async route => {
      if (route.endsWith('/capabilities')) return Response.json({
        processingLocation: 'box', capabilities: [{ id: 'text.summarize', configured: true }],
      });
      if (route.endsWith('/retry')) return Response.json({ code: 'RETRY_NOT_ALLOWED' }, { status: 409 });
      assert.ok(route.endsWith('/summaries') || route.endsWith('/jobs/exhausted'));
      return Response.json({ id: 'exhausted', state: 'failed', error: 'SUMMARY_UPSTREAM_FAILED', attempts: 3 });
    },
  }, null, 'demo');
  await assert.rejects(service.summarize('测试文字', 'general', 'test-id', true),
    { message: 'SUMMARY_UPSTREAM_FAILED', needsNewSummaryJob: true });
});

test('a user can regenerate an exhausted summary with the same template and original transcript', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wanx-summary-retry-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await Meetings.initStore(root);
  const { id } = await Meetings.createMeeting({ source: 'clip' });
  const record = Meetings.getMeetingRaw(id);
  record.state = 'finished';
  record.audio.status = 'saved';
  record.transcript = { status: 'done', segments: [{ i: 0, fromMs: 0, toMs: 1500, text: '周四确认排班。' }] };
  t.mock.method(media, 'scope', async () => 'test');
  t.mock.method(media, 'ensureTemplate', async () => 'general');
  let first;
  t.mock.method(media, 'summarize', async (_text, _template, requestId) => {
    first ??= requestId;
    if (first === requestId) throw new Error('RETRY_NOT_ALLOWED');
    return { text: '周四确认排班。' };
  });
  async function generate() {
    await Meetings.retryStage(id, 'minutes', { templateId: 'general', rev: 0 });
    for (let i = 0; i < 100 && Meetings.view(id).pipelineRunning; i++) await delay(10);
    return Meetings.view(id).minutes;
  }
  assert.equal((await generate()).error, 'RETRY_NOT_ALLOWED');
  assert.equal((await generate()).document?.text, '周四确认排班。');
});
