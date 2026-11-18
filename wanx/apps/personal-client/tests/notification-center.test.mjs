import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createNotificationCenter as personal } from '../shell/notification-center.mjs';
import { createNotificationCenter as team } from '../../team-client/shell/notification-center.mjs';
import { createNotificationCenter as builder } from '../../builder/integration/team-client/notification-center.mjs';

const serviceURL = 'https://account.test';
const accountKey = id => createHash('sha256').update(JSON.stringify([serviceURL, id])).digest('hex');
const response = value => ({ status: 200, body: Buffer.from(JSON.stringify(value)) });

async function fixture(create, { loops = [], disk = null, connected = true } = {}) {
  const stream = Object.assign(new EventEmitter(), { readyState: 1, send() {}, terminate() {} });
  const state = { phase: connected ? 'ready' : 'idle', account: { phase: 'authenticated', accountId: 'a', clientId: 'client' }, connection: { deviceId: 'box', name: 'Box' } };
  let changed, streamCalls = 0, saved = structuredClone(disk);
  const client = {
    snapshot: () => state,
    subscribe: fn => { changed = fn; return () => {}; },
    applicationStream: async () => { streamCalls++; return stream; },
    applicationRequest: async ({ path }) => response(path === '/api/loops' ? loops : { items: [] }),
  };
  const center = await create({ client, serviceURL, store: { load: async () => structuredClone(saved), save: async value => { saved = structuredClone(value); } } });
  await center.refresh();
  return {
    center, saved: () => saved, streamCalls: () => streamCalls,
    account(id) { state.account.accountId = id; changed(); },
    push(text, agent_name = '知君 · 私人空间') {
      stream.emit('message', Buffer.from(JSON.stringify({ type: 'dashboard_push', agent_id: 'agent', thread_id: 'thread', text, agent_name })));
    },
  };
}

for (const [edition, create] of Object.entries({ personal, team, builder })) {
  test(`${edition} never subscribes to the native dashboard notification source`, async t => {
    const f = await fixture(create);
    t.after(() => f.center.close());
    assert.equal(f.streamCalls(), 0);
    f.push('**v1.0.3b4** https://github.com/TencentCloud/Octop/releases/tag/v1.0.3b4');
    f.push('原生后台任务消息，不含任何产品名称。');
    assert.equal(f.center.snapshot().items.length, 0);
    assert.equal(f.center.snapshot().unreadCount, 0);

    f.center.operation({ accountId: 'a', applicationId: 'centaurai.wanx.zhijun', phase: 'installing', status: 'succeeded' });
    f.center.update({ phase: 'available', candidate: { releaseId: 'wanx-release' } });
    assert.equal(f.center.snapshot().items.length, 2);
    assert.equal(f.center.snapshot().unreadCount, 2);
    assert(f.center.snapshot().items.some(row => row.title === (edition === 'personal' ? '记忆盒子有新版本' : '万象有新版本')));
    await f.center.markRead({ all: true });
    assert.equal(f.center.snapshot().unreadCount, 0);
    f.account('b');
    await f.center.refresh();
    assert.equal(f.streamCalls(), 0);
  });

  test(`${edition} preserves the WANX task notification source and read state`, async t => {
    const now = Date.now() / 1000;
    const f = await fixture(create, { loops: [
      { loop_id: 'wanx-task', definition: { name: '资料整理' }, notifications: [{ notification_id: 'user-notice', message: '资料已整理完成。', created_at: now - 1 }], status: 'completed', updated_at: now - 1 },
    ] });
    t.after(() => f.center.close());
    assert.deepEqual(f.center.snapshot().items.map(row => row.title).sort(), ['资料整理', '资料整理 · 已完成']);
    await f.center.markRead({ all: true });
    await f.center.refresh();
    assert.equal(f.center.snapshot().items.length, 2);
    assert.equal(f.center.snapshot().unreadCount, 0);
  });

  test(`${edition} removes every cached native push regardless of content across accounts`, async t => {
    const internal = { id: 'internal', title: '知君 · 私人空间', body: '/octop-updates/latest.md', category: 'task', readAt: null };
    const generic = { ...internal, id: 'generic', title: '后台任务', body: '这条原生消息不含产品名称。' };
    const allowed = { id: 'allowed', title: '任务完成', body: '你的资料已就绪。', category: 'task', applicationId: 'centaurai.wanx.centaurloop', readAt: null };
    const disk = { version: 1, accounts: {
      [accountKey('a')]: { items: [internal, generic, allowed], seen: ['internal', 'generic', 'allowed'], feeds: { box: ['previous'] } },
      [accountKey('b')]: { items: [generic, { ...allowed, readAt: 123 }], seen: ['generic', 'allowed'] },
    } };
    const f = await fixture(create, { disk, connected: false });
    t.after(() => f.center.close());
    assert.deepEqual(f.center.snapshot().items, [allowed]);
    assert.equal(f.center.snapshot().unreadCount, 1);
    await assert.rejects(async () => f.center.target('internal'), /NOTIFICATION_NOT_FOUND/);
    await assert.rejects(f.center.markRead({ id: 'internal' }), /NOTIFICATION_NOT_FOUND/);
    assert.deepEqual(f.saved().accounts[accountKey('a')].feeds, disk.accounts[accountKey('a')].feeds);
    assert.deepEqual(f.saved().accounts[accountKey('a')].seen, ['internal', 'generic', 'allowed']);
    assert.equal(f.saved().accounts[accountKey('b')].items.length, 1);
    f.account('b');
    assert.equal(f.center.snapshot().items.length, 1);
    assert.equal(f.center.snapshot().unreadCount, 0);
    const restarted = await fixture(create, { disk: f.saved(), connected: false });
    t.after(() => restarted.center.close());
    assert.deepEqual(restarted.center.snapshot().items, [allowed]);
  });
}

test('memory pipeline blockers alert once until the existing backlog resumes', async t => {
  const f = await fixture(personal, { connected: false });
  const report = (center, blockers, accountId = 'a') => center.memoryPipeline({ accountId, blockers });
  report(f.center, []);
  report(f.center, ['summary-model'], 'b');
  assert.equal(f.center.snapshot().unreadCount, 0);
  report(f.center, ['summary-model']);
  assert.equal(f.center.snapshot().items[0].title, '记忆摘要已暂停');
  await f.center.markRead({ all: true });
  await f.center.close();

  const restarted = await fixture(personal, { connected: false, disk: f.saved() });
  t.after(() => restarted.center.close());
  report(restarted.center, ['summary-model']);
  assert.equal(restarted.center.snapshot().unreadCount, 0);
  report(restarted.center, []);
  report(restarted.center, ['summary-model', 'evolution-model']);
  assert.equal(restarted.center.snapshot().unreadCount, 2);
});
