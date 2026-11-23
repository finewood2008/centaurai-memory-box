import { requestJson } from './request.ts';
import { loadCorrectionSegments as loadSegments, type CorrectionSource } from '../../shared/source-correction.mjs';

export type { CorrectionSource };
type SourceDetail<T> = { document: { id: string; segment_count: number }; version: { id: string } | null; segments: T[] };

export function loadCorrectionSegments<T extends CorrectionSource>(
  detail: SourceDetail<T>, offset: number, current: () => boolean,
  request: typeof requestJson = requestJson,
): Promise<T[]> {
  return loadSegments(detail, offset, current, url => request(url, undefined, 15000));
}
