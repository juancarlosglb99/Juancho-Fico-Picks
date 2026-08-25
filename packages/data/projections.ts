import type { ProjectionMappingResult } from '../projections/types';
import type {
  AdpSnapshot,
  ProjectionSnapshot,
  ResolutionSummary,
} from './types';

const STAT_FIELDS = [
  'passingYards',
  'passingTouchdowns',
  'interceptions',
  'rushingYards',
  'rushingTouchdowns',
  'receptions',
  'receivingYards',
  'receivingTouchdowns',
  'fumblesLost',
] as const;

function projectionResolution(mapping: ProjectionMappingResult): ResolutionSummary {
  const matched = mapping.mapped.length;
  return {
    total: matched + mapping.unmatched.length,
    matched,
    directExternalId: mapping.mapped.filter((item) => item.matchMethod === 'sleeper-id').length,
    exactCanonical: mapping.mapped.filter((item) => item.matchMethod === 'name-position').length,
    normalizedName: mapping.mapped.filter((item) => item.matchMethod === 'unique-name').length,
    ambiguous: mapping.unmatched.filter((item) => item.reason === 'ambiguous-name').length,
    unresolved: mapping.unmatched.filter((item) => item.reason === 'player-not-found').length,
  };
}

function hasCompleteStatLine(record: ProjectionMappingResult['mapped'][number]): boolean {
  if (!record.stats) return false;
  if (record.position === 'QB') {
    return [
      'passingYards',
      'passingTouchdowns',
      'interceptions',
      'rushingYards',
      'rushingTouchdowns',
      'fumblesLost',
    ].every((field) => typeof record.stats?.[field as keyof typeof record.stats] === 'number');
  }
  if (['RB', 'WR', 'TE'].includes(record.position)) {
    return [
      'rushingYards',
      'rushingTouchdowns',
      'receptions',
      'receivingYards',
      'receivingTouchdowns',
      'fumblesLost',
    ].every((field) => typeof record.stats?.[field as keyof typeof record.stats] === 'number');
  }
  return STAT_FIELDS.every((field) => typeof record.stats?.[field] === 'number');
}

export function createCsvProjectionSnapshot({
  mapping,
  filename,
  season,
  now = new Date(),
}: {
  mapping: ProjectionMappingResult;
  filename: string;
  season: string;
  now?: Date;
}): ProjectionSnapshot {
  const scoringValues = new Set(
    mapping.mapped
      .map((record) => record.projectionScoring?.trim().toLowerCase().replace(/[\s-]+/g, '_'))
      .filter(Boolean),
  );
  const scoringFormat =
    scoringValues.size === 1 &&
    ['standard', 'half_ppr', 'full_ppr', 'custom'].includes([...scoringValues][0]!)
      ? ([...scoringValues][0] as ProjectionSnapshot['scoringFormat'])
      : 'unknown';
  const fetchedAt = now.toISOString();
  return {
    kind: 'projection',
    provenance: {
      sourceId: 'csv',
      sourceLabel: `CSV · ${filename}`,
      season,
      fetchedAt,
      sourceUpdatedAt: null,
      sourceConfidence: mapping.mapped.length > 0 ? 'medium' : 'low',
    },
    filename,
    scoringFormat,
    records: mapping.mapped.map((record) => ({
      ...record,
      projectionSource: `CSV · ${filename}`,
      projectionFetchedAt: fetchedAt,
      projectionSourceUpdatedAt: null,
      projectionSourceConfidence: 'medium',
      adpSource: `CSV · ${filename}`,
      adpFetchedAt: fetchedAt,
      adpSourceUpdatedAt: null,
      adpScoringFormat: record.projectionScoring,
      adpSourceConfidence: record.adpFormat ? 'medium' : 'low',
      adpMatchLevel: record.adpFormat ? 'approximate' : 'weak',
      adpMatchReasons: record.adpFormat
        ? ['CSV-declared ADP format; source freshness and sample size are unavailable.']
        : ['CSV ADP format, freshness, and sample size are unavailable.'],
    })),
    unmatched: mapping.unmatched,
    resolution: projectionResolution(mapping),
    completeStatLines: mapping.mapped.filter(hasCompleteStatLine).length,
  };
}

export function isProjectionSnapshot(value: unknown): value is ProjectionSnapshot {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<ProjectionSnapshot>;
  return (
    candidate.kind === 'projection' &&
    typeof candidate.filename === 'string' &&
    Array.isArray(candidate.records) &&
    candidate.records.length > 0 &&
    candidate.records.every(
      (record) =>
        !!record &&
        typeof record.playerId === 'string' &&
        record.playerId.length > 0 &&
        typeof record.playerName === 'string' &&
        record.playerName.trim().length > 0 &&
        typeof record.position === 'string' &&
        record.position !== 'UNKNOWN' &&
        Number.isFinite(record.projection) &&
        Number.isFinite(record.adp) &&
        record.adp > 0 &&
        Number.isFinite(record.rank) &&
        record.rank > 0,
    ) &&
    Array.isArray(candidate.unmatched) &&
    !!candidate.provenance &&
    typeof candidate.provenance.fetchedAt === 'string' &&
    Number.isFinite(Date.parse(candidate.provenance.fetchedAt))
  );
}

export function composeProjectionAndAdp(
  projections: ProjectionSnapshot,
  adp: AdpSnapshot | null,
): ProjectionSnapshot['records'] {
  if (!adp || adp.records.length === 0) return projections.records;
  const byPlayerId = new Map(adp.records.map((record) => [record.playerId, record]));
  return projections.records.map((projection) => {
    const automatic = byPlayerId.get(projection.playerId);
    if (!automatic) return projection;
    return {
      ...projection,
      adp: automatic.adp,
      rank: automatic.rank,
      adpFormat: adp.context.leagueFormat,
      adpSource: adp.provenance.sourceLabel,
      adpFetchedAt: adp.provenance.fetchedAt,
      adpSourceUpdatedAt: adp.provenance.sourceUpdatedAt,
      adpTeams: adp.context.teams,
      adpScoringFormat: adp.context.scoringFormat,
      adpSampleSize: automatic.sampleSize,
      adpSourceConfidence: adp.compatibility.confidence,
      adpMatchLevel: adp.compatibility.level,
      adpMatchReasons: adp.compatibility.reasons,
    };
  });
}
