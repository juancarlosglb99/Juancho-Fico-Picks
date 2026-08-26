/**
 * What a set of players is actually worth once they have to fill a lineup.
 *
 * Fantasy points only count if a player occupies a starting slot. A roster with
 * nine quarterbacks in a 1QB league starts exactly one of them, so eight of
 * those projections are worth nothing on any given Sunday. Every scoring
 * decision in the engine is anchored here rather than on raw projections, which
 * is what stops the model from hoarding a position it cannot start.
 */
import type { Position } from '../../players/types';
import type { RosterConfiguration } from '../context/types';

export interface LineupSlots {
  QB: number;
  RB: number;
  WR: number;
  TE: number;
  FLEX: number;
  SUPER_FLEX: number;
  K: number;
  DEF: number;
}

export interface LineupPlayer {
  playerId: string;
  position: Position;
  projection: number;
}

export interface SolvedLineup {
  /** Total projected points of the players occupying starting slots. */
  total: number;
  starters: LineupPlayer[];
  /** Slots that could not be filled at all. */
  unfilled: { slot: keyof LineupSlots; count: number }[];
  benchPlayers: LineupPlayer[];
}

/** Positions each slot will accept. */
export const FLEX_ELIGIBLE: Position[] = ['RB', 'WR', 'TE'];
export const SUPER_FLEX_ELIGIBLE: Position[] = ['QB', 'RB', 'WR', 'TE'];

/**
 * How much of a flex slot a position realistically claims.
 *
 * A tight end is flex-ELIGIBLE, and `solveBestLineup` will happily start one
 * there when he genuinely outscores the alternatives. But planning as though
 * every flex slot were equally likely to hold a tight end overstates what a
 * second and third tight end are worth, and the model starts collecting them
 * for the same reason it used to collect quarterbacks. Running backs and
 * receivers fill flex slots the overwhelming majority of the time.
 */
export const FLEX_ACCESS_WEIGHT: Partial<Record<Position, number>> = {
  RB: 0.45,
  WR: 0.45,
  TE: 0.12,
};

export function flexAccessFor(position: Position, flexSlots: number): number {
  return flexSlots * (FLEX_ACCESS_WEIGHT[position] ?? 0);
}

export function lineupSlotsFor(roster: RosterConfiguration): LineupSlots {
  return {
    QB: Math.max(0, roster.QB),
    RB: Math.max(0, roster.RB),
    WR: Math.max(0, roster.WR),
    TE: Math.max(0, roster.TE),
    FLEX: Math.max(0, roster.FLEX),
    SUPER_FLEX: Math.max(0, roster.SUPER_FLEX),
    K: Math.max(0, roster.K),
    DEF: Math.max(0, roster.DEF),
  };
}

export function totalStartingSlots(slots: LineupSlots): number {
  return (
    slots.QB + slots.RB + slots.WR + slots.TE + slots.FLEX + slots.SUPER_FLEX + slots.K + slots.DEF
  );
}

/**
 * Fills the lineup with the best available players.
 *
 * Dedicated slots are filled before flex slots, and FLEX before SUPER_FLEX.
 * That ordering is optimal for this slot structure because each later slot type
 * accepts a superset of the positions the earlier one does: taking the best
 * player for a narrow slot can never cost more than it gains, since anyone
 * displaced remains eligible for the wider slot behind it.
 */
export function solveBestLineup(
  players: LineupPlayer[],
  slots: LineupSlots,
): SolvedLineup {
  const remaining = [...players].sort((a, b) => b.projection - a.projection);
  const starters: LineupPlayer[] = [];
  const unfilled: { slot: keyof LineupSlots; count: number }[] = [];

  const takeBest = (eligible: Position[], count: number, slot: keyof LineupSlots) => {
    let filled = 0;
    for (let i = 0; i < count; i += 1) {
      const index = remaining.findIndex((player) => eligible.includes(player.position));
      if (index === -1) break;
      starters.push(remaining[index]);
      remaining.splice(index, 1);
      filled += 1;
    }
    if (filled < count) unfilled.push({ slot, count: count - filled });
  };

  takeBest(['QB'], slots.QB, 'QB');
  takeBest(['RB'], slots.RB, 'RB');
  takeBest(['WR'], slots.WR, 'WR');
  takeBest(['TE'], slots.TE, 'TE');
  takeBest(['K'], slots.K, 'K');
  takeBest(['DEF'], slots.DEF, 'DEF');
  takeBest(FLEX_ELIGIBLE, slots.FLEX, 'FLEX');
  takeBest(SUPER_FLEX_ELIGIBLE, slots.SUPER_FLEX, 'SUPER_FLEX');

  return {
    total: Math.round(starters.reduce((sum, player) => sum + player.projection, 0) * 10) / 10,
    starters,
    unfilled,
    benchPlayers: remaining,
  };
}

/**
 * How much a bench player is really worth to a roster.
 *
 * Bench points are not starting points. What a backup is worth is the chance he
 * ends up starting - through injury, a bye, or simply being better than the
 * incumbent by season's end - multiplied by how much better than nothing he
 * would be in that week. That probability collapses quickly with each extra
 * body at the same position, and collapses fastest where only one slot exists.
 *
 * The returned figure is a fraction of the player's projection, so callers work
 * in points throughout.
 */
export function benchUsabilityFactor({
  position,
  depthIndexAtPosition,
  slots,
}: {
  position: Position;
  /** 0 = this player is the first BENCH player at the position. */
  depthIndexAtPosition: number;
  slots: LineupSlots;
}): number {
  if (depthIndexAtPosition < 0) return 0;

  // How many starting slots this position can realistically occupy.
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
  const flexAccess = flexAccessFor(position, slots.FLEX);
  const superFlexAccess = SUPER_FLEX_ELIGIBLE.includes(position)
    ? slots.SUPER_FLEX * (position === 'QB' ? 0.85 : 0.05)
    : 0;
  const startingFootprint = dedicated + flexAccess + superFlexAccess;

  if (startingFootprint <= 0) return 0;

  /*
   * A position with a single starting slot - quarterback in 1QB, tight end -
   * can use exactly one backup. The third one has no path into the lineup at
   * all: both players ahead of him would have to be unavailable in the same
   * week, and even then he replaces a player we would have started anyway. He
   * is worth nothing, and saying so is what stops the model from collecting
   * them purely because the position posts big raw numbers.
   *
   * Positions with several slots are different. Another running back or
   * receiver always has some path in, through a flex slot, a bye or an injury,
   * so their value decays without ever reaching zero.
   */
  const singleSlot = startingFootprint <= 1.5;
  if (singleSlot && depthIndexAtPosition >= 1) return 0;

  const base = singleSlot ? 0.06 : startingFootprint <= 2.2 ? 0.2 : 0.3;
  const decay = singleSlot ? 0.18 : 0.42;
  const factor = base * decay ** depthIndexAtPosition;
  return factor < 0.002 ? 0 : Math.round(factor * 1000) / 1000;
}

/**
 * Total roster value: what the lineup scores, plus what the bench realistically
 * adds. Used both for live recommendations and for simulated final rosters, so
 * the two can never disagree about what a good team looks like.
 */
export function evaluateRoster(
  players: LineupPlayer[],
  slots: LineupSlots,
  { unfilledPenaltyPerSlot = 140 }: { unfilledPenaltyPerSlot?: number } = {},
): {
  total: number;
  startingValue: number;
  benchValue: number;
  unfilledSlots: number;
  lineup: SolvedLineup;
} {
  const lineup = solveBestLineup(players, slots);
  const depthSeen = new Map<Position, number>();
  let benchValue = 0;
  for (const player of [...lineup.benchPlayers].sort((a, b) => b.projection - a.projection)) {
    const depthIndex = depthSeen.get(player.position) ?? 0;
    depthSeen.set(player.position, depthIndex + 1);
    benchValue +=
      player.projection *
      benchUsabilityFactor({ position: player.position, depthIndexAtPosition: depthIndex, slots });
  }
  const unfilledSlots = lineup.unfilled.reduce((sum, entry) => sum + entry.count, 0);
  const startingValue = lineup.total;
  const rounded = (value: number) => Math.round(value * 10) / 10;
  return {
    total: rounded(startingValue + benchValue - unfilledSlots * unfilledPenaltyPerSlot),
    startingValue: rounded(startingValue),
    benchValue: rounded(benchValue),
    unfilledSlots,
    lineup,
  };
}
