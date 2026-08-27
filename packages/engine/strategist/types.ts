/**
 * What the AI Strategist is given, and what it is allowed to hand back.
 *
 * The deterministic engine already computes almost everything a strategist
 * needs - every opponent's roster, what the room is doing, how likely a player
 * is to survive to our next turn - and then throws nearly all of it away,
 * keeping only the handful of numbers the screen displays. The `DraftBrief` is
 * that discarded state, assembled into one serializable object.
 *
 * Two principles run through the whole shape.
 *
 * First, First Seed and Juancho are kept SEPARATE. Blending a published rank
 * and our own simulation into a single score is what a model cannot undo, and
 * it is exactly the distinction a strategist has to reason about: "the board
 * says fourth, our simulation says eleventh" is information, and `score: 87` is
 * not.
 *
 * Second, the brief is a snapshot of one exact board state and says so. A draft
 * moves while a request is in flight, and advice about a board that no longer
 * exists is worse than no advice at all.
 */
import type { Position } from '../../players/types';
import type { Confidence } from '../context/types';
import type { LineupSlots } from '../draft/lineup';
import type { PositionalRun, RoomTendency } from '../draft/room-behavior';
import type {
  BuildLabel,
  NeedLevel,
  Saturation,
  StarterQuality,
} from '../draft/roster-state';
import type { RecommendationAction } from '../draft/types';
import type { DataWarning } from '../draft/data-anomaly';
import type { JointAvailability } from './joint';

/** Bumped when the brief's shape changes in a way a stored one cannot satisfy. */
export const DRAFT_BRIEF_VERSION = 1;

/* -------------------------------------------------------------- state identity */

/**
 * Which exact board state a brief describes.
 *
 * A strategist request takes seconds; a draft does not wait for it. Advice
 * carries the state it was reasoning about, and is only ever applied to that
 * same state - so a reply about pick 47 can never overwrite advice about pick
 * 49, however late it arrives.
 *
 * `boardFingerprint` covers the drafted set itself rather than just its size,
 * because Sleeper occasionally corrects a pick rather than appending one.
 */
export interface DraftStateVersion {
  draftId: string;
  picksMade: number;
  currentOverallPick: number;
  currentRound: number;
  boardFingerprint: string;
  onTheClockRosterId: number | null;
  isOurSelection: boolean;
}

/* ------------------------------------------------------------------- the brief */

export interface BriefLeague {
  teams: number;
  rounds: number;
  leagueType: string;
  draftType: string;
  lineupType: string;
  scoringProfile: string;
  qbFormat: '1qb' | 'superflex';
  slots: LineupSlots;
  benchSlots: number;
  /** Points per reception, and anything else that changes what a player is worth. */
  scoring: {
    receptionsBase: number;
    receptionsByPosition: Record<string, number>;
    passingTouchdowns: number;
    tePremium: number;
  };
  isMock: boolean;
}

export interface BriefDraftPosition {
  currentOverallPick: number;
  currentRound: number;
  pickInRound: number;
  ourDraftSlot: number | null;
  ourRosterId: number | null;
  isOurSelection: boolean;
  nextOurPick: number | null;
  picksUntilOurNextSelection: number | null;
  /** Every selection we still own, current one first. */
  ourRemainingSelections: number[];
  picksRemaining: number;
}

export interface BriefRosterPlayer {
  playerId: string;
  sleeperId: string | null;
  name: string;
  position: Position;
  team: string | null;
  /** League-recalculated projection; 0 when nobody projects the position. */
  projectedPoints: number;
  overallPick: number | null;
  round: number | null;
  firstSeedRank: number | null;
}

export interface BriefPositionNeed {
  position: Position;
  startersRequired: number;
  startersFilled: number;
  openStartingSlots: number;
  drafted: number;
  depthNeed: NeedLevel;
  saturation: Saturation;
  starterQuality: StarterQuality;
}

export interface BriefLineupSlotState {
  slot: string;
  filledBy: { playerId: string; name: string; position: Position } | null;
}

/**
 * One team, ours included.
 *
 * Every field here is produced by the same code that describes our own roster,
 * so "what does this opponent need" and "what do we need" are answered on
 * identical terms rather than by two classifiers that quietly disagree.
 */
export interface BriefTeam {
  rosterId: number;
  draftSlot: number | null;
  teamName: string | null;
  isUs: boolean;
  players: BriefRosterPlayer[];
  positionCounts: Partial<Record<Position, number>>;
  startingLineup: BriefLineupSlotState[];
  lineupHoles: { slot: string; count: number }[];
  bench: BriefRosterPlayer[];
  needs: BriefPositionNeed[];
  build: BuildLabel;
  strengths: Position[];
  weaknesses: Position[];
  strategicPriority: Position[];
  unfilledStarterSlots: number;
  /** Their selections in draft order, most recent last. */
  picks: { overallPick: number; round: number; position: Position; name: string }[];
  /** Selections they make between now and our next turn. */
  selectionsBeforeOurNextPick: number[];
  nextSelectionOverall: number | null;
  /** Selections they have already made after our last turn. */
  tendency: BriefTeamTendency;
}

export interface BriefTeamTendency {
  positionShare: Record<string, number>;
  /** Earliest round they spent on each position. */
  firstRoundByPosition: Partial<Record<Position, number>>;
  lastPickPosition: Position | null;
  /** How many of their most recent picks were the same position. */
  consecutiveSamePosition: number;
  /** Positions they have taken earlier than a typical room would. */
  reachedEarlyAt: Position[];
}

export interface BriefRecentPick {
  overallPick: number;
  round: number;
  rosterId: number | null;
  draftSlot: number | null;
  teamName: string | null;
  playerId: string | null;
  sleeperId: string;
  name: string;
  position: Position | null;
  firstSeedRank: number | null;
  /** How far past the best board rank still available this pick reached. */
  firstSeedRankGap: number | null;
}

/**
 * A tier boundary that is about to be crossed.
 *
 * Tiers are derived by Juancho from First Seed's projections; First Seed
 * publishes no explicit tier of its own.
 */
export interface BriefTierCliff {
  position: Position;
  tier: number;
  playersRemainingInTier: number;
  /** Projection points between this tier's floor and the next tier's ceiling. */
  gapAfterTier: number;
  bestRemaining: { playerId: string; name: string; projectedPoints: number } | null;
  /** True when the tier is thin enough to empty before our next turn. */
  atRisk: boolean;
}

export interface BriefRoomState {
  totalDrafted: number;
  /** The most recent selections, oldest first. */
  recentPicks: BriefRecentPick[];
  /** Positions taken inside the recent window. */
  recentPositionCounts: Record<string, number>;
  positionalRuns: PositionalRun[];
  tendency: RoomTendency;
  positionShare: Record<string, number>;
  tierCliffs: BriefTierCliff[];
  /** Who picks between now and our next turn, and what they need. */
  teamsBeforeOurNextPick: {
    rosterId: number | null;
    teamName: string | null;
    selections: number[];
    needs: BriefPositionNeed[];
  }[];
  allDraftedPlayerIds: string[];
}

export type CandidateInclusionReason =
  | 'top_first_seed'
  | 'top_at_position'
  | 'current_tier'
  | 'juancho_shortlist'
  | 'juancho_recommendation'
  | 'required_slot_filler';

/**
 * One available player, with First Seed's view and Juancho's view side by side.
 *
 * Nothing here is blended. `firstSeed.projection` is the number First Seed
 * publishes; `juancho.projectedPoints` is that number recalculated for this
 * league's scoring. A strategist that wants to know whether Juancho is
 * disagreeing with the board can simply compare the two rank fields.
 */
export interface BriefCandidate {
  playerId: string;
  sleeperId: string | null;
  name: string;
  position: Position;
  team: string | null;
  age: number | null;
  yearsExperience: number | null;
  status: string | null;

  firstSeed: {
    /** Rank on First Seed's Sleeper draft-room board for this exact format. */
    rank: number | null;
    /** First Seed's own published projection, before league scoring. */
    projection: number | null;
    valueDelta: number | null;
    expertRank: number | null;
    landmineScore: number | null;
    /** Ranks past First Seed's best available player we could still use. */
    rankGapFromBestAvailable: number | null;
  };

  juancho: {
    /** Position on Juancho's projection board across the whole pool. */
    boardRank: number | null;
    positionalRank: number | null;
    /** First Seed's projection, recalculated for this league's scoring. */
    projectedPoints: number;
    /** Juancho's tiering of First Seed's projections. */
    tier: number | null;
    playersRemainingInTier: number | null;
    /** Where this player placed in Juancho's ranked recommendations, 1-based. */
    recommendationRank: number | null;
    score: number | null;
    action: RecommendationAction | null;
    /** Expected value of our FINAL roster if we take him. */
    planValue: number | null;
    /** That value minus the recommended pick's. Raw simulation, no penalties. */
    planValueVsRecommended: number | null;
    /**
     * What actually sets Juancho's order.
     *
     * The plan's future discounted, then charged for reaching past First Seed
     * and for stacking a position past what the lineup can use. It can order
     * two players differently from `planValue`, and when it does, the
     * difference IS Juancho's opinion rather than its simulation's.
     */
    decisionValue: number | null;
    decisionValueVsRecommended: number | null;
    /** Points he adds to the roster the moment we take him - no guessing. */
    immediateRosterGain: number | null;
  };

  survival: {
    /** 0-100 chance he is still there at our next selection. */
    probability: number | null;
    confidence: Confidence;
    interveningTeamsWithNeed: number;
    interveningDemand: number;
  };

  /**
   * Set when First Seed's own rank and projection disagree about him.
   *
   * Informational. Nothing is rejected or altered - the strategist is simply
   * told the two source signals point different ways so it can weigh them
   * itself instead of assuming they agree.
   */
  dataWarning: DataWarning | null;

  inclusionReasons: CandidateInclusionReason[];
}

export interface BriefDeterministicView {
  status: string;
  messages: string[];
  scoringCoverage: string;
  recommended: {
    playerId: string;
    name: string;
    position: Position;
    score: number;
    action: RecommendationAction;
  } | null;
  /** Juancho's ranked board, as far down as the brief carries it. */
  top: {
    rank: number;
    playerId: string;
    name: string;
    position: Position;
    score: number;
    /** Expected value of our final roster from this pick. */
    planValue: number;
    /** The penalty-adjusted gap to the top pick, which is what set the order. */
    decisionValueDelta: number;
  }[];
  bestAvailableFirstSeed: {
    playerId: string;
    name: string;
    position: Position;
    rank: number;
  } | null;
}

/**
 * The rules the guardrails will enforce, stated up front.
 *
 * A model that is told what is illegal before it answers is far likelier to
 * stay legal than one that is only corrected afterwards, and stating them here
 * keeps the prompt and the validator reading from the same source.
 */
export interface BriefConstraints {
  slots: LineupSlots;
  rosterSpotsRemaining: number;
  /** Bodies at each position that could ever reach our lineup. */
  usableCapacity: Partial<Record<Position, number>>;
  /** Positions that cannot legally be selected right now, and why. */
  blockedPositions: { position: Position; reason: string }[];
  /** Starting slots that must still be filled before the draft ends. */
  mustFillBeforeDraftEnds: { position: Position; count: number }[];
  /** True while kickers and defenses may be selected. */
  kickersAndDefensesAllowed: boolean;
  /** How much room is left for anything that is not a required starter. */
  endgame: EndgameBudget;
}

/**
 * Selections left, against slots we are still obliged to fill.
 *
 * A draft ends with a fixed number of picks and a fixed number of compulsory
 * slots, and the gap between them is the entire budget for optional depth. It
 * starts large and shrinks; once it reaches zero every remaining selection is
 * spoken for, and a bench body is not a weaker choice at that point but an
 * illegal one.
 *
 * Derived from obligations rather than from a round number: "take a defense in
 * round 14" is right in one league and wrong in the next, while "you have two
 * picks and two empty compulsory slots" is right in all of them.
 */
export interface EndgameBudget {
  /** Compulsory starting slots still empty - K, DEF, and any unfilled starter. */
  requiredSlotsRemaining: number;
  ourSelectionsRemaining: number;
  /** Selections beyond our obligations. Zero means every pick is committed. */
  spareSelections: number;
  /** Which slots those obligations are. */
  requiredPositions: { position: Position; count: number }[];
  /**
   * What an optional pick has to be worth right now.
   *
   * `free` while there is real room, `costly` on the last spare selection, and
   * `committed` when there is none - at which point taking depth forfeits a
   * slot that cannot be recovered.
   */
  optionalPickCost: 'free' | 'costly' | 'committed';
}

/* ------------------------------------------------- reserved extension points */

/**
 * The permanent fantasy-draft playbook.
 *
 * Not implemented. Present so the brief's shape does not change when it is:
 * consumers must already handle `null`.
 */
export interface StrategyContext {
  version: string;
  principles: { id: string; title: string; body: string }[];
  formatNotes: string[];
}

/**
 * Current player information - injuries, depth chart, beat reporting.
 *
 * Not implemented, for the same reason as `StrategyContext`.
 */
export interface PlayerNewsItem {
  playerId: string;
  headline: string;
  body: string;
  source: string;
  publishedAt: string;
  severity: 'info' | 'notable' | 'major';
}

/* ------------------------------------------------------------------ the whole */

export interface DraftBrief {
  briefVersion: number;
  state: DraftStateVersion;
  league: BriefLeague;
  draft: BriefDraftPosition;
  ourTeam: BriefTeam;
  opponents: BriefTeam[];
  room: BriefRoomState;
  candidates: BriefCandidate[];
  /**
   * Availability questions about more than one player at a time.
   *
   * Counted from the same simulated futures as the marginal survival numbers,
   * so "will either of these reach us" can be read rather than inferred.
   * Null when the availability model has no futures to count.
   */
  jointAvailability: JointAvailability | null;
  deterministic: BriefDeterministicView;
  constraints: BriefConstraints;
  strategyContext: StrategyContext | null;
  playerNews: PlayerNewsItem[] | null;
}

/* ------------------------------------------------------------ what comes back */

export interface StrategistPick {
  playerId: string;
  reasoning: string;
  /** Free-form; deliberately NOT constrained to the deviation vocabulary. */
  reasonCodes: string[];
  confidence: number;
}

export interface StrategistAdvice {
  /** The board state the strategist reasoned about. Never applied to another. */
  state: DraftStateVersion;
  primary: StrategistPick;
  alternatives: StrategistPick[];
  /** How the strategist reads the room as a whole. */
  roomRead: string | null;
  /** 0-1. Models report 0-100; the boundary normalises. */
  confidence: number;
  model?: string | null;

  /* --- richer fields, present when the strategist supplies them --- */

  /**
   * How much the timing matters, separately from the choice of player.
   *
   * Not the deterministic engine's `RecommendationAction`, which annotates
   * every candidate on the board and is unchanged. This describes the single
   * selection the strategist named.
   */
  urgency?: 'must_take_now' | 'likely_to_return' | 'neutral';
  /** The roster shape this pick serves, named concretely. */
  strategy?: string;
  /** Required when the pick reaches meaningfully past First Seed. */
  firstSeedDeviationReason?: string | null;
  /** The best selection other than this one. */
  strongestAlternativePlayerId?: string;
  strongestAlternativeWhy?: string;
  /** The fact that most threatens this pick, stated at full strength. */
  strongestCounterargument?: string;
  /** The direct answer to it. */
  whyRecommendationStillWins?: string;
  /** What we expect to do at our next selection, given this one. */
  expectedNextPickPlan?: string;
  /** The teams whose selections before our next turn changed the decision. */
  opponentsThatMatter?: { rosterId: number; why: string }[];
}

/**
 * A strategist implementation.
 *
 * An interface rather than a concrete client so the corpus, the replays and
 * every test stay offline and deterministic: a fake strategist is a function.
 */
export interface StrategistClient {
  readonly id: string;
  advise(brief: DraftBrief, signal?: AbortSignal): Promise<StrategistAdvice | null>;
}
