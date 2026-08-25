import type { CanonicalPlayerMap, Position } from '../../players/types';
import type {
  SleeperDraft,
  SleeperDraftPick,
  SleeperRoster,
} from '../../sleeper/types';
import { clamp, round } from './math';

type PositionCounts = Partial<Record<Position, number>>;

export interface StarterTargets {
  QB: number;
  RB: number;
  WR: number;
  TE: number;
  K: number;
  DEF: number;
  FLEX: number;
}

export function getStarterTargets(draft: SleeperDraft): StarterTargets {
  return {
    QB: Math.max(1, draft.settings.slots_qb ?? 1),
    RB: Math.max(1, draft.settings.slots_rb ?? 2),
    WR: Math.max(1, draft.settings.slots_wr ?? 2),
    TE: Math.max(1, draft.settings.slots_te ?? 1),
    K: Math.max(0, draft.settings.slots_k ?? 1),
    DEF: Math.max(0, draft.settings.slots_def ?? 1),
    FLEX: Math.max(0, draft.settings.slots_flex ?? 1),
  };
}

export function getUserRosterId(
  rosters: SleeperRoster[],
  userId: string,
): number | null {
  return rosters.find((roster) => roster.owner_id === userId)?.roster_id ?? null;
}

export function getRosterPositionCounts(
  rosterId: number,
  picks: SleeperDraftPick[],
  rosters: SleeperRoster[],
  players: CanonicalPlayerMap,
): PositionCounts {
  const sleeperIds = new Set<string>();
  for (const pick of picks) {
    if (Number(pick.roster_id) === rosterId) sleeperIds.add(pick.player_id);
  }
  const roster = rosters.find((candidate) => candidate.roster_id === rosterId);
  for (const sleeperId of roster?.players ?? []) sleeperIds.add(sleeperId);

  const counts: PositionCounts = {};
  for (const sleeperId of sleeperIds) {
    const position = players.bySleeperId.get(sleeperId)?.position;
    if (position) counts[position] = (counts[position] ?? 0) + 1;
  }
  return counts;
}

export function scoreRosterFit(
  position: Position,
  counts: PositionCounts,
  targets: StarterTargets,
  currentRound: number,
  totalRounds: number,
): number {
  if (!['QB', 'RB', 'WR', 'TE', 'K', 'DEF'].includes(position)) return 0;
  const count = counts[position] ?? 0;
  const baseTarget = targets[position as keyof Omit<StarterTargets, 'FLEX'>];
  const lateDraft = currentRound >= Math.max(1, totalRounds - 2);

  if (position === 'K' || position === 'DEF') {
    if (!lateDraft) return 0;
    return count < baseTarget ? 88 : 12;
  }

  let score: number;
  if (count < baseTarget) {
    const deficitRatio = (baseTarget - count) / Math.max(1, baseTarget);
    score = 78 + deficitRatio * 18;
  } else if (position === 'RB' || position === 'WR') {
    const flexDepthTarget = baseTarget + Math.ceil(targets.FLEX / 2) + 1;
    score = count < flexDepthTarget ? 62 : Math.max(18, 48 - (count - flexDepthTarget) * 12);
  } else {
    score = count === baseTarget ? 42 : Math.max(10, 28 - (count - baseTarget) * 10);
  }

  if (['RB', 'WR', 'TE'].includes(position)) {
    const flexPlayers = (counts.RB ?? 0) + (counts.WR ?? 0) + (counts.TE ?? 0);
    const flexTarget = targets.RB + targets.WR + targets.TE + targets.FLEX;
    if (flexPlayers < flexTarget) score += 6;
  }

  const progress = currentRound / Math.max(1, totalRounds);
  if (progress > 0.65 && count < baseTarget) score += 8;
  return round(clamp(score), 1);
}
