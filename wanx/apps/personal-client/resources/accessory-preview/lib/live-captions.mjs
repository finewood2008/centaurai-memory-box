import { media } from './media.mjs';
import { cleanText } from './util.mjs';

const sessions = new Map();

export function captions(id) {
  const state = sessions.get(id);
  return { lines: state ? [...state.lines.values()] : [], status: state?.status || 'waiting' };
}

export async function sendLiveFrame(id, frame, service = media) {
  let state = sessions.get(id);
  if (!state) {
    state = { lines: new Map(), generation: 0, status: 'connecting', stream: null, attemptAt: 0, opening: null };
    sessions.set(id, state);
  }
  if (!state.stream && !state.opening && Date.now() >= state.attemptAt) {
    const generation = ++state.generation;
    const close = () => {
      if (generation !== state.generation) return;
      state.stream = null;
      state.attemptAt = Date.now() + 1000;
      state.status = 'reconnecting';
    };
    state.status = 'connecting';
    state.opening = service.openLive((event) => {
      if (generation !== state.generation) return;
      if (event.type === 'error') { state.stream?.end(); close(); return; }
      if (!['partial', 'final'].includes(event.type) || !Number.isInteger(event.segmentId)) return;
      const key = generation + ':' + event.segmentId;
      const line = cleanText(event.text, 1800);
      if (state.lines.get(key)?.final && event.type !== 'final') return;
      if (line) state.lines.set(key, { key, text: line, final: event.type === 'final' });
      else if (!state.lines.get(key)?.final) state.lines.delete(key);
      if (state.lines.size > 150) state.lines.delete(state.lines.keys().next().value);
    }, close).then(stream => {
      if (generation !== state.generation || !sessions.has(id)) { stream.end(); return; }
      state.stream = stream;
      state.status = 'live';
    }).catch(() => {
      if (generation !== state.generation) return;
      state.status = 'offline';
      state.attemptAt = Date.now() + 3500;
    }).finally(() => { state.opening = null; });
  }
  if (state.opening) await state.opening;
  if (state.stream && !state.stream.send(frame)) {
    state.stream.end();
    state.stream = null;
    state.status = 'reconnecting';
  }
  return state.status;
}

export function finishCaptions(id) {
  const state = sessions.get(id);
  if (!state) return;
  state.generation++;
  state.stream?.end();
  sessions.delete(id);
}
