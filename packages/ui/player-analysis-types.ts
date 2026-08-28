/**
 * The shape of everything the player drawer draws.
 *
 * Separated from the builders because it is the contract the components read
 * and the tests assert against, and because every field here carries a note
 * about what it means - `rosterGain` is not a projection, `chanceBestOfPosition`
 * is counted rather than modelled - which is worth reading without the
 * arithmetic in between.
 *
 * Every section is nullable. A chart appears only when the data behind it
 * exists; nothing here is manufactured to fill a panel.
 */
import type { DataWarning } from '../engine/draft/data-anomaly';
import type { NeedLevel, Saturation } from '../engine/draft/roster-state';
import type { Confidence } from '../engine/context/types';
import type { Position } from '../players/types';

export interface AnalysisHeader {
  playerId: string;
  name: string;
  position: Position;
  team: string | null;
  age: number | null;
  yearsExperience: number | null;
  /**
   * Sleeper's roster status, and only when it is not `Active`.
   *
   * The one thing worth saying about a player that is not a number: a name
   * sitting near the top of a projection board while on injured reserve is a
   * trap, and the projection itself will not mention it.
   */
  status: string | null;
  firstSeedRank: number | null;
  /** First Seed's own published projection, before this league's scoring. */
  firstSeedProjection: number | null;
  /** That projection recalculated for this league. */
  leagueProjection: number | null;
  tier: number | null;
  playersRemainingInTier: number;
  juanchoRank: number | null;
  positionalRank: number | null;
  drafted: boolean;
  /** Where the engine ranked him among its recommendations. */
  engineRank: number | null;
}

export interface PeerBar {
  playerId: string;
  name: string;
  projectedPoints: number;
  firstSeedRank: number | null;
  tier: number | null;
  isSubject: boolean;
}

export interface PeerComparison {
  position: Position;
  bars: PeerBar[];
  /** Rank among available players at this position, 1-based. */
  subjectIndex: number;
  totalAtPosition: number;
}

export interface ReplacementView {
  /**
   * `rosterGain` is what the pick is worth to THIS roster now, which is not the
   * player's projection and can legitimately exceed it: filling an empty
   * starting slot also removes the penalty for having had one. That is the
   * point of the chart - a receiver who projects thirty points fewer can be
   * worth more to a lineup with an empty flex than to one without.
   */
  subject: { name: string; projectedPoints: number; rosterGain: number | null };
  /**
   * Who we would most likely end up with at this position instead.
   *
   * Counted from the simulated futures - the player most often the best of his
   * position left when our turn comes round - not assumed to be the next name
   * on the board.
   */
  replacement: {
    playerId: string;
    name: string;
    projectedPoints: number;
    rosterGain: number | null;
    chanceBestOfPosition: number;
  } | null;
  /** The engine's replacement level for the position, in league points. */
  replacementLevel: number | null;
  pointsDelta: number | null;
  /**
   * The same comparison in roster value rather than raw points.
   *
   * Exactly `subject.rosterGain - replacement.rosterGain`. It can point the
   * opposite way from `pointsDelta`, and when it does, that disagreement is the
   * most useful thing on the chart.
   */
  rosterValueDelta: number | null;
  /** Present when a gain could not be computed for one of the two. */
  caveat: string | null;
}

export interface SurvivalView {
  probability: number;
  confidence: Confidence;
  interveningSelections: number;
  teamsWithNeed: number;
  demand: number;
  /** Simulated futures behind the figure, when the simulation ran. */
  runs: number | null;
}

export interface TierRow {
  playerId: string;
  name: string;
  projectedPoints: number;
  tier: number | null;
  survival: number | null;
  isSubject: boolean;
  /** True when the next player down is in a lower tier. */
  cliffAfter: boolean;
}

export interface TierCliffView {
  position: Position;
  rows: TierRow[];
  subjectTier: number | null;
  playersRemainingInSubjectTier: number;
  /** Projection points between this tier's floor and the next tier's ceiling. */
  gapAfterTier: number | null;
  /** Chance the tier still holds somebody at our next selection. */
  tierSurvives: number | null;
  atRisk: boolean;
}

export interface JointRow {
  playerId: string;
  name: string;
  position: Position;
  reason: 'engine_pick' | 'alternative' | 'same_tier';
  bothSurvive: number;
  atLeastOneSurvives: number;
  neitherSurvives: number;
  otherSurvivesGivenSubjectGone: number | null;
}

export interface JointView {
  subjectSurvives: number;
  rows: JointRow[];
  runs: number;
}

export interface OpponentPressureRow {
  rosterId: number | null;
  teamName: string;
  selections: number[];
  /** Their own need at the subject's position, from the engine's roster model. */
  need: NeedLevel;
  openStartingSlots: number;
  saturation: Saturation;
  /** Higher means more likely to take this position before our turn. */
  pressure: number;
}

export interface OpponentPressureView {
  position: Position;
  rows: OpponentPressureRow[];
  totalSelectionsBefore: number;
  teamsWithNeed: number;
}

export interface PlanStep {
  kind: 'now' | 'gap' | 'target' | 'obligation';
  label: string;
  detail: string;
  overallPick: number | null;
  position: Position | null;
  /** Named players the simulation expects to be available, when it has any. */
  expected: { playerId: string; name: string; frequency: number }[];
}

export interface NextPickPlanView {
  steps: PlanStep[];
  /** The strategist's own sentence about the next pick, when it supplied one. */
  strategistPlan: string | null;
}

export interface PlayerAnalysis {
  header: AnalysisHeader;
  /** The engine's own reasons, when this player is on its shortlist. */
  engineReasons: string[];
  need: { level: NeedLevel; openStartingSlots: number; drafted: number } | null;
  dataWarning: DataWarning | null;
  peers: PeerComparison | null;
  replacement: ReplacementView | null;
  survival: SurvivalView | null;
  tierCliff: TierCliffView | null;
  joint: JointView | null;
  opponentPressure: OpponentPressureView | null;
  plan: NextPickPlanView | null;
}

