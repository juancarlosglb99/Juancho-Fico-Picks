import type { CanonicalPlayer } from '../../players/types';
import type { MappedProjection } from '../../projections/types';
import type { DraftRoomRankingSnapshot } from '../../data/types';
import type { Confidence, LeagueContext } from '../context/types';
import type { DraftDecisionInternals } from './internals';

export interface DraftBoardState {
  teams: number;
  rounds: number;
  picksMade: number;
  currentOverallPick: number;
  currentRound: number;
  pickInRound: number;
  draftedSleeperIds: Set<string>;
  keeperSleeperIds: Set<string>;
  unavailableSleeperIds: Set<string>;
  availablePlayers: CanonicalPlayer[];
}

export type RecommendationAction = 'DRAFT_NOW' | 'WAIT';

/**
 * The decision breakdown, in fantasy points wherever a points figure is
 * meaningful. Nothing here is a percentile: a percentile-normalized model
 * reports the least-bad option in a thin pool as though it were a great pick,
 * which is how a replacement-level quarterback used to score 91.
 */
export interface DraftScoreComponents {
  /** Expected value of our FINAL roster if we make this pick. */
  planValue: number;
  /** How far below the best available plan this pick lands (<= 0). */
  planDelta: number;
  /** Points this player adds to our starting lineup right now. */
  marginalStartingValue: number;
  /** Realistic bench/insurance contribution, already discounted. */
  depthValue: number;
  /** Expected points lost by waiting one turn instead of taking him. */
  opportunityCost: number;
  /** 0-100 risk that he is gone by our next pick. */
  nextPickRisk: number;
  /** 0-100 urgency from this position's tier thinning out. */
  tierUrgency: number;
  /** 0-100 how saturated our roster already is at his position. */
  positionalSaturation: number;
}

/** Everything the model inspector needs to explain a recommendation. */
export interface RecommendationInsight {
  positionCount: number;
  startersRequired: number;
  startersFilled: number;
  openStartingSlots: number;
  depthNeed: string;
  saturation: string;
  starterQuality: string;
  build: string;
  strategicPriority: string[];
  possiblePivots: string[];
  expectedFinalRosterValue: number;
  expectedStartingValue: number;
  expectedBenchValue: number;
  expectedUnfilledSlots: number;
  roomTendency: string;
  positionRunActive: boolean;
  opponentTeamsNeedingPosition: number;
  /** Set when a guard fired, e.g. a saturated position was still preferred. */
  exceptionalReason: string | null;
  /** Where Juancho placed him, 1-based, for the First Seed comparison. */
  juanchoBoardRank: number;
  /** First Seed's rank of the best player still on the board. */
  bestAvailableFirstSeedRank: number | null;
  /** How far past First Seed's best available this pick reaches. */
  firstSeedRankGap: number | null;
}

export interface DraftScoreRawValues {
  projectedPoints: number;
  sourceProjectedPoints: number;
  vorp: number;
  scarcityGap: number;
  adpDelta: number | null;
  replacementProjection: number;
  replacementDemand: number;
  rosterNeed: number;
  scoringAdjusted: boolean;
  interveningTeamsWithNeed: number;
  interveningDemand: number;
}

export interface DraftRecommendation {
  player: CanonicalPlayer;
  projection: MappedProjection;
  score: number;
  juanchoRank: number;
  marketAdp: number | null;
  draftRoomRank: number | null;
  externalExpertRank: number | null;
  firstSeedValueDelta: number | null;
  marketEdge: number | null;
  action: RecommendationAction;
  availableNextPickProbability: number | null;
  nextPickConfidence: Confidence;
  nextUserPick: number | null;
  picksUntilNextUserPick: number | null;
  tier: number;
  playersRemainingInTier: number;
  components: DraftScoreComponents;
  insight: RecommendationInsight;
  raw: DraftScoreRawValues;
  nextPickExplanation: {
    picksBeforeNextSelection: number | null;
    interveningTeamsWithNeed: number;
    playerAdp: number | null;
    draftRoomRank: number | null;
    currentSelection: number;
    adpSource: string;
    adpMatchLevel: 'exact' | 'approximate' | 'weak';
    adpMatchReasons: string[];
  };
  reasons: string[];
}

export interface DraftRecommendationResult {
  recommendations: DraftRecommendation[];
  /**
   * The engine's working state, for layers that reason ABOUT the engine.
   *
   * Optional and never read by the engine, the UI or the benchmark: it exists
   * so the AI Strategist can be given what was already computed instead of
   * recomputing it from the same inputs and drifting. Absent whenever the
   * engine could not produce recommendations at all.
   */
  internals?: DraftDecisionInternals;
  status: 'ready' | 'limited' | 'data_required' | 'unsupported';
  messages: string[];
  scoringCoverage:
    | 'league_recalculated'
    | 'provider_precalculated'
    | 'mixed'
    | 'aggregate_unverified';
  context: LeagueContext;
  nextUserPick: number | null;
  picksUntilNextUserPick: number | null;
  userDraftSlot: number | null;
  userRosterId: number | null;
}

export interface RecommendationMarketInputs {
  roomRankings?: DraftRoomRankingSnapshot | null;
}

/**
 * How the 0-100 score is shaped.
 *
 * The score answers one question: how much of the best available outcome does
 * this pick preserve? 100 is the strongest expected final roster on the board,
 * and a pick scores lower in proportion to the final-roster points it gives up.
 * `REFERENCE_LOSS_SHARE` sets how big a giveaway drops a pick to zero.
 */
export const DRAFT_SCORE_SHAPE = {
  /** A pick costing this share of the best plan's value scores 0. */
  referenceLossShare: 0.05,
  /** Floor for the reference, so early picks stay discriminating. */
  minimumReferenceLoss: 18,
} as const;

/** Deadband, in final-roster points, for calling a pick urgent. */
export const DRAFT_NOW_THRESHOLD = 1.5;

/**
 * How much of a plan's FUTURE is trusted.
 *
 * Completing the roster requires guessing twice: what the room does, and what
 * we ourselves will do later. Both are uncertain, and the second one is
 * systematically optimistic - the plan assumes it can come back for whoever it
 * skips, which at back-to-back picks is true and at a twenty-pick gap is not.
 * When two plans tie because each expects to end up with both players, the
 * ranking would otherwise fall through to consensus order and throw away a
 * difference we are certain about.
 *
 * Discounting the speculative part restores that. What a player adds to the
 * lineup RIGHT NOW is banked in full; everything the plan expects to happen
 * afterwards counts for less.
 *
 * How much less is measured, not chosen. At 0.75 the immediate term carried a
 * quarter of the decision, which badly overvalued anyone filling an empty slot
 * with a big raw number - a standard-scoring quarterback most of all, since he
 * outscores every running back on the board while being trivially replaceable.
 * The completed-roster plan knew this and said so (a +2.4 edge on a pick that
 * cost 68 points of final roster); it was simply outvoted.
 *
 * Swept across all twenty seats of both saved boards, against drafting the
 * board itself:
 *
 *     discount    0.85    0.92    0.95
 *     mean       +57.5   +51.7   +47.1
 *     seats worse    1       0       1
 *     worst       -4.5     0.0    -3.2
 *
 * 0.85 has the better average and 0.92 has no losing seat at all. The tail is
 * what matters here: a recommendation that is worse than simply taking the best
 * player available is the failure this engine keeps being reported for, and six
 * points of average is not worth reintroducing it.
 */
export const PLAN_FUTURE_DISCOUNT = Number(
  process.env.JUANCHO_FUTURE_DISCOUNT ?? 0.92,
);

/**
 * How strongly First Seed's board anchors the order.
 *
 * Measured, not chosen. Drafting a saved mock by First Seed rank alone beat the
 * strategy engine by 234 and 341 starting points, which means the deviations
 * were not insight - the completed-roster simulation was confidently wrong
 * about them, claiming an improvement on thirteen of thirteen while the
 * finished team was much worse.
 *
 * So the published board is the prior, and reaching past it has to be paid for.
 * The cost grows with the distance reached, logarithmically: passing a player
 * ranked a few spots higher is cheap, reaching fifty spots down is not. Genuine
 * league-specific reasons - a saturated position, an empty starting slot, a
 * kicker in the last round - move the completed roster by hundreds of points
 * and still win comfortably. Noise of ten or twenty does not.
 *
 * Swept with `npm run tune:consensus` across all twenty seats of both saved
 * boards, against drafting the board itself:
 *
 *     weight       12      15      20
 *     mean       +52.6   +51.7   +46.2
 *     seats worse    2       0       0
 *     worst     -108.3     0.0     0.0
 *
 * Below fifteen the anchor is too weak to stop the engine reaching, and one seat
 * finishes a hundred points behind the board. Above it the anchor swamps
 * everything and the engine just reproduces First Seed - safe, but there is no
 * longer any point to it. Fifteen is the only value that loses on no seat while
 * still finding an edge on half of them.
 *
 * Tuned on two boards, so treat it as provisional and re-run the sweep as mocks
 * accumulate.
 */
export const CONSENSUS_ANCHOR_WEIGHT = Number(
  process.env.JUANCHO_CONSENSUS_WEIGHT ?? 15,
);

/**
 * The cost of stacking a position past what the roster can ever use.
 *
 * Late in a draft every remaining player is worth roughly nothing, and with the
 * differences that small whatever tie-break comes last decides the pick. Board
 * rank was winning those ties, which walked a one-quarterback roster to five
 * quarterbacks: each one was the best-ranked player left, and each was
 * unusable.
 *
 * This is deliberately small - a genuine starting need is worth a hundred
 * points or more and still wins easily - but decisive when nothing else
 * separates the options.
 */
export const SURPLUS_STACK_PENALTY = 40;

/**
 * What an optional selection costs as the draft runs out of room.
 *
 * A draft ends with a fixed number of picks and a fixed number of compulsory
 * slots. While the gap between them is comfortable, depth is free and the
 * ordinary scoring is right. As it closes, a body that cannot reach the lineup
 * stops being merely a weak pick and starts spending a slot we are obliged to
 * fill - and the completed-roster plan does not see it, because the plan
 * happily assumes it can fetch a kicker later.
 *
 * Charged only against candidates that fill no required slot AND add nothing to
 * the lineup, so a genuine starter is never penalised. Deliberately large at
 * the last spare selection: at that point the alternative is forfeiting the
 * only remaining freedom in the draft.
 */
export const ENDGAME_OPTIONAL_PICK_PENALTY = {
  /** Two or more spare selections: depth is genuinely free. */
  free: 0,
  /** Exactly one spare: it has to be worth something. */
  lastSpare: 60,
} as const;

/**
 * How much better a completed roster must be before it overrules a heuristic.
 *
 * A finished roster is worth roughly 1900 points and the plan is a greedy
 * completion, so it wobbles by a point or two for reasons unrelated to the pick.
 * Inside that band the heuristics are exactly what should decide. Outside it,
 * the simulation wins: a player beaten on both First Seed's board and our own
 * final-roster evaluation cannot be recommended above the player who beats him
 * on both.
 */
export const DOMINANCE_PLAN_TOLERANCE = 2;

/** Reaching past this many First Seed ranks starts to cost meaningfully. */
export function consensusAnchorPenalty(rankGap: number): number {
  if (!Number.isFinite(rankGap) || rankGap <= 0) return 0;
  return CONSENSUS_ANCHOR_WEIGHT * Math.log(1 + rankGap);
}
