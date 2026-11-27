import { media } from './media.mjs';
import { cleanText } from './util.mjs';
import { speakerIds } from './speaker-annotations.mjs';

const sessions = new Map();

export function captions(id) {
  const state = sessions.get(id);
  return { lines: state ? [...state.lines.values()] : [], status: state?.status || 'waiting' };
}

export async function sendLiveFrame(id, frame, service = media, previousLines = [], positionMs, cloudConsent = false) {
  let state = sessions.get(id);
  if (!state) {
    const generation = Math.max(0, ...previousLines.map(line => Number(line.key.split(':')[0]) || 0));
    const lastLabel = Math.max(0, ...previousLines.flatMap(line => (line.speakerIds || []).map(id => Number(id.slice(5)) || 0)));
    const lines = new Map(previousLines.map(line => [line.key, line]));
    state = { lines, nextLabel: lastLabel + 1, generation, status: 'connecting', stream: null, attemptAt: 0, opening: null };
    sessions.set(id, state);
  }
  if (state.finishing) return 'ending';
  if (Number.isFinite(positionMs)) state.positionMs = positionMs;
  if (!state.stream && !state.opening && Date.now() >= state.attemptAt) {
    const generation = ++state.generation;
    const mapped = new Map();
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
      if (!['partial', 'final', 'speaker'].includes(event.type) || !Number.isSafeInteger(event.segmentId)) return;
      const key = generation + ':' + event.segmentId;
      const prior = state.lines.get(key);
      if (event.type === 'speaker') {
        const ids = speakerIds(event.speakerIds);
        if (!prior || !ids) return;
        state.lines.set(key, { ...prior, speakerIds: ids.map(id => {
          if (!mapped.has(id)) mapped.set(id, 'live-' + state.nextLabel++);
          return mapped.get(id);
        }) });
        return;
      }
      const line = cleanText(event.text, 1800);
      if (prior?.final && event.type !== 'final') return;
      if (line) {
        const receivedAtMs = prior?.receivedAtMs ?? state.positionMs;
        state.lines.set(key, { ...prior, key, text: line, final: event.type === 'final',
          ...(receivedAtMs !== undefined && { receivedAtMs }) });
      }
      else if (!prior?.final) state.lines.delete(key);
      if (state.lines.size > 150) state.lines.delete(state.lines.keys().next().value);
    }, close, cloudConsent).then(stream => {
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

export async function finishCaptions(id) {
  const state = sessions.get(id);
  if (!state) return [];
  state.finishing = true;
  try {
    // A pending handshake may outlive the recording. Its generation check closes it on arrival.
    try { await state.stream?.end(); } catch { /* Keep the draft when the stream has disconnected. */ }
    return [...state.lines.values()];
  } finally {
    state.generation++;
    sessions.delete(id);
  }
}
