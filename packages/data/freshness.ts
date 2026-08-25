import type {
  DataFreshness,
  SourceConfidence,
  SourceProvenance,
} from './types';

const DAY_MS = 24 * 60 * 60 * 1000;

export function sourceAgeMs(
  provenance: Pick<SourceProvenance, 'sourceUpdatedAt' | 'fetchedAt'>,
  now = new Date(),
): number {
  const timestamp = provenance.sourceUpdatedAt ?? provenance.fetchedAt;
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? Math.max(0, now.getTime() - parsed) : Infinity;
}

export function dataFreshness(
  provenance: Pick<SourceProvenance, 'sourceUpdatedAt' | 'fetchedAt'>,
  now = new Date(),
): DataFreshness {
  const age = sourceAgeMs(provenance, now);
  if (age <= 2 * DAY_MS) return 'fresh';
  if (age <= 7 * DAY_MS) return 'aging';
  return 'stale';
}

export function confidenceForFreshness(
  confidence: SourceConfidence,
  freshness: DataFreshness,
): SourceConfidence {
  if (freshness === 'fresh') return confidence;
  if (freshness === 'stale') return 'low';
  return confidence === 'high' ? 'medium' : confidence;
}

export function formatDataAge(ageMs: number): string {
  if (!Number.isFinite(ageMs)) return 'unknown age';
  const hours = Math.floor(ageMs / (60 * 60 * 1000));
  if (hours < 1) return 'less than an hour ago';
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}
