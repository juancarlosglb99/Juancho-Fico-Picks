import type {
  DraftRoomRankingSourceSnapshot,
  ProjectionSourceSnapshot,
} from '../data/types';
import type { LeagueContext, ScoringProfile } from '../engine/context/types';
import {
  isDraftRoomRankingSourceSnapshot,
  isProjectionSourceSnapshot,
} from './mapping';

export interface FirstSeedAutomaticPlan {
  projectionFormat: Extract<ScoringProfile, 'standard' | 'half_ppr' | 'full_ppr'>;
  roomFormat: Extract<ScoringProfile, 'standard' | 'half_ppr' | 'full_ppr'>;
  qbFormat: '1qb' | 'superflex';
  notes: string[];
}

function nearestFormat(context: LeagueContext): FirstSeedAutomaticPlan['projectionFormat'] {
  const profile = context.scoring.value.profile;
  if (profile === 'standard' || profile === 'half_ppr' || profile === 'full_ppr') {
    return profile;
  }
  if (context.scoring.value.reception.base >= 0.75) return 'full_ppr';
  if (context.scoring.value.reception.base >= 0.25) return 'half_ppr';
  return 'standard';
}

export function planAutomaticFirstSeed(
  context: LeagueContext,
): FirstSeedAutomaticPlan | null {
  if (context.leagueType.value === 'dynasty' || context.leagueType.value === 'unknown') {
    return null;
  }
  if (context.draftType.value === 'auction') return null;
  const projectionFormat = nearestFormat(context);
  const qbFormat = context.roster.value.SUPER_FLEX > 0 || context.roster.value.QB >= 2
    ? 'superflex'
    : '1qb';
  const notes: string[] = [];
  if (context.scoring.value.profile === 'custom') {
    notes.push(`First Seed ${projectionFormat.replaceAll('_', ' ')} totals are the nearest aggregate projection format; custom scoring is limited.`);
  }
  if (qbFormat === 'superflex' && projectionFormat !== 'full_ppr') {
    notes.push('First Seed provides a dedicated Sleeper Superflex room order in PPR context; projection scoring remains league-format specific.');
  }
  return {
    projectionFormat,
    roomFormat: qbFormat === 'superflex' ? 'full_ppr' : projectionFormat,
    qbFormat,
    notes,
  };
}

export async function fetchFirstSeedProjections({
  season,
  scoringFormat,
  signal,
}: {
  season: string;
  scoringFormat: FirstSeedAutomaticPlan['projectionFormat'];
  signal?: AbortSignal;
}): Promise<ProjectionSourceSnapshot> {
  const params = new URLSearchParams({ season, format: scoringFormat });
  const response = await fetch(`/api/first-seed/projections?${params}`, { signal });
  if (!response.ok) throw new Error('First Seed projection refresh failed.');
  const value: unknown = await response.json();
  if (!isProjectionSourceSnapshot(value)) {
    throw new Error('First Seed returned an invalid projection snapshot.');
  }
  return value;
}

export async function fetchFirstSeedRoomRankings({
  season,
  scoringFormat,
  qbFormat,
  signal,
}: {
  season: string;
  scoringFormat: FirstSeedAutomaticPlan['roomFormat'];
  qbFormat: FirstSeedAutomaticPlan['qbFormat'];
  signal?: AbortSignal;
}): Promise<DraftRoomRankingSourceSnapshot> {
  const params = new URLSearchParams({
    season,
    platform: 'sleeper',
    format: scoringFormat,
    qb: qbFormat,
  });
  const response = await fetch(`/api/first-seed/rankings?${params}`, { signal });
  if (!response.ok) throw new Error('First Seed room-ranking refresh failed.');
  const value: unknown = await response.json();
  if (!isDraftRoomRankingSourceSnapshot(value)) {
    throw new Error('First Seed returned an invalid room-ranking snapshot.');
  }
  return value;
}

export function firstSeedProjectionCacheKey(
  season: string,
  format: FirstSeedAutomaticPlan['projectionFormat'],
): string {
  return `jfp:first-seed:projections:v1:${season}:${format}`;
}

export function firstSeedRoomRankingCacheKey(
  season: string,
  format: FirstSeedAutomaticPlan['roomFormat'],
  qbFormat: FirstSeedAutomaticPlan['qbFormat'],
): string {
  return `jfp:first-seed:room-rankings:v1:${season}:sleeper:${format}:${qbFormat}`;
}
