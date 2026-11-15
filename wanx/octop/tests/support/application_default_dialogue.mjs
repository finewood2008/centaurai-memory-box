// Real personal/team client selection with a public native-API snapshot.
// The transport records the turn frame; Python drives its real SDK/lease proxy.
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { createAIDialogue } from '../../../apps/personal-client/shell/assistant-service.mjs';

const input = JSON.parse(readFileSync(0, 'utf8'));
const agentId = input.agentId || 'synthetic-agent';
const threadId = input.threadId || 'synthetic-thread';
const frames = [];
const context = { space: { enabled: false }, knowledge: { enabled: false, warehouses: [] } };
const link = {
  async request({ path }) {
    let data, status = 200;
    if (path === '/api/assistant/profile') data = { agent_id: agentId };
    else if (path === '/api/providers/resolved') data = input.models;
    else if (path === '/api/providers/application-defaults') data = input.defaults;
    else if (path === '/api/assistant/conversations') data = { items: [] };
    else if (path.startsWith('/api/assistant/context/defaults?')) data = { context };
    else if (path === '/api/assistant/conversations/' + threadId) data = {
      id: threadId, active_thread_id: threadId, context, revision: 1,
      versions: [{ thread_id: threadId, kind: 'original' }],
    };
    else if (path.includes('/history?')) data = {
      thread_id: threadId, messages: [], turn_active: false, hitl_pending: null,
    };
    else { status = 404; data = { code: 'NOT_FOUND' }; }
    return { status, headers: {}, body: Buffer.from(JSON.stringify(data)) };
  },
  async openStream() {
    const socket = new EventEmitter();
    socket.readyState = 1;
    socket.send = (raw, done) => { frames.push(JSON.parse(raw)); done?.(); };
    socket.terminate = () => { socket.readyState = 3; socket.emit('close'); };
    return socket;
  },
};
const client = {
  snapshot: () => ({ phase: 'ready', account: { phase: 'authenticated', accountId: 'synthetic-owner' },
    connection: { deviceId: 'synthetic-box', gatewayURL: 'http://127.0.0.1' } }),
  subscribe: () => () => {},
  applicationConnection: async () => link,
};
const service = createAIDialogue({ client });
try {
  const loaded = await service.action('load');
  if (input.send) {
    const selected = await service.action('send', { scope: loaded.scope, threadId,
      modelMode: input.manual ? 'manual' : 'auto', model: input.manual,
      prompt: 'Synthetic qualification: return ok. No customer content.' });
    process.stdout.write(JSON.stringify({ defaultModel: loaded.defaultModel, selected: selected.model,
      frame: frames.findLast(frame => frame.type === 'user_turn') }));
  } else process.stdout.write(JSON.stringify({ defaultModel: loaded.defaultModel }));
} finally { service.close(); }
