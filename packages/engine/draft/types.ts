import type { CanonicalPlayer } from '../../players/types';
import type { MappedProjection } from '../../projections/types';
import type { DraftRoomRankingSnapshot } from '../../data/types';
import type { Confidence, LeagueContext } from '../context/types';

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
