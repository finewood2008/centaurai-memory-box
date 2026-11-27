import { cleanText, HttpError } from './util.mjs';

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_TURNS = 100000;

export const newSpeakers = () => ({
  status: 'none', error: '', rev: 0, expectedSpeakers: null, turns: [],
  labels: [], aliases: {}, edits: [], nextLabel: 1, generation: 0, corrected: false, requestId: null,
});

export function speakerIds(value, limit = 16) {
  if (!Array.isArray(value) || value.length > limit || !value.every(id => typeof id === 'string' && ID.test(id))) return null;
  return [...new Set(value)];
}

export function expectedSpeakerCount(value) {
  if (value == null) return null;
  if (!Number.isSafeInteger(value) || value < 1 || value > 12) {
    throw new HttpError(400, '预期人数必须在 1 到 12 之间');
  }
  return value;
}

const sharedMs = (a, b) => Math.max(0, Math.min(a.endMs, b.endMs) - Math.max(a.startMs, b.startMs));
const idKey = ids => [...ids].sort().join(',');
const sameIds = (a, b) => idKey(a) === idKey(b);
const canonical = (state, ids) => [...new Set(ids.map(id => state.aliases[id] || id))];

export function normalizeTurns(result, audioDurationMs) {
  const { durationMs, speakerTurns } = result || {};
  if (!Number.isFinite(durationMs) || durationMs <= 0 || Math.abs(durationMs - audioDurationMs) > 1500 ||
      !Array.isArray(speakerTurns) || speakerTurns.length > MAX_TURNS) {
    throw new Error('盒端说话人时间轴无效');
  }
  const turns = [];
  for (const turn of speakerTurns) {
    const ids = speakerIds(turn?.speakerIds);
    if (!ids || !Number.isFinite(turn.startMs) || !Number.isFinite(turn.endMs) ||
        turn.startMs < 0 || turn.endMs <= turn.startMs || turn.endMs > durationMs) {
      throw new Error('盒端说话人时间轴无效');
    }
    if (turn.startMs < audioDurationMs) {
      turns.push({ startMs: turn.startMs, endMs: Math.min(turn.endMs, audioDurationMs), speakerIds: ids });
    }
  }
  return turns.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
}

function soloTime(turns) {
  const counts = new Map();
  for (const turn of turns) {
    if (turn.speakerIds.length !== 1) continue;
    const [id] = turn.speakerIds;
    counts.set(id, (counts.get(id) || 0) + turn.endMs - turn.startMs);
  }
  return counts;
}

function bestMatches(scores) {
  const wins = new Map();
  for (const [id, candidates] of scores) {
    const [[best, overlap], runnerUp] = [...candidates].sort((a, b) => b[1] - a[1]);
    if (!runnerUp || overlap >= runnerUp[1] * 1.4) wins.set(id, { id: best, overlap });
  }
  return wins;
}

// Box IDs belong to one inference run. Match by substantial mutual agreement
// in solo speech before carrying any manual name or merge to a fresh run.
function matchLabels(previous, current) {
  const toPrevious = new Map(), toCurrent = new Map();
  function add(scores, from, to, duration) {
    if (!scores.has(from)) scores.set(from, new Map());
    const row = scores.get(from);
    row.set(to, (row.get(to) || 0) + duration);
  }
  let first = 0;
  for (const turn of current) {
    if (turn.speakerIds.length !== 1) continue;
    while (first < previous.length && previous[first].endMs <= turn.startMs) first++;
    for (let j = first; j < previous.length && previous[j].startMs < turn.endMs; j++) {
      const old = previous[j];
      const duration = sharedMs(turn, old);
      if (!duration || old.speakerIds.length !== 1) continue;
      const [currentId] = turn.speakerIds, [oldId] = old.speakerIds;
      add(toPrevious, currentId, oldId, duration);
      add(toCurrent, oldId, currentId, duration);
    }
  }
  const oldDuration = soloTime(previous), newDuration = soloTime(current);
  const matches = new Map(), reverse = bestMatches(toCurrent);
  for (const [newId, match] of bestMatches(toPrevious)) {
    const oldId = match.id;
    if (reverse.get(oldId)?.id === newId && match.overlap / Math.max(oldDuration.get(oldId), newDuration.get(newId)) >= 0.55) {
      matches.set(newId, oldId);
    }
  }
  return matches;
}

export function withSpeakerTurns(state, turns) {
  const next = { ...state, labels: [...state.labels], rev: state.rev + 1, generation: state.generation + 1, corrected: true };
  const ids = matchLabels(state.turns, turns);
  next.turns = turns.map(turn => ({ ...turn, speakerIds: turn.speakerIds.map(id => {
    if (!ids.has(id)) {
      const labelId = 'speaker-' + next.nextLabel;
      next.labels.push({ id: labelId, name: '发言人 ' + next.nextLabel++ });
      ids.set(id, labelId);
    }
    return ids.get(id);
  }) }));
  const retained = new Set(next.turns.flatMap(turn => turn.speakerIds));
  for (const edit of next.edits) for (const id of edit.speakerIds) retained.add(id);
  for (const id of [...retained]) if (next.aliases[id]) retained.add(next.aliases[id]);
  next.labels = next.labels.filter(label => label.renamed || label.manual || retained.has(label.id));
  return next;
}

function addEditCandidates(edits, segments) {
  const candidates = new Map();
  const exact = new Map(segments.map(s => [JSON.stringify([s.fromMs, s.toMs, s.text]), s.i]));
  for (const edit of edits) {
    const exactIndex = exact.get(JSON.stringify([edit.startMs, edit.endMs, edit.text]));
    if (exactIndex !== undefined) {
      candidates.set(exactIndex, { edit, matched: true });
      continue;
    }
    let best = null, tied = false;
    for (const segment of segments) {
      if (segment.fromMs >= edit.endMs) break;
      const duration = sharedMs(edit, { startMs: segment.fromMs, endMs: segment.toMs });
      if (!duration) continue;
      if (!best || duration > best.duration) { best = { segment, duration }; tied = false; }
      else if (duration === best.duration) tied = true;
    }
    if (best && !candidates.has(best.segment.i)) {
      candidates.set(best.segment.i, { edit, matched: !tied && best.segment.text === edit.text &&
        best.duration >= 0.8 * Math.max(edit.endMs - edit.startMs, best.segment.toMs - best.segment.fromMs) });
    }
  }
  return candidates;
}

export function speakerProjection(state, segments) {
  const { status, error, rev, expectedSpeakers, corrected } = state;
  const labels = state.labels.filter(({ id }) => !state.aliases[id]).map(({ id, name }) => ({ id, name }));
  const turns = state.turns.map(turn => ({ ...turn, speakerIds: canonical(state, turn.speakerIds) }));
  const active = new Set(turns.flatMap(turn => turn.speakerIds));
  for (const label of state.labels) if (label.manual && !state.aliases[label.id]) active.add(label.id);
  const edits = addEditCandidates(state.edits, segments);
  const conflicts = [];
  let first = 0;
  const annotated = segments.map(segment => {
    if (!corrected && !edits.has(segment.i)) return segment;
    const window = { startMs: segment.fromMs, endMs: segment.toMs };
    while (first < turns.length && turns[first].endMs <= window.startMs) first++;
    const votes = new Map();
    let overlapAtMs;
    let unknownAtMs;
    for (let j = first; j < turns.length && turns[j].startMs < window.endMs; j++) {
      const turn = turns[j], duration = sharedMs(window, turn);
      if (!duration) continue;
      const position = Math.max(window.startMs, turn.startMs);
      if (turn.speakerIds.length > 1) overlapAtMs ??= position;
      if (turn.speakerIds.length === 0) unknownAtMs ??= position;
      const key = idKey(turn.speakerIds);
      votes.set(key, (votes.get(key) || 0) + duration);
    }
    const [best, second] = [...votes].sort((a, b) => b[1] - a[1]);
    const automatic = best && best[0] && best[1] !== second?.[1] ? best[0].split(',') : [];
    const attributions = {
      ...(overlapAtMs !== undefined && { overlapAtMs }),
      ...(unknownAtMs !== undefined && { unknownAtMs }),
    };
    const candidate = edits.get(segment.i);
    if (!candidate) return { ...segment, ...attributions, speakerIds: automatic, speakerConflict: false };
    const { edit, matched } = candidate;
    const previousSpeakerIds = canonical(state, edit.speakerIds);
    const speakerConflict = !matched || (edit.generation !== state.generation && previousSpeakerIds.some(id => !active.has(id))) ||
      (!sameIds(automatic, previousSpeakerIds) && !sameIds(automatic, canonical(state, edit.automatic)));
    if (speakerConflict) conflicts.push({ segmentIndex: segment.i, previousSpeakerIds, speakerIds: automatic });
    return { ...segment, ...attributions, speakerIds: matched ? previousSpeakerIds : automatic, speakerConflict };
  });
  return { speakers: { status, error, rev, expectedSpeakers, corrected, labels, turns, conflicts }, segments: annotated };
}

export function editSpeakerState(state, body, segments) {
  if (body.rev !== state.rev) throw new HttpError(409, '发言归属已更新，请刷新后重试');
  const labels = new Map(state.labels.filter(({ id }) => !state.aliases[id]).map(label => [label.id, label]));
  const speakerId = body.speakerId;
  switch (body.action) {
    case 'rename': {
      const name = cleanText(body.name, 41);
      if (!labels.has(speakerId) || typeof body.name !== 'string' || !name || name.length > 40) throw new HttpError(400, '发言人或姓名无效（最多 40 字）');
      return { ...state, labels: state.labels.map(label => label.id === speakerId ? { ...label, name, renamed: true } : label), rev: state.rev + 1 };
    }
    case 'merge': {
      const targetId = body.targetId;
      if (speakerId === targetId || !labels.has(speakerId) || !labels.has(targetId)) throw new HttpError(400, '发言人合并目标无效');
      const aliases = Object.fromEntries(Object.entries(state.aliases).map(([id, target]) => [id, target === speakerId ? targetId : target]));
      aliases[speakerId] = targetId;
      return { ...state, aliases, rev: state.rev + 1 };
    }
    case 'assign': {
      const segment = segments.find(item => item.i === body.segmentIndex);
      const ids = speakerIds(body.speakerIds);
      if (!segment || !ids || ids.some(id => !labels.has(id))) throw new HttpError(400, '转录段落或发言人无效');
      let next = state;
      if (body.newName !== undefined) {
        const name = cleanText(body.newName, 41);
        if (typeof body.newName !== 'string' || !name || name.length > 40 || ids.length >= 16) {
          throw new HttpError(400, '发言人姓名无效或该段人数已达上限（姓名最多 40 字）');
        }
        const id = 'speaker-' + state.nextLabel;
        ids.push(id);
        next = { ...state, labels: [...state.labels, { id, name, manual: true }], nextLabel: state.nextLabel + 1 };
      }
      const source = { startMs: segment.fromMs, endMs: segment.toMs, text: segment.text };
      const { speakerIds: automatic = [] } = speakerProjection({ ...state, edits: [] }, [segment]).segments[0];
      const candidates = addEditCandidates(state.edits, segments);
      const existing = candidates.get(segment.i)?.edit;
      const edits = state.edits.filter(edit => edit !== existing && !(edit.startMs === source.startMs && edit.endMs === source.endMs && edit.text === source.text));
      return { ...next, edits: [...edits, { ...source, speakerIds: ids, automatic, generation: state.generation }], rev: state.rev + 1 };
    }
    default:
      throw new HttpError(400, '发言人修订操作无效');
  }
}
