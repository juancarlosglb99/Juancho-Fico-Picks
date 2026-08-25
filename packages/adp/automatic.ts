import type { LeagueContext, ScoringProfile } from '../engine/context/types';
import { normalizePlayerName } from '../players/player-map';
import type { CanonicalPlayer, CanonicalPlayerMap } from '../players/types';
import { confidenceForFreshness, dataFreshness } from '../data/freshness';
import type {
  AdpProviderRequest,
  AdpSnapshot,
  AdpSourceSnapshot,
  AutomaticAdpPlan,
  DataMatchLevel,
  FormatCompatibility,
  MappedAdpRecord,
  PlayerResolutionMethod,
  ResolutionSummary,
  SourceConfidence,
  UnresolvedAdpRecord,
} from '../data/types';
import { isAdpSourceSnapshot } from './providers/fantasy-football-calculator';

const SUPPORTED_TEAMS = [8, 10, 12, 14] as const;

function closestSupportedTeams(teams: number): number {
  return [...SUPPORTED_TEAMS].sort(
    (a, b) => Math.abs(a - teams) - Math.abs(b - teams),
  )[0];
}

function nearestScoringFormat(
  profile: ScoringProfile,
  receptionPoints: number,
): AdpProviderRequest['format'] {
  if (profile === 'full_ppr') return 'ppr';
  if (profile === 'half_ppr') return 'half-ppr';
  if (profile === 'custom') {
    if (receptionPoints >= 0.75) return 'ppr';
    if (receptionPoints >= 0.25) return 'half-ppr';
  }
  return 'standard';
}

export function planAutomaticAdp(
  context: LeagueContext,
  season: string,
): AutomaticAdpPlan | null {
  if (context.leagueType.value === 'dynasty' || context.leagueType.value === 'unknown') {
    return null;
  }
  if (context.draftType.value === 'auction') return null;
  const superflex = context.roster.value.SUPER_FLEX > 0 || context.roster.value.QB >= 2;
  const teams = closestSupportedTeams(context.teams.value);
  const notes: string[] = [];
  if (teams !== context.teams.value) {
    notes.push(`${teams}-team ADP is the closest supported size to this ${context.teams.value}-team league.`);
  }
  if (superflex) {
    notes.push('The 2-QB source matches quarterback demand but does not declare reception scoring.');
  }
  if (context.scoring.value.profile === 'custom') {
    notes.push('The nearest reception format is used for custom scoring.');
  }
  if (context.leagueType.value === 'keeper') {
    notes.push('Redraft ADP does not include this league’s keeper pool or keeper costs.');
  }
  return {
    request: {
      season,
      teams,
      format: superflex
        ? '2qb'
        : nearestScoringFormat(
            context.scoring.value.profile,
            context.scoring.value.reception.base,
          ),
    },
    expectedLeagueFormat: superflex ? 'redraft_superflex' : 'redraft_1qb',
    notes,
  };
}

function lowerConfidence(
  current: SourceConfidence,
  ceiling: SourceConfidence,
): SourceConfidence {
  const order: SourceConfidence[] = ['low', 'medium', 'high'];
  return order.indexOf(current) <= order.indexOf(ceiling) ? current : ceiling;
}

function assessCompatibility(
  snapshot: AdpSourceSnapshot,
  context: LeagueContext,
  now = new Date(),
): FormatCompatibility {
  const reasons: string[] = [];
  let level: DataMatchLevel = 'exact';
  let confidence = confidenceForFreshness(
    snapshot.provenance.sourceConfidence,
    dataFreshness(snapshot.provenance, now),
  );
  const expectedQb =
    context.roster.value.SUPER_FLEX > 0 || context.roster.value.QB >= 2
      ? 'superflex'
      : '1qb';
  if (snapshot.context.qbFormat !== expectedQb) {
    level = 'weak';
    confidence = 'low';
    reasons.push(`${snapshot.context.qbFormat.toUpperCase()} ADP does not match ${expectedQb.toUpperCase()} quarterback demand.`);
  }
  if (snapshot.context.teams !== context.teams.value) {
    if (level !== 'weak') level = 'approximate';
    confidence = lowerConfidence(confidence, 'medium');
    reasons.push(`${snapshot.context.teams}-team ADP is used for a ${context.teams.value}-team league.`);
  }
  const profile = context.scoring.value.profile;
  if (snapshot.context.scoringFormat === 'unknown') {
    if (level !== 'weak') level = 'approximate';
    confidence = lowerConfidence(confidence, 'medium');
    reasons.push('The ADP source does not declare reception scoring for this format.');
  } else if (profile === 'custom') {
    if (level !== 'weak') level = 'approximate';
    confidence = lowerConfidence(confidence, 'medium');
    reasons.push('Custom Sleeper scoring differs from the source’s broad reception format.');
  } else if (snapshot.context.scoringFormat !== profile) {
    level = 'weak';
    confidence = 'low';
    reasons.push(`${snapshot.context.scoringFormat.replaceAll('_', ' ')} ADP does not match ${profile.replaceAll('_', ' ')} scoring.`);
  }
  if (context.leagueType.value === 'keeper') {
    if (level !== 'weak') level = 'approximate';
    confidence = lowerConfidence(confidence, 'medium');
    reasons.push('Redraft ADP cannot account for this league’s retained players and keeper costs.');
  }
  if (context.lineupType.value !== 'classic') {
    level = 'weak';
    confidence = 'low';
    reasons.push(`${context.lineupType.value.replaceAll('_', ' ')} lineup strategy is not represented by this ADP source.`);
  }
  const freshness = dataFreshness(snapshot.provenance, now);
  if (freshness === 'aging') reasons.push('The source is more than two days old.');
  if (freshness === 'stale') {
    level = 'weak';
    confidence = 'low';
    reasons.push('The source is more than seven days old.');
  }
  if (reasons.length === 0) {
    reasons.push('League size, quarterback format, and reception scoring match the source.');
  }
  return { level, confidence, reasons };
}

function mapped(
  record: AdpSourceSnapshot['records'][number],
  player: CanonicalPlayer,
  resolutionMethod: PlayerResolutionMethod,
): MappedAdpRecord {
  const resolutionConfidence =
    resolutionMethod === 'direct-external-id'
      ? 1
      : resolutionMethod === 'exact-name-position' ||
          resolutionMethod === 'canonical-team-defense'
        ? 0.95
        : 0.8;
  return {
    ...record,
    playerId: player.id,
    resolutionMethod,
    resolutionConfidence,
  };
}

export function mapAdpSnapshot(
  source: AdpSourceSnapshot,
  playerMap: CanonicalPlayerMap,
  context: LeagueContext,
  now = new Date(),
): AdpSnapshot {
  const records: MappedAdpRecord[] = [];
  const unresolved: UnresolvedAdpRecord[] = [];
  for (const record of source.records) {
    if (record.sleeperId) {
      const player = playerMap.bySleeperId.get(record.sleeperId);
      if (player) {
        records.push(mapped(record, player, 'direct-external-id'));
        continue;
      }
    }
    if (record.position === 'DEF' && record.team) {
      const defense = playerMap.bySleeperId.get(record.team.toUpperCase());
      if (defense?.position === 'DEF') {
        records.push(mapped(record, defense, 'canonical-team-defense'));
        continue;
      }
    }
    const normalizedName = normalizePlayerName(record.playerName);
    const positionMatches = playerMap.byNameAndPosition.get(
      `${normalizedName}|${record.position}`,
    );
    if (positionMatches?.length === 1) {
      records.push(mapped(record, positionMatches[0], 'exact-name-position'));
      continue;
    }
    const nameMatches = playerMap.byName.get(normalizedName);
    if (nameMatches?.length === 1) {
      records.push(mapped(record, nameMatches[0], 'normalized-unique-name'));
      continue;
    }
    unresolved.push({
      ...record,
      reason: nameMatches && nameMatches.length > 1 ? 'ambiguous-name' : 'player-not-found',
    });
  }
  const resolution: ResolutionSummary = {
    total: source.records.length,
    matched: records.length,
    directExternalId: records.filter((item) => item.resolutionMethod === 'direct-external-id').length,
    exactCanonical: records.filter(
      (item) =>
        item.resolutionMethod === 'exact-name-position' ||
        item.resolutionMethod === 'canonical-team-defense',
    ).length,
    normalizedName: records.filter((item) => item.resolutionMethod === 'normalized-unique-name').length,
    ambiguous: unresolved.filter((item) => item.reason === 'ambiguous-name').length,
    unresolved: unresolved.filter((item) => item.reason === 'player-not-found').length,
  };
  return {
    kind: 'adp',
    provenance: source.provenance,
    context: source.context,
    records,
    unresolved,
    resolution,
    compatibility: assessCompatibility(source, context, now),
  };
}

export async function fetchAutomaticAdp(
  request: AdpProviderRequest,
  signal?: AbortSignal,
): Promise<AdpSourceSnapshot> {
  const params = new URLSearchParams({
    format: request.format,
    teams: String(request.teams),
    season: request.season,
  });
  const response = await fetch(`/api/adp?${params}`, { signal });
  if (!response.ok) {
    throw new Error('Automatic ADP refresh failed.');
  }
  const value: unknown = await response.json();
  if (!isAdpSourceSnapshot(value)) {
    throw new Error('Automatic ADP returned an invalid dataset.');
  }
  return value;
}

export function automaticAdpCacheKey(request: AdpProviderRequest): string {
  return `jfp:adp:v1:${request.season}:${request.format}:${request.teams}`;
}

export function projectionCacheKey(season: string): string {
  return `jfp:projections:v1:${season}`;
}
