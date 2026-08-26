/**
 * What the room is doing, and what the teams ahead of us actually need.
 *
 * Availability was previously estimated from a player's market rank and a
 * generic notion of demand. That is wrong in both directions: a quarterback is
 * far likelier to survive a stretch of teams that all already have one, and far
 * likelier to disappear in the middle of a quarterback run. Both effects are
 * observable from the picks that have already happened and from the rosters the
 * other teams have built, so neither needs guessing.
 */
import type { Position } from '../../players/types';
import { startingFootprint } from './roster-state';
import type { LineupSlots } from './lineup';

export interface PositionalRun {
  position: Position;
  /** Selections at this position inside the observation window. */
  recentCount: number;
  windowSize: number;
  /** Share of recent picks, against the share this position usually takes. */
  intensity: number;
  isRun: boolean;
}

/** Roughly how often each position goes in a normal redraft room. */
const BASELINE_SHARE: Record<string, number> = {
  RB: 0.32,
  WR: 0.38,
  QB: 0.12,
  TE: 0.12,
  K: 0.03,
  DEF: 0.03,
};

export function detectPositionalRuns(
  recentPositions: Position[],
  { windowSize = 10 }: { windowSize?: number } = {},
): Record<string, PositionalRun> {
  const window = recentPositions.slice(-windowSize);
  const runs: Record<string, PositionalRun> = {};
  for (const position of ['QB', 'RB', 'WR', 'TE'] as Position[]) {
    const recentCount = window.filter((entry) => entry === position).length;
    const share = window.length > 0 ? recentCount / window.length : 0;
    const baseline = BASELINE_SHARE[position] ?? 0.1;
    const intensity = baseline > 0 ? share / baseline : 0;
    runs[position] = {
      position,
      recentCount,
      windowSize: window.length,
      intensity: Math.round(intensity * 100) / 100,
      // A run needs both a real cluster and a rate well above normal, so a
      // single pick in a short window never counts as one.
      isRun: window.length >= 5 && recentCount >= 3 && intensity >= 1.7,
    };
  }
  return runs;
}

export interface InterveningTeam {
  rosterId: number | null;
  counts: Partial<Record<Position, number>>;
}

/**
 * How many teams picking before us genuinely want this position.
 *
 * A team that has not filled its dedicated slots at the position is real
 * demand. A team that has filled them but can still flex the position is
 * partial demand. A team that is saturated is not demand at all, whatever the
 * market says.
 */
export function opponentDemandForPosition({
  position,
  interveningTeams,
  slots,
  runs,
}: {
  position: Position;
  interveningTeams: InterveningTeam[];
  slots: LineupSlots;
  runs?: Record<string, PositionalRun>;
}): { demand: number; teamsWithNeed: number } {
  const dedicated =
    position === 'QB'
      ? slots.QB
      : position === 'RB'
        ? slots.RB
        : position === 'WR'
          ? slots.WR
          : position === 'TE'
            ? slots.TE
            : position === 'K'
              ? slots.K
              : position === 'DEF'
                ? slots.DEF
                : 0;
  const footprint = startingFootprint(position, slots);

  let demand = 0;
  let teamsWithNeed = 0;
  for (const team of interveningTeams) {
    if (team.rosterId === null) {
      // Unknown seat: assume average demand rather than none.
      demand += 0.4;
      continue;
    }
    const held = team.counts[position] ?? 0;
    if (held < dedicated) {
      demand += 1;
      teamsWithNeed += 1;
    } else if (held < footprint) {
      demand += 0.45;
      teamsWithNeed += 1;
    } else {
      demand += 0.08;
    }
  }

  // A live run at this position pulls demand up; a room that has moved past the
  // position pulls it down.
  const run = runs?.[position];
  const runMultiplier = run?.isRun ? 1 + Math.min(0.6, (run.intensity - 1) * 0.3) : 1;
  return {
    demand: Math.round(demand * runMultiplier * 100) / 100,
    teamsWithNeed,
  };
}

export type RoomTendency =
  | 'balanced'
  | 'rb_heavy'
  | 'wr_heavy'
  | 'qb_aggressive'
  | 'te_aggressive';

export interface RoomBehavior {
  tendency: RoomTendency;
  positionShare: Record<string, number>;
  runs: Record<string, PositionalRun>;
  picksObserved: number;
}

export function describeRoomBehavior(
  allPositions: Position[],
  recentPositions: Position[],
): RoomBehavior {
  const total = Math.max(1, allPositions.length);
  const positionShare: Record<string, number> = {};
  for (const position of ['QB', 'RB', 'WR', 'TE'] as Position[]) {
    positionShare[position] =
      Math.round((allPositions.filter((entry) => entry === position).length / total) * 100) / 100;
  }
  const excess = (position: Position) =>
    (positionShare[position] ?? 0) - (BASELINE_SHARE[position] ?? 0.1);

  let tendency: RoomTendency = 'balanced';
  if (allPositions.length >= 12) {
    const ranked = (['QB', 'TE', 'RB', 'WR'] as Position[])
      .map((position) => ({ position, excess: excess(position) }))
      .sort((a, b) => b.excess - a.excess)[0];
    if (ranked && ranked.excess >= 0.08) {
      tendency =
        ranked.position === 'QB'
          ? 'qb_aggressive'
          : ranked.position === 'TE'
            ? 'te_aggressive'
            : ranked.position === 'RB'
              ? 'rb_heavy'
              : 'wr_heavy';
    }
  }

  return {
    tendency,
    positionShare,
    runs: detectPositionalRuns(recentPositions),
    picksObserved: allPositions.length,
  };
}
