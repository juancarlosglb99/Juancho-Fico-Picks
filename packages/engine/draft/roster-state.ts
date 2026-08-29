/**
 * What our roster currently is, and what it still needs.
 *
 * The old engine knew only how many bodies it had at each position. That is not
 * enough to draft with: two tight ends where one is elite and one is a backup
 * is a completely different situation from two mediocre ones, and neither is
 * described by the number 2. This models what is filled, what is startable,
 * what is shallow, and what is saturated - and classifies the build that is
 * emerging so later picks can be consistent with the earlier ones.
 */
import type { Position } from '../../players/types';
import {
  FLEX_ELIGIBLE,
  SUPER_FLEX_ELIGIBLE,
  flexAccessFor,
  solveBestLineup,
  type LineupPlayer,
  type LineupSlots,
} from './lineup';

export type StarterQuality = 'none' | 'weak' | 'replacement' | 'solid' | 'strong' | 'elite';
export type NeedLevel = 'critical' | 'high' | 'medium' | 'low' | 'none';
export type Saturation = 'none' | 'low' | 'medium' | 'high' | 'complete';

export type BuildLabel =
  | 'undefined'
  | 'balanced'
  | 'rb_heavy'
  | 'hero_rb'
  | 'zero_rb'
  | 'wr_heavy'
  | 'early_qb'
  | 'early_te';

export interface PositionState {
  position: Position;
  startersRequired: number;
  flexEligible: boolean;
  drafted: number;
  /** How many of them actually occupy a starting slot right now. */
  startersFilled: number;
  starterQuality: StarterQuality;
  depthNeed: NeedLevel;
  saturation: Saturation;
  /** Starting slots this position could still realistically claim. */
  openStartingSlots: number;
}

export interface RosterConstructionState {
  slots: LineupSlots;
  byPosition: Record<string, PositionState>;
  totalStarterSlots: number;
  filledStarterSlots: number;
  unfilledStarterSlots: number;
  picksRemaining: number;
  /** Starting slots we still owe minus picks left; positive means trouble. */
  starterDeficitPressure: number;
  build: BuildLabel;
  strengths: Position[];
  weaknesses: Position[];
  strategicPriority: Position[];
  possiblePivots: string[];
}

const CORE: Position[] = ['QB', 'RB', 'WR', 'TE'];

function dedicatedSlots(position: Position, slots: LineupSlots): number {
  if (position === 'QB') return slots.QB;
  if (position === 'RB') return slots.RB;
  if (position === 'WR') return slots.WR;
  if (position === 'TE') return slots.TE;
  if (position === 'K') return slots.K;
  if (position === 'DEF') return slots.DEF;
  return 0;
}

/**
 * Every starting slot this position can compete for, flex included. In a 1QB
 * league that is 1 for quarterbacks; in Superflex it is 2, which is exactly why
 * the same player is worth so much more there.
 */
export function startingFootprint(position: Position, slots: LineupSlots): number {
  return (
    dedicatedSlots(position, slots) +
    flexAccessFor(position, slots.FLEX) +
    (SUPER_FLEX_ELIGIBLE.includes(position)
      ? slots.SUPER_FLEX * (position === 'QB' ? 0.85 : 0.05)
      : 0)
  );
}

function qualityFromPositionalRank(
  rank: number | null,
  startersLeagueWide: number,
): StarterQuality {
  if (rank === null) return 'none';
  if (rank <= Math.max(1, startersLeagueWide * 0.25)) return 'elite';
  if (rank <= Math.max(2, startersLeagueWide * 0.5)) return 'strong';
  if (rank <= Math.max(3, startersLeagueWide)) return 'solid';
  if (rank <= Math.max(4, startersLeagueWide * 1.6)) return 'replacement';
  return 'weak';
}

export interface BuildRosterStateInput {
  rosterPlayers: LineupPlayer[];
  slots: LineupSlots;
  teams: number;
  picksRemaining: number;
  /** Rank of a player within his own position across the projection pool. */
  positionalRank: (playerId: string) => number | null;
  /** Rounds in which we selected each position, for build classification. */
  selectionRounds: { position: Position; round: number }[];
}

export function buildRosterConstructionState(
  input: BuildRosterStateInput,
): RosterConstructionState {
  const { rosterPlayers, slots, teams, picksRemaining, positionalRank, selectionRounds } = input;
  const lineup = solveBestLineup(rosterPlayers, slots);
  const startersById = new Set(lineup.starters.map((player) => player.playerId));

  const byPosition: Record<string, PositionState> = {};
  const positions: Position[] = [...CORE, 'K', 'DEF'];

  for (const position of positions) {
    const owned = rosterPlayers.filter((player) => player.position === position);
    const startersFilled = owned.filter((player) => startersById.has(player.playerId)).length;
    const footprint = startingFootprint(position, slots);
    const dedicated = dedicatedSlots(position, slots);
    const best = [...owned].sort((a, b) => b.projection - a.projection)[0] ?? null;
    const startersLeagueWide = Math.max(1, teams * Math.max(dedicated, 1));
    const starterQuality = best
      ? qualityFromPositionalRank(positionalRank(best.playerId), startersLeagueWide)
      : 'none';

    // Slots this position can still claim, given what already occupies them.
    const openStartingSlots = Math.max(0, footprint - startersFilled);

    const depthNeed: NeedLevel =
      startersFilled < dedicated
        ? dedicated - startersFilled >= 2
          ? 'critical'
          : 'high'
        : openStartingSlots > 0
          ? FLEX_ELIGIBLE.includes(position)
            ? 'medium'
            : 'low'
          : owned.length <= footprint
            ? 'low'
            : 'none';

    const surplus = owned.length - footprint;
    const saturation: Saturation =
      surplus >= 2
        ? 'complete'
        : surplus === 1
          ? 'high'
          : startersFilled >= footprint
            ? 'medium'
            : startersFilled > 0
              ? 'low'
              : 'none';

    byPosition[position] = {
      position,
      startersRequired: dedicated,
      flexEligible: FLEX_ELIGIBLE.includes(position),
      drafted: owned.length,
      startersFilled,
      starterQuality,
      depthNeed,
      saturation,
      openStartingSlots,
    };
  }

  const totalStarterSlots =
    slots.QB + slots.RB + slots.WR + slots.TE + slots.FLEX + slots.SUPER_FLEX + slots.K + slots.DEF;
  const filledStarterSlots = lineup.starters.length;
  const unfilledStarterSlots = Math.max(0, totalStarterSlots - filledStarterSlots);

  const strengths = CORE.filter((position) =>
    ['elite', 'strong'].includes(byPosition[position].starterQuality),
  );
  const weaknesses = CORE.filter((position) =>
    ['critical', 'high'].includes(byPosition[position].depthNeed),
  );

  const strategicPriority = CORE.slice()
    .filter((position) => byPosition[position].openStartingSlots > 0)
    .sort((a, b) => {
      const order: NeedLevel[] = ['critical', 'high', 'medium', 'low', 'none'];
      return (
        order.indexOf(byPosition[a].depthNeed) - order.indexOf(byPosition[b].depthNeed) ||
        byPosition[b].openStartingSlots - byPosition[a].openStartingSlots
      );
    });

  return {
    slots,
    byPosition,
    totalStarterSlots,
    filledStarterSlots,
    unfilledStarterSlots,
    picksRemaining,
    starterDeficitPressure: unfilledStarterSlots - picksRemaining,
    build: classifyBuild(selectionRounds, byPosition),
    strengths,
    weaknesses,
    strategicPriority,
    possiblePivots: describePivots(byPosition, strategicPriority),
  };
}

/**
 * Names the shape the roster is taking.
 *
 * This is descriptive, never prescriptive: the label is read off what has
 * already happened rather than chosen up front, so the engine never decides
 * "we are Zero RB" before the board has said anything.
 */
export function classifyBuild(
  selectionRounds: { position: Position; round: number }[],
  byPosition: Record<string, PositionState>,
): BuildLabel {
  const early = selectionRounds.filter((entry) => entry.round <= 4);
  if (early.length < 2) return 'undefined';
  const count = (position: Position) => early.filter((entry) => entry.position === position).length;
  const rb = count('RB');
  const wr = count('WR');

  if (count('QB') > 0 && ['elite', 'strong'].includes(byPosition.QB?.starterQuality ?? 'none')) {
    return 'early_qb';
  }
  if (count('TE') > 0 && ['elite', 'strong'].includes(byPosition.TE?.starterQuality ?? 'none')) {
    return 'early_te';
  }
  if (rb === 0 && wr >= 2) return 'zero_rb';
  if (rb >= 3) return 'rb_heavy';
  if (rb === 1 && wr >= 2) return 'hero_rb';
  if (wr >= 3) return 'wr_heavy';
  if (rb >= 2 && wr >= 1) return 'balanced';
  return 'balanced';
}

function describePivots(
  byPosition: Record<string, PositionState>,
  priority: Position[],
): string[] {
  const pivots: string[] = [];
  for (const position of priority.slice(0, 2)) {
    const state = byPosition[position];
    if (!state) continue;
    if (state.depthNeed === 'critical') {
      pivots.push(`${position} is two starters short and needs addressing soon.`);
    } else if (state.depthNeed === 'high') {
      pivots.push(`${position} still needs a starter.`);
    } else if (state.openStartingSlots > 0) {
      pivots.push(`${position} can still improve a flex slot.`);
    }
  }
  return pivots;
}
