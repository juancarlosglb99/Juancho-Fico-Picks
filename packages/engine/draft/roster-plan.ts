/**
 * Plays the rest of the draft out to see what roster each choice leads to.
 *
 * This is what turns "who is the best player available" into "what pick gives
 * me the strongest final team". Instead of scoring a player in isolation, the
 * engine completes the roster from him - taking our remaining picks in order,
 * while the room in front of us keeps taking the consensus board - and scores
 * the finished lineup.
 *
 * Several behaviours the old model needed explicit rules for now fall out of
 * this for free:
 *
 *   - Positional saturation. A second quarterback in a 1QB league cannot enter
 *     the starting lineup, so the plan that takes him is simply worth less.
 *   - Tier cliffs. If the last useful tight end goes before we pick again, every
 *     plan that waited on tight end inherits a much worse one.
 *   - Opportunity cost. Spending this pick on a position we already have costs
 *     us whatever the plan would otherwise have put in an empty slot.
 */
import type { Position } from '../../players/types';
import { evaluateRoster, type LineupPlayer, type LineupSlots } from './lineup';

export interface PlannablePlayer extends LineupPlayer {
  /**
   * Where the ROOM would take this player, lower is sooner. First Seed's draft
   * room rank when we have it; otherwise a projection-derived ordering.
   */
  consensusRank: number;
}

export interface RosterPlanInput {
  /** Players already on our roster. */
  rosterPlayers: LineupPlayer[];
  /** Everyone still on the board. */
  available: PlannablePlayer[];
  /** Our remaining selections as overall pick numbers, ascending. */
  ourFuturePicks: number[];
  /** The selection currently on the clock. */
  currentOverallPick: number;
  /** Last overall pick of the draft. */
  lastOverallPick: number;
  slots: LineupSlots;
}

export interface RosterPlan {
  /** Everything we would finish with, existing roster included. */
  players: LineupPlayer[];
  /** Only the players this plan says we would add from here. */
  added: LineupPlayer[];
  total: number;
  startingValue: number;
  benchValue: number;
  unfilledSlots: number;
}

/** How many of our own selections we bother planning ahead. */
const PLAN_HORIZON = 10;

/** Candidates considered at each of our future picks inside the plan. */
const PLAN_BRANCHING = 2;

/**
 * Completes the roster.
 *
 * `forcedFirst` pins our next selection, which is how a candidate is evaluated:
 * plan the draft out from taking him, and compare the finished rosters.
 */
export function planRemainingRoster(
  input: RosterPlanInput,
  forcedFirst?: PlannablePlayer,
): RosterPlan {
  const { rosterPlayers, available, ourFuturePicks, currentOverallPick, lastOverallPick, slots } =
    input;

  // Consensus order is how the room in front of us is assumed to draft.
  const consensusOrder = [...available].sort(
    (a, b) => a.consensusRank - b.consensusRank || b.projection - a.projection,
  );
  const taken = new Set<string>();
  const roster: LineupPlayer[] = [...rosterPlayers];
  const added: LineupPlayer[] = [];

  // Best remaining at each position, for our own decisions.
  const byPosition = new Map<Position, PlannablePlayer[]>();
  for (const player of [...available].sort((a, b) => b.projection - a.projection)) {
    byPosition.set(player.position, [...(byPosition.get(player.position) ?? []), player]);
  }

  const ourPicks = new Set(ourFuturePicks.slice(0, PLAN_HORIZON));
  const horizonEnd = ourFuturePicks[Math.min(ourFuturePicks.length, PLAN_HORIZON) - 1] ?? lastOverallPick;

  let roomCursor = 0;
  const advanceRoom = () => {
    while (roomCursor < consensusOrder.length && taken.has(consensusOrder[roomCursor].playerId)) {
      roomCursor += 1;
    }
    const player = consensusOrder[roomCursor];
    if (player) taken.add(player.playerId);
  };

  const bestForUs = (): PlannablePlayer | null => {
    let best: PlannablePlayer | null = null;
    let bestValue = -Infinity;
    for (const [, pool] of byPosition) {
      let considered = 0;
      for (const candidate of pool) {
        if (taken.has(candidate.playerId)) continue;
        const value = evaluateRoster([...roster, candidate], slots).total;
        if (value > bestValue) {
          bestValue = value;
          best = candidate;
        }
        considered += 1;
        if (considered >= PLAN_BRANCHING) break;
      }
    }
    return best;
  };

  let firstOurPick = true;
  for (let pick = currentOverallPick; pick <= Math.min(lastOverallPick, horizonEnd); pick += 1) {
    if (ourPicks.has(pick)) {
      let chosen: PlannablePlayer | null;
      if (firstOurPick && forcedFirst) {
        chosen = taken.has(forcedFirst.playerId) ? null : forcedFirst;
      } else {
        chosen = bestForUs();
      }
      firstOurPick = false;
      if (chosen) {
        taken.add(chosen.playerId);
        roster.push(chosen);
        added.push(chosen);
      }
    } else {
      advanceRoom();
    }
  }

  const evaluation = evaluateRoster(roster, slots);
  return {
    players: roster,
    added,
    total: evaluation.total,
    startingValue: evaluation.startingValue,
    benchValue: evaluation.benchValue,
    unfilledSlots: evaluation.unfilledSlots,
  };
}
