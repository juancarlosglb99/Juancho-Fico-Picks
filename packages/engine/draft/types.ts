import type { CanonicalPlayer } from '../../players/types';
import type { MappedProjection } from '../../projections/types';

export interface DraftBoardState {
  teams: number;
  rounds: number;
  picksMade: number;
  currentOverallPick: number;
  currentRound: number;
  pickInRound: number;
  draftedSleeperIds: Set<string>;
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
  vorp: number;
  scarcityGap: number;
  adpDelta: number;
  replacementProjection: number;
}

export interface DraftRecommendation {
  player: CanonicalPlayer;
  projection: MappedProjection;
  score: number;
  action: RecommendationAction;
  availableNextPickProbability: number;
  nextUserPick: number;
  picksUntilNextUserPick: number;
  tier: number;
  playersRemainingInTier: number;
  components: DraftScoreComponents;
  raw: DraftScoreRawValues;
  reasons: string[];
}

export interface DraftRecommendationResult {
  recommendations: DraftRecommendation[];
  nextUserPick: number;
  picksUntilNextUserPick: number;
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
