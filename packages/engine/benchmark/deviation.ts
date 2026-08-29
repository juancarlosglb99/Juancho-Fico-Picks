/**
 * How far Juancho strays from First Seed, and whether straying paid.
 *
 * First Seed's draft-room ranking is the prior. It is a considered, published
 * order that already reflects how the market values players, and Juancho has no
 * business ignoring it without a league-specific reason it can name. The
 * legitimate reasons are narrow:
 *
 *   - the position is saturated on our roster and cannot be started
 *   - Superflex or 1QB changes what a quarterback is worth here
 *   - a required starting slot is still empty
 *   - a tier is about to collapse
 *   - the higher-ranked player is very likely to come back to us
 *   - completing the roster from our pick is measurably better
 *
 * Anything else is the engine inventing its own board, which is what this
 * module exists to detect. Every deviation is classified and then checked
 * against the engine's own completed-roster simulation, so "I had a reason" and
 * "it actually helped" are recorded separately - a deviation can be
 * well-motivated and still wrong.
 */
import type { Position } from '../../players/types';
import type { DraftRecommendation } from '../draft/types';

export type DeviationReason =
  | 'followed_first_seed'
  | 'positional_saturation'
  | 'starter_need'
  | 'tier_cliff'
  | 'returns_to_us'
  | 'opportunity_cost'
  /**
   * Same position, and Juancho's projection simply rates him higher.
   *
   * This is a disagreement about two players, not about strategy. First Seed's
   * rank and First Seed's projection do not always agree with each other, and
   * when the two candidates play the same position and fill the same slot,
   * preferring the higher projection is a defensible reading of First Seed's own
   * data rather than the engine inventing a board.
   */
  | 'higher_projection'
  /**
   * First Seed ranks him but publishes no projection for him.
   *
   * The ranking sheet and the projection sheet do not fully overlap - about ten
   * of two hundred ranked players are missing from the projections. Without a
   * projection there is nothing to put in a lineup and nothing to simulate, so
   * he cannot be scored. That is a gap in the data, not the engine preferring
   * its own board, and it is reported separately so it cannot be mistaken for
   * one.
   */
  | 'first_seed_unprojected'
  | 'unjustified';

export interface DeviationParty {
  playerId: string;
  name: string;
  position: Position;
  /** First Seed's draft-room rank, or null when the sheet does not list him. */
  firstSeedRank: number | null;
  /** Where Juancho placed him in its own list, 1-based. */
  juanchoRank: number | null;
  projection: number;
  /** Points he would add to our STARTING lineup right now. */
  marginalStartingValue: number;
  planValue: number;
  availableNextPickProbability: number | null;
}

export interface DeviationRecord {
  overallPick: number;
  round: number;
  /** Our roster going into this pick, by position. */
  rosterBefore: Partial<Record<Position, number>>;
  /** How many of the teams picking before us still need each position. */
  opponentNeedBefore: Partial<Record<Position, number>>;
  /** Best player still on the board by First Seed rank. */
  firstSeedBest: DeviationParty | null;
  /** What Juancho actually recommended. */
  juancho: DeviationParty;
  /** How many First Seed ranks Juancho moved down. Null if either is unranked. */
  rankGap: number | null;
  reason: DeviationReason;
  explanation: string;
  /** Completed-roster value of our pick minus that of First Seed's best. */
  planDelta: number | null;
  /** Did the deviation improve the completed-roster simulation? */
  improved: boolean | null;
}

/** A deviation this large needs a reason, not a rounding difference. */
export const MEANINGFUL_RANK_GAP = 5;

/** Below this the higher-ranked player is not really expected back. */
const LIKELY_TO_RETURN = 65;

/**
 * Plan points that count as a real difference rather than noise.
 *
 * A finished roster is worth roughly 1900 points, so a two-point difference is
 * a rounding artefact of the greedy completion, not evidence about the pick.
 * Treating every such wobble as a verdict would make the audit unreadable and
 * would punish decisions that are genuinely a coin flip.
 */
const MEANINGFUL_PLAN_GAIN = 2;

/**
 * A loss this size is a real mistake rather than a wobble.
 *
 * Calibrated against the failures this audit was built to catch, which were
 * twenty-two and a hundred and one points.
 */
export const MATERIAL_PLAN_LOSS = 10;

function toParty(
  recommendation: DraftRecommendation,
  juanchoRank: number | null,
): DeviationParty {
  return {
    playerId: recommendation.player.id,
    name: recommendation.player.name,
    position: recommendation.player.position,
    firstSeedRank: recommendation.draftRoomRank,
    juanchoRank,
    projection: recommendation.raw.projectedPoints,
    marginalStartingValue: recommendation.components.marginalStartingValue,
    planValue: recommendation.components.planValue,
    availableNextPickProbability: recommendation.availableNextPickProbability,
  };
}

/**
 * Audits a single selection.
 *
 * `recommendations` must be the engine's full ordered list for this pick, and
 * `firstSeedBestId` the highest First Seed-ranked player still available -
 * whether or not the engine shortlisted him. If the engine did not even
 * consider him, that is itself reported rather than quietly ignored.
 */
export function auditPick({
  overallPick,
  round,
  recommendations,
  rosterBefore,
  opponentNeedBefore,
  firstSeedBestId,
  firstSeedBestName,
  firstSeedBestRank,
  firstSeedBestProjectable = true,
}: {
  overallPick: number;
  round: number;
  rosterBefore: Partial<Record<Position, number>>;
  opponentNeedBefore: Partial<Record<Position, number>>;
  recommendations: DraftRecommendation[];
  firstSeedBestId: string | null;
  firstSeedBestName?: string;
  firstSeedBestRank?: number | null;
  /** False when First Seed ranks him but publishes no projection. */
  firstSeedBestProjectable?: boolean;
}): DeviationRecord | null {
  const chosen = recommendations[0];
  if (!chosen) return null;

  const juancho = toParty(chosen, 1);
  const bestIndex = recommendations.findIndex(
    (entry) => entry.player.id === firstSeedBestId,
  );
  const firstSeedBest =
    bestIndex >= 0 ? toParty(recommendations[bestIndex], bestIndex + 1) : null;

  if (!firstSeedBest) {
    const reason: DeviationReason =
      firstSeedBestId === null
        ? 'followed_first_seed'
        : firstSeedBestProjectable
          ? 'unjustified'
          : 'first_seed_unprojected';
    return {
      overallPick,
      round,
      rosterBefore,
      opponentNeedBefore,
      firstSeedBest:
        firstSeedBestId === null
          ? null
          : {
              playerId: firstSeedBestId,
              name: firstSeedBestName ?? firstSeedBestId,
              position: 'UNKNOWN' as Position,
              firstSeedRank: firstSeedBestRank ?? null,
              juanchoRank: null,
              projection: 0,
              marginalStartingValue: 0,
              planValue: 0,
              availableNextPickProbability: null,
            },
      juancho,
      rankGap: null,
      reason,
      explanation:
        reason === 'followed_first_seed'
          ? 'No First Seed-ranked player was available.'
          : reason === 'first_seed_unprojected'
            ? `First Seed ranks ${firstSeedBestName ?? 'him'} but publishes no projection, so there is nothing to simulate.`
            : 'First Seed’s best available was not among the candidates the engine scored.',
      planDelta: null,
      improved: null,
    };
  }

  if (firstSeedBest.playerId === juancho.playerId) {
    return {
      overallPick,
      round,
      rosterBefore,
      opponentNeedBefore,
      firstSeedBest,
      juancho,
      rankGap: 0,
      reason: 'followed_first_seed',
      explanation: 'Took First Seed’s best available.',
      planDelta: 0,
      improved: null,
    };
  }

  const rankGap =
    juancho.firstSeedRank !== null && firstSeedBest.firstSeedRank !== null
      ? juancho.firstSeedRank - firstSeedBest.firstSeedRank
      : null;
  const planDelta = Math.round((juancho.planValue - firstSeedBest.planValue) * 10) / 10;
  // Three states, not two: better, worse, or genuinely indistinguishable.
  const improved =
    planDelta > MEANINGFUL_PLAN_GAIN
      ? true
      : planDelta < -MEANINGFUL_PLAN_GAIN
        ? false
        : null;

  const passed = recommendations[bestIndex];
  const { reason, explanation } = classify({ chosen, passed, planDelta });

  return {
    overallPick,
    round,
    rosterBefore,
    opponentNeedBefore,
    firstSeedBest,
    juancho,
    rankGap,
    reason,
    explanation,
    planDelta,
    improved,
  };
}

function classify({
  chosen,
  passed,
  planDelta,
}: {
  chosen: DraftRecommendation;
  passed: DraftRecommendation;
  planDelta: number;
}): { reason: DeviationReason; explanation: string } {
  /*
   * The most direct reading of saturation there is: can the higher-ranked player
   * actually improve our starting lineup? The `saturation` label is a summary
   * and misses cases where a position is technically not full but nobody at it
   * would start - which is the same thing from the roster's point of view.
   */
  const passedAddsNothing = passed.components.marginalStartingValue <= 0.01;
  const chosenAddsSomething = chosen.components.marginalStartingValue > 0.01;
  if (passedAddsNothing && chosenAddsSomething) {
    return {
      reason: 'positional_saturation',
      explanation:
        `${passed.player.name} cannot improve our starting lineup at all, ` +
        `while ${chosen.player.name} adds ${chosen.components.marginalStartingValue.toFixed(1)} points to it.`,
    };
  }

  const passedSaturated = ['high', 'complete'].includes(passed.insight.saturation);
  const chosenFillsStarter =
    chosen.insight.startersFilled < chosen.insight.startersRequired;
  const passedFillsStarter =
    passed.insight.startersFilled < passed.insight.startersRequired;

  if (passedSaturated && !['high', 'complete'].includes(chosen.insight.saturation)) {
    return {
      reason: 'positional_saturation',
      explanation: `${passed.player.position} is already saturated on our roster (${passed.insight.positionCount} held, ${passed.insight.startersFilled} starting); he cannot enter the lineup.`,
    };
  }

  if (chosenFillsStarter && !passedFillsStarter) {
    return {
      reason: 'starter_need',
      explanation: `Fills an empty starting ${chosen.player.position} slot; ${passed.player.position} is already covered.`,
    };
  }

  if (
    passed.availableNextPickProbability !== null &&
    passed.availableNextPickProbability >= LIKELY_TO_RETURN &&
    (chosen.availableNextPickProbability ?? 100) < passed.availableNextPickProbability
  ) {
    return {
      reason: 'returns_to_us',
      explanation: `${passed.player.name} is ${Math.round(passed.availableNextPickProbability)}% likely to come back; ${chosen.player.name} is ${Math.round(chosen.availableNextPickProbability ?? 0)}%.`,
    };
  }

  if (chosen.playersRemainingInTier <= 2 && chosen.playersRemainingInTier < passed.playersRemainingInTier) {
    return {
      reason: 'tier_cliff',
      explanation: `Only ${chosen.playersRemainingInTier} left in this ${chosen.player.position} tier against ${passed.playersRemainingInTier} at ${passed.player.position}.`,
    };
  }

  if (planDelta > MEANINGFUL_PLAN_GAIN) {
    return {
      reason: 'opportunity_cost',
      explanation: `Completing the roster from him is worth ${planDelta.toFixed(1)} more points.`,
    };
  }

  if (
    chosen.player.position === passed.player.position &&
    chosen.raw.projectedPoints > passed.raw.projectedPoints
  ) {
    return {
      reason: 'higher_projection',
      explanation:
        `Same position and same slot; First Seed projects him higher ` +
        `(${chosen.raw.projectedPoints.toFixed(1)} against ${passed.raw.projectedPoints.toFixed(1)}) ` +
        `even though it ranks him lower.`,
    };
  }

  return {
    reason: 'unjustified',
    explanation:
      planDelta <= 0
        ? `No league-specific reason, and the completed roster is ${Math.abs(planDelta).toFixed(1)} points WORSE.`
        : 'No league-specific reason, and the completed roster is barely different.',
  };
}

export interface DeviationSummary {
  picks: number;
  followed: number;
  /** Picks where First Seed's best available had no projection to score. */
  unprojected: number;
  deviations: number;
  meaningfulDeviations: number;
  justified: number;
  unjustified: number;
  improvedPlan: number;
  worsenedPlan: number;
  /** Sum of plan points gained (or lost) by deviating. */
  netPlanDelta: number;
  largestGap: DeviationRecord | null;
  worstDeviation: DeviationRecord | null;
  byReason: Record<string, number>;
}

export function summarizeDeviations(records: DeviationRecord[]): DeviationSummary {
  // Data gaps are neither compliance nor deviation; they are excluded from both.
  const deviations = records.filter(
    (entry) =>
      entry.reason !== 'followed_first_seed' && entry.reason !== 'first_seed_unprojected',
  );
  const meaningful = deviations.filter(
    (entry) => (entry.rankGap ?? 0) >= MEANINGFUL_RANK_GAP,
  );
  const byReason: Record<string, number> = {};
  for (const entry of records) {
    byReason[entry.reason] = (byReason[entry.reason] ?? 0) + 1;
  }
  const netPlanDelta = deviations.reduce((sum, entry) => sum + (entry.planDelta ?? 0), 0);

  return {
    picks: records.length,
    followed: records.filter((entry) => entry.reason === 'followed_first_seed').length,
    unprojected: records.filter((entry) => entry.reason === 'first_seed_unprojected').length,
    deviations: deviations.length,
    meaningfulDeviations: meaningful.length,
    justified: deviations.filter((entry) => entry.reason !== 'unjustified').length,
    unjustified: deviations.filter((entry) => entry.reason === 'unjustified').length,
    improvedPlan: deviations.filter((entry) => entry.improved === true).length,
    worsenedPlan: deviations.filter((entry) => entry.improved === false).length,
    netPlanDelta: Math.round(netPlanDelta * 10) / 10,
    largestGap:
      [...deviations].sort((a, b) => (b.rankGap ?? 0) - (a.rankGap ?? 0))[0] ?? null,
    worstDeviation:
      [...deviations].sort((a, b) => (a.planDelta ?? 0) - (b.planDelta ?? 0))[0] ?? null,
    byReason,
  };
}
