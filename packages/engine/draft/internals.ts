/**
 * The working state the recommendation engine builds and then discards.
 *
 * `generateDraftRecommendations` computes every opponent's roster, what the
 * room is doing, which teams pick before our turn and what each of them needs,
 * a survival estimate for any player, and a completed-roster plan for every
 * candidate it shortlists. Almost none of that survives into the result: the
 * screen needs a ranked list and a few summary numbers, so a ranked list and a
 * few summary numbers is what it returns.
 *
 * The AI Strategist needs all of it. Recomputing it elsewhere would mean a
 * second copy of some genuinely subtle logic - mock drafts report no roster id
 * on picks, consensus rank is the First Seed board and deliberately never ADP,
 * a candidate must be reserved before his own plan is simulated - and two
 * copies of that will drift, quietly, into disagreeing about the same board.
 *
 * So the engine hands its working state out instead. Nothing here is computed
 * for this purpose; it is all state that already existed a few lines earlier.
 *
 * This is NOT serializable and is not meant to be: it holds maps and closures.
 * The serializable snapshot is `DraftBrief`, built from it.
 */
import type { CanonicalPlayer, Position } from '../../players/types';
import type { MappedDraftRoomRankingRecord } from '../../data/types';
import type { MappedProjection } from '../../projections/types';
import type { Confidence } from '../context/types';
import type { LineupPlayer, LineupSlots } from './lineup';
import type { InterveningTeam, RoomBehavior } from './room-behavior';
import type { RosterConstructionState } from './roster-state';
import type { PlannablePlayer } from './roster-plan';
import type { DataWarning } from './data-anomaly';
import type { RoomOutcomes } from './room-simulation';
import type { ProjectionTier } from './tiers';

/** What the engine worked out about one candidate it fully planned. */
export interface PlannedCandidate {
  playerId: string;
  /** Expected value of our FINAL roster if we take him. */
  planTotal: number;
  /** Value of the roster the moment the pick is made - no guessing involved. */
  immediate: number;
  /**
   * What actually decides the ranking.
   *
   * The plan's future discounted, then charged for reaching past First Seed and
   * for stacking a position past what a lineup can use. Deliberately NOT the
   * same quantity as `planTotal`, and the two can order candidates differently.
   */
  decisionValue: number;
}

export interface SurvivalEstimate {
  value: number | null;
  confidence: Confidence;
  teamsWithNeed: number;
  demand: number;
}

export interface DraftDecisionInternals {
  slots: LineupSlots;
  /** Our roster, described the same way every opponent's will be. */
  rosterState: RosterConstructionState;
  roomBehavior: RoomBehavior;
  interveningTeams: InterveningTeam[];
  /** Position counts for every roster in the league, keyed by roster id. */
  rosterCounts: Map<number, Partial<Record<Position, number>>>;
  slotToRosterId: Record<string, number>;
  ourRosterPlayers: LineupPlayer[];
  /** What our roster is worth before this pick, so a gain can be a real gain. */
  currentRosterValue: number;
  ourSelections: { position: Position; round: number }[];
  /** Every selection we still own, the one on the clock included. */
  ourFuturePicks: number[];
  /** Every available, projected player - not just the shortlist. */
  candidatePool: PlannablePlayer[];
  /**
   * The individual simulated futures behind the survival numbers.
   *
   * Null when the availability model is the old independent hazard, which has
   * no futures to expose. Joint questions - will BOTH of these reach us, will
   * EITHER - are answered by counting these runs rather than by multiplying
   * marginals, which would assume an independence the draft does not have.
   */
  roomOutcomes: RoomOutcomes | null;
  /** True while kickers and defenses may be selected. */
  kickersAndDefensesAllowed: boolean;
  /**
   * First Seed's best rank still available at a position we could use.
   *
   * The reach on every other player is measured from here, so it is the same
   * number the anchor penalty uses rather than a second opinion about it.
   */
  bestAvailableConsensusRank: number | null;
  bestAvailableConsensusPlayerId: string | null;

  projectionOf(playerId: string): MappedProjection | undefined;
  /** The provider's own number, before league scoring is applied. */
  sourceProjectionOf(playerId: string): MappedProjection | undefined;
  firstSeedOf(playerId: string): MappedDraftRoomRankingRecord | undefined;
  tierOf(playerId: string): ProjectionTier | undefined;
  playersRemainingInTier(playerId: string): number;
  juanchoBoardRankOf(playerId: string): number | undefined;
  positionalRankOf(playerId: string): number | undefined;
  plannedOf(playerId: string): PlannedCandidate | undefined;
  /** Cached, so asking about a hundred candidates costs one pass each. */
  survivalOf(playerId: string): SurvivalEstimate;
  playerOf(playerId: string): CanonicalPlayer | undefined;
  /** Set where First Seed's rank and projection contradict each other. */
  dataWarningOf(playerId: string): DataWarning | undefined;
}
