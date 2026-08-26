import { dataFreshness } from '../data/freshness';
import type {
  DraftRoomRankingSnapshot,
  DraftRoomRankingSourceSnapshot,
  FormatCompatibility,
  MappedDraftRoomRankingRecord,
  PlayerResolutionMethod,
  ProjectionSnapshot,
  ProjectionSourceSnapshot,
  ResolutionSummary,
} from '../data/types';
import type { LeagueContext } from '../engine/context/types';
import { normalizePlayerName } from '../players/player-map';
import type { CanonicalPlayer, CanonicalPlayerMap } from '../players/types';
import { mapProjectionRecords } from '../projections/mapping';

function projectionResolution(
  mapped: ProjectionSnapshot['records'],
  unmatched: ProjectionSnapshot['unmatched'],
): ResolutionSummary {
  return {
    total: mapped.length + unmatched.length,
    matched: mapped.length,
    directExternalId: mapped.filter((record) => record.matchMethod === 'sleeper-id').length,
    exactCanonical: mapped.filter((record) => record.matchMethod === 'name-position').length,
    normalizedName: mapped.filter((record) => record.matchMethod === 'unique-name').length,
    ambiguous: unmatched.filter((record) => record.reason === 'ambiguous-name').length,
    unresolved: unmatched.filter((record) => record.reason === 'player-not-found').length,
  };
}

export function mapFirstSeedProjectionSnapshot(
  source: ProjectionSourceSnapshot,
  players: CanonicalPlayerMap,
): ProjectionSnapshot {
  const mapping = mapProjectionRecords(source.records, players);
  const sorted = [...mapping.mapped].sort(
    (a, b) => b.projection - a.projection || a.playerName.localeCompare(b.playerName),
  );
  return {
    kind: 'projection',
    provenance: source.provenance,
    filename: `First Seed · ${source.sheet}`,
    scoringFormat: source.scoringFormat,
    records: sorted.map((record, index) => ({
      ...record,
      rank: index + 1,
      projectionSource: source.provenance.sourceLabel,
      projectionFetchedAt: source.provenance.fetchedAt,
      projectionSourceUpdatedAt: source.provenance.sourceUpdatedAt,
      projectionSourceConfidence: source.provenance.sourceConfidence,
    })),
    unmatched: mapping.unmatched,
    resolution: projectionResolution(mapping.mapped, mapping.unmatched),
    completeStatLines: 0,
  };
}

function resolvedRoomRecord(
  record: DraftRoomRankingSourceSnapshot['records'][number],
  player: CanonicalPlayer,
  resolutionMethod: PlayerResolutionMethod,
): MappedDraftRoomRankingRecord {
  return {
    ...record,
    playerId: player.id,
    resolutionMethod,
    resolutionConfidence:
      resolutionMethod === 'direct-external-id'
        ? 1
        : resolutionMethod === 'normalized-unique-name'
          ? 0.8
          : 0.95,
  };
}

function roomCompatibility(
  source: DraftRoomRankingSourceSnapshot,
  context: LeagueContext,
  now: Date,
): FormatCompatibility {
  const reasons: string[] = [];
  let level: FormatCompatibility['level'] = 'exact';
  let confidence: FormatCompatibility['confidence'] = source.provenance.sourceConfidence;
  const expectedQb = context.roster.value.SUPER_FLEX > 0 || context.roster.value.QB >= 2
    ? 'superflex'
    : '1qb';
  if (source.context.qbFormat !== expectedQb) {
    level = 'weak';
    confidence = 'low';
    reasons.push(`${source.context.qbFormat.toUpperCase()} room order does not match ${expectedQb.toUpperCase()} demand.`);
  }
  if (context.scoring.value.profile === 'custom') {
    if (level !== 'weak') level = 'approximate';
    confidence = 'medium';
    reasons.push('The nearest First Seed reception format is used for custom scoring.');
  } else if (source.context.scoringFormat !== context.scoring.value.profile) {
    level = 'weak';
    confidence = 'low';
    reasons.push('The room-ranking scoring format differs from the league.');
  }
  if (dataFreshness(source.provenance, now) === 'stale') {
    level = 'weak';
    confidence = 'low';
    reasons.push('The weekly room-ranking snapshot is stale.');
  }
  if (reasons.length === 0) {
    reasons.push('Platform, quarterback demand, and reception scoring match the league.');
  }
  return { level, confidence, reasons };
}

export function mapFirstSeedDraftRoomRankingSnapshot(
  source: DraftRoomRankingSourceSnapshot,
  players: CanonicalPlayerMap,
  context: LeagueContext,
  now = new Date(),
): DraftRoomRankingSnapshot {
  const records: MappedDraftRoomRankingRecord[] = [];
  const unresolved: DraftRoomRankingSnapshot['unresolved'] = [];
  for (const record of source.records) {
    if (record.position === 'DEF' && record.team) {
      const defense = players.bySleeperId.get(record.team);
      if (defense?.position === 'DEF') {
        records.push(resolvedRoomRecord(record, defense, 'canonical-team-defense'));
        continue;
      }
    }
    const name = normalizePlayerName(record.playerName);
    const exact = players.byNameAndPosition.get(`${name}|${record.position}`);
    if (exact?.length === 1) {
      records.push(resolvedRoomRecord(record, exact[0], 'exact-name-position'));
      continue;
    }
    const matches = players.byName.get(name);
    if (matches?.length === 1) {
      records.push(resolvedRoomRecord(record, matches[0], 'normalized-unique-name'));
      continue;
    }
    unresolved.push({
      ...record,
      reason: matches && matches.length > 1 ? 'ambiguous-name' : 'player-not-found',
    });
  }
  const resolution: ResolutionSummary = {
    total: source.records.length,
    matched: records.length,
    directExternalId: 0,
    exactCanonical: records.filter((record) => record.resolutionMethod !== 'normalized-unique-name').length,
    normalizedName: records.filter((record) => record.resolutionMethod === 'normalized-unique-name').length,
    ambiguous: unresolved.filter((record) => record.reason === 'ambiguous-name').length,
    unresolved: unresolved.filter((record) => record.reason === 'player-not-found').length,
  };
  return {
    kind: 'draft-room-ranking',
    provenance: source.provenance,
    context: source.context,
    records,
    unresolved,
    resolution,
    compatibility: roomCompatibility(source, context, now),
  };
}

export function isProjectionSourceSnapshot(value: unknown): value is ProjectionSourceSnapshot {
  if (!value || typeof value !== 'object') return false;
  const snapshot = value as Partial<ProjectionSourceSnapshot>;
  return snapshot.kind === 'projection-source' &&
    !!snapshot.provenance &&
    Array.isArray(snapshot.records) &&
    snapshot.records.length >= 100 &&
    snapshot.records.every((record) =>
      !!record && typeof record.playerName === 'string' &&
      typeof record.position === 'string' && Number.isFinite(record.projection),
    );
}

export function isDraftRoomRankingSourceSnapshot(
  value: unknown,
): value is DraftRoomRankingSourceSnapshot {
  if (!value || typeof value !== 'object') return false;
  const snapshot = value as Partial<DraftRoomRankingSourceSnapshot>;
  return snapshot.kind === 'draft-room-ranking-source' &&
    !!snapshot.provenance && !!snapshot.context &&
    Array.isArray(snapshot.records) && snapshot.records.length >= 80 &&
    snapshot.records.every((record) =>
      !!record && typeof record.playerName === 'string' &&
      typeof record.position === 'string' && Number.isFinite(record.rank) && record.rank > 0,
    );
}
