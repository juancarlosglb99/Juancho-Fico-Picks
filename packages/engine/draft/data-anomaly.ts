/**
 * When First Seed's own two signals point different ways about a player.
 *
 * First Seed publishes a rank and a projection, and they normally move
 * together: the higher-ranked back projects more points than the one below him.
 * Occasionally they do not. James Conner sits at rank 99 while projecting 40.4,
 * against running backs ranked near him projecting around ninety - and both the
 * engine and the strategist took the pair at face value, one anchoring to the
 * rank and the other reasoning carefully about sequencing a player worth a
 * quarter of the alternative. Neither noticed the two numbers disagreed.
 *
 * The disagreement is reported NEUTRALLY, and that is deliberate. It is not
 * evidence that the ranking is wrong: a rank legitimately encodes things a
 * point projection does not - role, risk, expected availability - so a gap
 * between them may be entirely intended. Calling the rank unreliable would
 * substitute our judgement for the strategist's on exactly the question it is
 * better placed to answer.
 *
 * So this says only that the signals differ, and by how much. It changes
 * nothing, rejects nobody, and never edits First Seed's data - a flag raised
 * from a player's relationship to his own rank neighbours rather than from
 * anything specific to a player or a season.
 */
import type { Position } from '../../players/types';

export type DataWarningCode =
  /** Rank and projection point in materially different directions. */
  | 'ranking_projection_conflict';

export interface DataWarning {
  code: DataWarningCode;
  /** Enough for a reader to judge the conflict without looking anything up. */
  detail: string;
  /** The player's own projection, and what his rank neighbours project. */
  projection: number;
  neighbourMedianProjection: number;
  /** How many times the neighbours' median exceeds his projection. */
  shortfallRatio: number;
}

/**
 * How far out of line a projection has to be before it is worth mentioning.
 *
 * Ranks and projections disagree a little all the time - a rank carries opinion
 * about risk and role that a point total does not - so the bar is deliberately
 * high enough that only a genuine contradiction trips it. Half of what his
 * neighbours project is not a difference of opinion about upside; it is two
 * numbers that were not computed the same way.
 */
export const CONFLICT_RATIO = 2;
/** Below this the position is too thin for a median to mean anything. */
const MIN_NEIGHBOURS = 4;
/** How many ranked neighbours at the position to compare against. */
const NEIGHBOUR_WINDOW = 8;

export interface AnomalyCandidate {
  playerId: string;
  position: Position;
  /** First Seed's rank, or null when they do not rank him. */
  firstSeedRank: number | null;
  /** First Seed's own published projection. */
  projection: number;
}

/**
 * Flags players whose rank and projection contradict each other.
 *
 * Compared within position and against rank NEIGHBOURS rather than against the
 * whole position: a kicker projecting less than a quarterback is not a conflict,
 * and neither is the ninetieth back projecting less than the ninth. The claim
 * being tested is narrow - that a player projects far less than the players
 * First Seed ranks immediately around him.
 */
export function detectDataWarnings(
  candidates: AnomalyCandidate[],
): Map<string, DataWarning> {
  const warnings = new Map<string, DataWarning>();

  const byPosition = new Map<Position, AnomalyCandidate[]>();
  for (const candidate of candidates) {
    if (candidate.firstSeedRank === null) continue;
    if (!Number.isFinite(candidate.projection) || candidate.projection <= 0) continue;
    byPosition.set(candidate.position, [
      ...(byPosition.get(candidate.position) ?? []),
      candidate,
    ]);
  }

  for (const [position, group] of byPosition) {
    if (group.length < MIN_NEIGHBOURS + 1) continue;
    const ranked = [...group].sort((a, b) => a.firstSeedRank! - b.firstSeedRank!);

    ranked.forEach((candidate, index) => {
      // The players ranked nearest him, on both sides, excluding himself.
      const from = Math.max(0, index - NEIGHBOUR_WINDOW);
      const to = Math.min(ranked.length, index + NEIGHBOUR_WINDOW + 1);
      const neighbours = ranked
        .slice(from, to)
        .filter((entry) => entry.playerId !== candidate.playerId)
        .map((entry) => entry.projection);
      if (neighbours.length < MIN_NEIGHBOURS) return;

      const median = medianOf(neighbours);
      if (median <= 0) return;
      const ratio = median / candidate.projection;
      if (ratio < CONFLICT_RATIO) return;

      warnings.set(candidate.playerId, {
        code: 'ranking_projection_conflict',
        detail:
          `First Seed rank and projection materially disagree; consider both signals. ` +
          `They rank him ${candidate.firstSeedRank} at ${position} while projecting ` +
          `${round1(candidate.projection)} points, against a median of ${round1(median)} among the ` +
          `${neighbours.length} ${position}s they rank nearest him. Both numbers are shown as ` +
          `published and neither has been altered.`,
        projection: round1(candidate.projection),
        neighbourMedianProjection: round1(median),
        shortfallRatio: round1(ratio),
      });
    });
  }

  return warnings;
}

function medianOf(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

const round1 = (value: number) => Math.round(value * 10) / 10;
