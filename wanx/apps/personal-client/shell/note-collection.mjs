import { randomUUID } from 'node:crypto';
import { createSharedNote, emptyNote } from './shared-note.mjs';

const validId = id => typeof id === 'string' && /^[a-f0-9]{32}$/.test(id);
const fail = code => Object.assign(Error(code), { code });

export function createNoteCollection({ collections, scope, online, request, persist, changed, imagesReady, retryMs }) {
  const workers = new Map();
  let unsupportedScope, wasOnline = false;
  const current = () => collections[scope()];

  function summaries() {
    const collection = current();
    if (!collection) return undefined;
    const entries = new Map(collection.items.map(row => [row.id, { id: row.id, title: row.title }]));
    for (const [id, note] of Object.entries(collection.records)) {
      if (note.deleted) entries.delete(id);
      else if (note.createdHere || note.dirty || note.pending || note.conflict) {
        const title = note.blocks.find(b => b.type === 'text' && b.text.trim())?.text
          .trim().split(/\r?\n/, 1)[0].slice(0, 70) || '';
        entries.set(id, { id, title });
      }
    }
    return [...entries.values()];
  }

  function note(id) {
    const bound = scope(), collection = current();
    if (!validId(id) || !collection || (!collection.records[id] && !collection.items.some(row => row.id === id)))
      throw fail('CLIPBOARD_NOT_FOUND');
    const key = JSON.stringify([bound, id]);
    if (!workers.has(key)) {
      workers.set(key, createSharedNote({
        scope: () => scope() === bound ? bound : null,
        route: '/notes/' + id,
        recordFor: () => collection.records[id] ??= emptyNote(),
        online, request, persist, changed: () => { if (scope() === bound) changed(id); }, imagesReady, retryMs,
      }));
    }
    return workers.get(key);
  }

  async function refresh() {
    const bound = scope();
    if (!bound || !online() || unsupportedScope === bound) return;
    let result;
    try { result = await request('/notes', {}, bound); }
    catch (error) {
      if (!current() && (error.status === 404 || [
        'BOX_ROUTE_NOT_AVAILABLE', 'LOCAL_DATA_FORBIDDEN', 'LOCAL_DATA_ROUTE_DENIED',
        'CLIPBOARD_SERVICE_UNAVAILABLE',
      ].includes(error.code))) {
        unsupportedScope = bound;
        return;
      }
      throw error;
    }
    if (!Array.isArray(result.items) || result.items.some(row => !validId(row.id) || typeof row.title !== 'string'))
      throw fail('CLIPBOARD_INVALID');
    const previous = collections[bound];
    const collection = collections[bound] ??= { items: [], records: {} };
    const next = result.items.map(({ id, title }) => ({ id, title }));
    if (!previous || JSON.stringify(collection.items) !== JSON.stringify(next)) {
      collection.items = next;
      for (const { id } of next) {
        if (collection.records[id]) delete collection.records[id].createdHere;
      }
      await persist();
    }
  }

  function wake() {
    const bound = scope(), ready = online();
    if (unsupportedScope !== bound || (ready && !wasOnline)) unsupportedScope = undefined;
    wasOnline = ready;
    for (const [id, row] of Object.entries(current()?.records || {})) {
      if (row.dirty || row.pending) note(id).wake();
    }
  }

  async function create() {
    const bound = scope(), collection = current();
    if (!bound || !collection) throw fail('CLIPBOARD_NOT_FOUND');
    if (summaries().length >= 100) throw fail('CLIPBOARD_NOTE_COUNT_LIMIT');
    const id = randomUUID().replaceAll('-', '');
    collection.records[id] = { ...emptyNote(), revision: 0, dirty: true, createdHere: true };
    try { await persist(); }
    catch (error) { delete collection.records[id]; throw error; }
    if (scope() !== bound) throw fail('SPACE_CONTEXT_CHANGED');
    note(id).wake();
    changed();
    return id;
  }

  async function remove(id) {
    const worker = note(id);
    if (worker.snapshot().conflict?.deleted) {
      await worker.command('remote');
    } else {
      if (!online()) throw fail('BOX_CONNECTION_REQUIRED');
      await worker.command('delete');
      await worker.flush();
    }
  }

  return {
    summaries, note, refresh, create, remove, wake,
    async close() { await Promise.all([...workers.values()].map(worker => worker.close({ persistState: false }))); },
  };
}
