import type { MappedDraftRoomRankingRecord } from '../../data/types';
import type { Position } from '../../players/types';
import type { MappedProjection } from '../../projections/types';
import type { RosterConfiguration } from '../context/types';
import type { OpponentArchetype } from './types';

export interface OpponentCandidate {
  projection: MappedProjection;
  roomRanking: MappedDraftRoomRankingRecord | null;
}

const ARCHETYPES: OpponentArchetype[] = [
  'room_rank_follower',
  'market_follower',
  'roster_builder',
  'positional_runner',
  'balanced',
];

export function archetypeForRoster(rosterId: number): OpponentArchetype {
  return ARCHETYPES[Math.abs(rosterId - 1) % ARCHETYPES.length];
}

function target(position: Position, roster: RosterConfiguration): number {
  if (position === 'QB') return roster.QB + roster.SUPER_FLEX;
  if (position === 'RB') return roster.RB + Math.ceil(roster.FLEX * 0.45);
  if (position === 'WR') return roster.WR + Math.ceil(roster.FLEX * 0.45);
  if (position === 'TE') return roster.TE + Math.ceil(roster.FLEX * 0.1);
  if (position === 'K') return roster.K;
  if (position === 'DEF') return roster.DEF;
  return 0;
}

function needScore(
  position: Position,
  counts: Partial<Record<Position, number>>,
  roster: RosterConfiguration,
): number {
  const remaining = target(position, roster) - (counts[position] ?? 0);
  return remaining > 0 ? Math.min(2.4, 0.85 + remaining * 0.55) : -0.3;
}

function positionRunScore(position: Position, recentPositions: Position[]): number {
  const recent = recentPositions.slice(-5).filter((candidate) => candidate === position).length;
  return recent >= 2 ? 0.45 + recent * 0.24 : 0;
}

function weights(archetype: OpponentArchetype) {
  if (archetype === 'room_rank_follower') return { room: 0.72, market: 0.18, need: 0.1 };
  if (archetype === 'market_follower') return { room: 0.2, market: 0.68, need: 0.12 };
  if (archetype === 'roster_builder') return { room: 0.26, market: 0.24, need: 0.5 };
  if (archetype === 'positional_runner') return { room: 0.34, market: 0.34, need: 0.32 };
  return { room: 0.42, market: 0.4, need: 0.18 };
}

export function opponentCandidateLogit({
  candidate,
  archetype,
  counts,
  roster,
  currentPick,
  recentPositions,
}: {
  candidate: OpponentCandidate;
  archetype: OpponentArchetype;
  counts: Partial<Record<Position, number>>;
  roster: RosterConfiguration;
  currentPick: number;
  recentPositions: Position[];
}): number {
  const profile = weights(archetype);
  const roomRank = candidate.roomRanking?.rank ?? null;
  const marketAdp = Number.isFinite(candidate.projection.adp)
    ? candidate.projection.adp!
    : null;
  const fallback = Math.max(1, candidate.projection.rank ?? currentPick + 80);
  const room = roomRank ?? marketAdp ?? fallback;
  const market = marketAdp ?? roomRank ?? fallback;
  const roomTiming = -Math.abs(room - currentPick) * 0.025 - Math.max(0, room - currentPick) * 0.012;
  const marketTiming = -Math.abs(market - currentPick) * 0.021 - Math.max(0, market - currentPick) * 0.01;
  const need = needScore(candidate.projection.position, counts, roster);
  const run = archetype === 'positional_runner'
    ? positionRunScore(candidate.projection.position, recentPositions)
    : 0;
  const superflexQuarterback =
    candidate.projection.position === 'QB' && (roster.SUPER_FLEX > 0 || roster.QB >= 2)
      ? 0.75
      : 0;
  return roomTiming * profile.room * 8 +
    marketTiming * profile.market * 8 +
    need * profile.need * 2.2 + run + superflexQuarterback;
}

export function chooseOpponentPlayer({
  candidates,
  archetype,
  counts,
  roster,
  currentPick,
  recentPositions,
  random,
}: {
  candidates: OpponentCandidate[];
  archetype: OpponentArchetype;
  counts: Partial<Record<Position, number>>;
  roster: RosterConfiguration;
  currentPick: number;
  recentPositions: Position[];
  random: () => number;
}): OpponentCandidate | null {
  const scored = candidates
    .map((candidate) => ({
      candidate,
      logit: opponentCandidateLogit({
        candidate,
        archetype,
        counts,
        roster,
        currentPick,
        recentPositions,
      }),
    }))
    .sort((a, b) => b.logit - a.logit)
    .slice(0, 28);
  if (scored.length === 0) return null;
  const max = scored[0].logit;
  const weighted = scored.map((item) => ({ ...item, weight: Math.exp((item.logit - max) / 0.72) }));
  const total = weighted.reduce((sum, item) => sum + item.weight, 0);
  let cursor = random() * total;
  for (const item of weighted) {
    cursor -= item.weight;
    if (cursor <= 0) return item.candidate;
  }
  return weighted.at(-1)?.candidate ?? null;
}
