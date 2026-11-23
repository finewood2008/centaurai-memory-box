export type CorrectionSource = {
  id: string;
  text: string;
  text_truncated?: boolean;
  full_text_chars?: number;
  canonical_start?: number;
  canonical_end?: number;
};

export function loadCorrectionSegments<T extends CorrectionSource>(
  detail: { document: { id: string; segment_count: number }; version: { id: string } | null; segments: T[] },
  offset: number, current: () => boolean, request: (url: string) => Promise<unknown>,
): Promise<T[]>;
