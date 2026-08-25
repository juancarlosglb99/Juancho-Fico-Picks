import type { CanonicalPlayer } from '../../players/types';
import type { MappedProjection } from '../../projections/types';
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

export interface DraftScoreComponents {
  projection: number;
  vorp: number;
  scarcity: number;
  tierUrgency: number;
  rosterFit: number;
  adpValue: number;
  nextPickRisk: number;
}

export interface DraftScoreRawValues {
  projectedPoints: number;
  sourceProjectedPoints: number;
  vorp: number;
  scarcityGap: number;
  adpDelta: number;
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
  action: RecommendationAction;
  availableNextPickProbability: number | null;
  nextPickConfidence: Confidence;
  nextUserPick: number | null;
  picksUntilNextUserPick: number | null;
  tier: number;
  playersRemainingInTier: number;
  components: DraftScoreComponents;
  raw: DraftScoreRawValues;
  nextPickExplanation: {
    picksBeforeNextSelection: number | null;
    interveningTeamsWithNeed: number;
    playerAdp: number;
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

export const DRAFT_SCORE_WEIGHTS = {
  vorp: 0.3,
  nextPickRisk: 0.2,
  tierUrgency: 0.15,
  projection: 0.15,
  rosterFit: 0.1,
  adpValue: 0.05,
  scarcity: 0.05,
} as const;
