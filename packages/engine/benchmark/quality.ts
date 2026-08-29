/**
 * What "better" means, in numbers, so engine changes can be compared instead of
 * argued about.
 *
 * Two things are scored, in the priority order the product cares about:
 *
 *   1. Roster quality  - the team you finish with if you take #1 every round.
 *                        This is the only outcome that matters on Sunday.
 *   2. Decision quality - how much startable value each individual pick left on
 *                        the board, judged in hindsight against what was really
 *                        available at that moment.
 *
 * Both are measured with the SAME roster evaluation the engine optimizes, but
 * decision regret is computed against the actual board rather than the engine's
 * own beliefs, so it can catch the engine being confidently wrong.
 */
import type { Position } from '../../players/types';
import {
  evaluateRoster,
  type LineupPlayer,
  type LineupSlots,
} from '../draft/lineup';

export interface RosterQuality {
  /** Points the starting lineup projects. The headline number. */
  startingValue: number;
  /** Realistic contribution from the bench, already discounted. */
  benchValue: number;
  /** Starting slots that could not be filled at all. */
  unfilledSlots: number;
  /** Starting value plus usable bench, minus penalties for empty slots. */
  total: number;
  /** Players held who can never reach the starting lineup. */
  unusableDepth: number;
  counts: Partial<Record<Position, number>>;
}

/**
 * Scores a finished roster.
 *
 * `unusableDepth` is reported separately because it is the specific failure
 * this project exists to prevent: nine quarterbacks scores badly on `total`,
 * but the count is what makes the problem legible.
 */
export function scoreRoster(
  players: LineupPlayer[],
  slots: LineupSlots,
): RosterQuality {
  const evaluation = evaluateRoster(players, slots);
  const counts: Partial<Record<Position, number>> = {};
  for (const player of players) {
    counts[player.position] = (counts[player.position] ?? 0) + 1;
  }

  // How many bodies at each position could ever start, being generous: every
  // dedicated slot, plus flex, plus one backup.
  const capacity = (position: Position): number => {
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
    const flexible =
      position === 'RB' || position === 'WR' || position === 'TE' ? slots.FLEX : 0;
    const superFlexible =
      position === 'QB' || position === 'RB' || position === 'WR' || position === 'TE'
        ? slots.SUPER_FLEX
        : 0;
    return dedicated + flexible + superFlexible + 1;
  };

  let unusableDepth = 0;
  for (const [position, held] of Object.entries(counts)) {
    unusableDepth += Math.max(0, (held ?? 0) - capacity(position as Position));
  }

  return {
    startingValue: evaluation.startingValue,
    benchValue: evaluation.benchValue,
    unfilledSlots: evaluation.unfilledSlots,
    total: evaluation.total,
    unusableDepth,
    counts,
  };
}

export interface DecisionSample {
  overallPick: number;
  round: number;
  /** What the engine recommended and we took. */
  chosen: LineupPlayer;
  /** Everyone genuinely on the board at that moment. */
  available: LineupPlayer[];
  /** Our roster before the pick. */
  rosterBefore: LineupPlayer[];
}

export interface DecisionQuality {
  overallPick: number;
  round: number;
  chosenName: string;
  chosenPosition: Position;
  /** Lineup points our pick added. */
  gain: number;
  /** Lineup points the best available player would have added. */
  bestGain: number;
  bestName: string;
  bestPosition: Position;
  /** bestGain - gain. Zero is a perfect pick by this measure. */
  regret: number;
}

/**
 * How much startable value a single pick left on the table.
 *
 * Regret is measured against IMMEDIATE lineup improvement, which is
 * deliberately a harsher and simpler yardstick than the engine's own. It will
 * occasionally punish a correct decision - taking a player now because he will
 * not survive, over a bigger upgrade that will - so the aggregate matters more
 * than any single pick, and a small positive mean is healthy rather than a bug.
 * A large or growing mean means the engine is talking itself out of value.
 */
export function scoreDecision(
  sample: DecisionSample,
  slots: LineupSlots,
  nameOf: (playerId: string) => string,
): DecisionQuality {
  const baseline = evaluateRoster(sample.rosterBefore, slots).startingValue;
  const gainOf = (player: LineupPlayer) =>
    evaluateRoster([...sample.rosterBefore, player], slots).startingValue - baseline;

  let best = sample.chosen;
  let bestGain = gainOf(sample.chosen);
  for (const candidate of sample.available) {
    const gain = gainOf(candidate);
    if (gain > bestGain) {
      bestGain = gain;
      best = candidate;
    }
  }
  const gain = gainOf(sample.chosen);
  const round1 = (value: number) => Math.round(value * 10) / 10;
  return {
    overallPick: sample.overallPick,
    round: sample.round,
    chosenName: nameOf(sample.chosen.playerId),
    chosenPosition: sample.chosen.position,
    gain: round1(gain),
    bestGain: round1(bestGain),
    bestName: nameOf(best.playerId),
    bestPosition: best.position,
    regret: round1(Math.max(0, bestGain - gain)),
  };
}

export interface DraftQualityReport {
  roster: RosterQuality;
  decisions: DecisionQuality[];
  totalRegret: number;
  meanRegret: number;
  worstDecision: DecisionQuality | null;
}

export function summarizeDraftQuality(
  roster: RosterQuality,
  decisions: DecisionQuality[],
): DraftQualityReport {
  const totalRegret = decisions.reduce((sum, entry) => sum + entry.regret, 0);
  const round1 = (value: number) => Math.round(value * 10) / 10;
  return {
    roster,
    decisions,
    totalRegret: round1(totalRegret),
    meanRegret: decisions.length === 0 ? 0 : round1(totalRegret / decisions.length),
    worstDecision:
      [...decisions].sort((a, b) => b.regret - a.regret)[0] ?? null,
  };
}
