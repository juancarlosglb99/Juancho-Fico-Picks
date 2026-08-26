import type { CanonicalPlayer, CanonicalPlayerMap, Position } from '../../players/types';
import type { DraftRoomRankingSnapshot } from '../../data/types';
import type { MappedProjection } from '../../projections/types';
import type { SleeperDraftPick, SleeperRoster } from '../../sleeper/types';
import { scoreProjectionForLeague, type ScoredProjection } from '../context/scoring';
import type { Confidence, LeagueContext, RosterConfiguration } from '../context/types';
import { clamp, round } from './math';
import {
  listUserSelections,
  probabilityAvailableAtNextPick,
} from './next-pick-probability';
import { evaluateRoster, lineupSlotsFor, type LineupPlayer } from './lineup';
import { resolvePickRosterId, type SlotToRosterId } from './pick-ownership';
import { planRemainingRoster, type PlannablePlayer } from './roster-plan';
import {
  buildRosterConstructionState,
  startingFootprint,
  type RosterConstructionState,
} from './roster-state';
import {
  describeRoomBehavior,
  opponentDemandForPosition,
  type InterveningTeam,
} from './room-behavior';
import { getRosterPositionCounts } from './roster-fit';
import { buildProjectionTiers } from './tiers';
import { buildFillerCandidates } from './late-round-fillers';
import {
  DRAFT_NOW_THRESHOLD,
  DRAFT_SCORE_SHAPE,
  DOMINANCE_PLAN_TOLERANCE,
  PLAN_FUTURE_DISCOUNT,
  SURPLUS_STACK_PENALTY,
  consensusAnchorPenalty,
  type DraftBoardState,
  type DraftRecommendation,
  type DraftRecommendationResult,
  type DraftScoreComponents,
  type RecommendationAction,
  type RecommendationInsight,
} from './types';

/** How many overall candidates get a full roster plan computed. */
const SHORTLIST_OVERALL = 34;
/** Plus this many of the best at each position, so real needs survive. */
const SHORTLIST_PER_POSITION = 4;
/** How many of the leaders get the full take-now-versus-wait comparison. */
const WAIT_ANALYSIS_DEPTH = 8;
/** Top of First Seed's board, always scored whatever the roster wants. */
const SHORTLIST_CONSENSUS = 12;

interface RecommendationInput {
  context: LeagueContext;
  picks: SleeperDraftPick[];
  rosters: SleeperRoster[];
  board: DraftBoardState;
  players: CanonicalPlayerMap;
  projections: MappedProjection[];
  roomRankings?: DraftRoomRankingSnapshot | null;
}

interface ValuedProjection {
  source: MappedProjection;
  scored: MappedProjection;
  scoring: ScoredProjection;
}

const CORE_POSITIONS = new Set<Position>(['QB', 'RB', 'WR', 'TE']);

function starterDemand(position: Position, roster: RosterConfiguration): number {
  const flexDemand =
    position === 'RB'
      ? roster.FLEX * 0.44
      : position === 'WR'
        ? roster.FLEX * 0.46
        : position === 'TE'
          ? roster.FLEX * 0.1
          : 0;
  const superFlexDemand =
    position === 'QB'
      ? roster.SUPER_FLEX * 0.88
      : position === 'RB'
        ? roster.SUPER_FLEX * 0.04
        : position === 'WR'
          ? roster.SUPER_FLEX * 0.05
          : position === 'TE'
            ? roster.SUPER_FLEX * 0.03
            : 0;
  const direct =
    position === 'QB'
      ? roster.QB
      : position === 'RB'
        ? roster.RB
        : position === 'WR'
          ? roster.WR
          : position === 'TE'
            ? roster.TE
            : position === 'K'
              ? roster.K
              : position === 'DEF'
                ? roster.DEF
                : 0;
  return direct + flexDemand + superFlexDemand;
}

export function calculateReplacementDemand(
  position: Position,
  context: LeagueContext,
): number {
  const roster = context.roster.value;
  const teams = context.teams.value;
  const corePositions: Position[] = ['QB', 'RB', 'WR', 'TE'];
  const positionStarterDemand = starterDemand(position, roster);
  if (!CORE_POSITIONS.has(position)) {
    return Math.max(1, Math.ceil(positionStarterDemand * teams));
  }
  const totalCoreStarterDemand = corePositions.reduce(
    (sum, candidate) => sum + starterDemand(candidate, roster),
    0,
  );
  const benchUtilization = roster.SUPER_FLEX > 0 || roster.QB >= 2 ? 0.75 : 0.45;
  const positionShare =
    totalCoreStarterDemand > 0 ? positionStarterDemand / totalCoreStarterDemand : 0;
  const benchDemand = roster.bench * benchUtilization * positionShare;
  const perTeam = positionStarterDemand + benchDemand;
  const cappedPerTeam = position === 'QB' ? Math.min(2.5, perTeam) : perTeam;
  return Math.max(1, Math.ceil(cappedPerTeam * teams));
}

export function getReplacementProjections(
  projections: MappedProjection[],
  context: LeagueContext,
): Map<Position, number> {
  const positions = new Map<Position, MappedProjection[]>();
  for (const projection of projections) {
    positions.set(projection.position, [
      ...(positions.get(projection.position) ?? []),
      projection,
    ]);
  }
  const replacements = new Map<Position, number>();
  for (const [position, records] of positions) {
    const sorted = [...records].sort((a, b) => b.projection - a.projection);
    const index = Math.min(
      sorted.length - 1,
      calculateReplacementDemand(position, context) - 1,
    );
    replacements.set(position, sorted[Math.max(0, index)]?.projection ?? 0);
  }
  return replacements;
}

function uniqueProjectionRecords(records: MappedProjection[]): MappedProjection[] {
  const byPlayer = new Map<string, MappedProjection>();
  for (const record of records) {
    const current = byPlayer.get(record.playerId);
    if (!current || record.projection > current.projection) byPlayer.set(record.playerId, record);
  }
  return [...byPlayer.values()];
}

function confidenceWeight(confidence: Confidence): number {
  return confidence === 'high' ? 1 : confidence === 'medium' ? 0.6 : 0.25;
}

function scoringCoverage(
  valued: ValuedProjection[],
  context: LeagueContext,
): DraftRecommendationResult['scoringCoverage'] {
  const adjusted = valued.filter((item) => item.scoring.adjustedForLeagueScoring).length;
  if (adjusted === valued.length && valued.length > 0) return 'league_recalculated';
  if (adjusted > 0) return 'mixed';
  const expected = context.scoring.value.profile;
  const scoring = context.scoring.value;
  const receptionValues = Object.values(scoring.reception.byPosition);
  const usesBaselineScoring =
    expected !== 'unknown' &&
    expected !== 'custom' &&
    receptionValues.every((amount) => amount === scoring.reception.base) &&
    scoring.passing.yards === 0.04 &&
    scoring.passing.touchdowns === 4 &&
    scoring.passing.interceptions === -2 &&
    scoring.rushing.yards === 0.1 &&
    scoring.rushing.touchdowns === 6 &&
    scoring.receiving.yards === 0.1 &&
    scoring.receiving.touchdowns === 6 &&
    Object.keys(scoring.bonuses).length === 0;
  const verified =
    usesBaselineScoring &&
    valued.length > 0 &&
    valued.every(
      (item) =>
        item.source.projectionScoring?.trim().toLowerCase().replace(/[\s-]+/g, '_') ===
        expected,
    );
  return verified ? 'provider_precalculated' : 'aggregate_unverified';
}

function baseSupport(context: LeagueContext): {
  status: DraftRecommendationResult['status'];
  messages: string[];
} {
  const messages = [...context.warnings];
  if (context.leagueType.value === 'unknown') {
    return {
      status: 'data_required',
      messages: [
        ...messages,
        'Recommendations are paused until the league type is confirmed.',
      ],
    };
  }
  if (context.draftType.value === 'auction') {
    return {
      status: 'unsupported',
      messages: [
        ...messages,
        'Auction format detected. Snake-style next-pick and roster construction advice is disabled.',
      ],
    };
  }
  if (context.draftType.value === 'unknown') {
    return {
      status: 'unsupported',
      messages: [...messages, 'Sleeper returned an unsupported draft order.'],
    };
  }
  if (context.leagueType.value === 'dynasty') {
    const contextLabel =
      context.draftContext.value === 'rookie_supplemental'
        ? 'rookie/supplemental'
        : context.draftContext.value === 'startup'
          ? 'startup'
          : 'unresolved';
    return {
      status: 'data_required',
      messages: [
        ...messages,
        `Dynasty ${contextLabel} draft detected. Redraft projections are intentionally not used as dynasty values.`,
        'Import from a future DynastyValueProvider before dynasty recommendations are enabled.',
      ],
    };
  }
  if (context.lineupType.value === 'best_ball') {
    messages.push(
      'Best Ball detected. Roster-fit scoring is neutralized because weekly lineup assumptions do not apply.',
    );
  }
  if (context.lineupType.value === 'unknown') {
    messages.push(
      'Lineup type is unresolved. Roster-fit scoring is neutralized until Classic or Best Ball is confirmed.',
    );
  }
  if (context.leagueType.value === 'keeper') {
    messages.push(
      'Keeper advice is current-season only because keeper costs and escalation rules are not fully known.',
    );
  }
  return {
    status:
      context.lineupType.value !== 'classic' || context.leagueType.value === 'keeper'
        ? 'limited'
        : 'ready',
    messages,
  };
}

/**
 * Says why, in the language a person drafting would use.
 *
 * The order matters: what this does for the roster comes first, then what the
 * board is doing to force the issue, then the market footnote. A recommendation
 * that contradicts the obvious reading - taking someone who is almost certain
 * to survive - has to explain itself, and does.
 */
function buildStrategicReasons({
  player,
  components,
  insight,
  probability,
  playersRemainingInTier,
  rosterState,
}: {
  player: CanonicalPlayer;
  components: DraftScoreComponents;
  insight: RecommendationInsight;
  probability: number | null;
  playersRemainingInTier: number;
  rosterState: RosterConstructionState;
}): string[] {
  const reasons: string[] = [];
  const position = player.position;

  if (components.marginalStartingValue > 0.5) {
    if (insight.startersFilled < insight.startersRequired) {
      reasons.push(`Fills an open starting ${position} slot`);
    } else {
      reasons.push(
        `Adds ${components.marginalStartingValue.toFixed(1)} pts to your starting lineup`,
      );
    }
  } else if (insight.saturation === 'complete' || insight.saturation === 'high') {
    reasons.push(
      `You already start ${insight.startersFilled} at ${position}; another cannot enter the lineup`,
    );
  } else {
    reasons.push(`Bench depth only - does not improve your starting lineup today`);
  }

  if (insight.positionRunActive) {
    reasons.push(`${position} run underway - ${insight.opponentTeamsNeedingPosition} of the teams ahead still need one`);
  } else if (playersRemainingInTier <= 2) {
    reasons.push(
      playersRemainingInTier === 1
        ? `Last player left in this tier`
        : `Only ${playersRemainingInTier} left in this tier`,
    );
  }

  if (probability !== null) {
    reasons.push(
      components.opportunityCost > DRAFT_NOW_THRESHOLD
        ? `Waiting costs about ${components.opportunityCost.toFixed(1)} pts of final roster`
        : probability >= 99.5
          ? `You pick again right away, so he is not going anywhere`
          : `About ${Math.round(probability)}% likely to still be there next turn`,
    );
  }

  if (insight.exceptionalReason) reasons.push(insight.exceptionalReason);

  if (reasons.length < 4 && rosterState.strategicPriority.length > 0) {
    const priority = rosterState.strategicPriority[0];
    if (priority && priority !== position) {
      reasons.push(`Roster still needs ${rosterState.strategicPriority.slice(0, 2).join(' and ')}`);
    }
  }

  return reasons.slice(0, 4);
}

/** Falls back to an identity slot map when the context has none. */
function draftSlotMap(rosters: SleeperRoster[]): SlotToRosterId {
  return Object.fromEntries(rosters.map((roster, index) => [String(index + 1), roster.roster_id]));
}

function unavailableResult(
  context: LeagueContext,
  status: DraftRecommendationResult['status'],
  messages: string[],
): DraftRecommendationResult {
  return {
    recommendations: [],
    status,
    messages,
    scoringCoverage: 'aggregate_unverified',
    context,
    nextUserPick: context.draftState.value.nextUserPick,
    picksUntilNextUserPick: context.draftState.value.picksBeforeNextSelection,
    userDraftSlot: context.draftState.value.userDraftSlot,
    userRosterId: context.draftState.value.userRosterId,
  };
}

export function generateDraftRecommendations({
  context,
  picks,
  rosters,
  board,
  players,
  projections: inputProjections,
  roomRankings = null,
}: RecommendationInput): DraftRecommendationResult {
  const support = baseSupport(context);
  if (support.status === 'unsupported' || support.status === 'data_required') {
    return unavailableResult(context, support.status, support.messages);
  }

  const valued: ValuedProjection[] = uniqueProjectionRecords(inputProjections).map(
    (projection) => {
      const scoring = scoreProjectionForLeague(projection, context.scoring.value);
      return {
        source: projection,
        scored: { ...projection, projection: scoring.points },
        scoring,
      };
    },
  );
  const coverage = scoringCoverage(valued, context);
  let status = support.status;
  const messages = [...support.messages];
  if (coverage === 'aggregate_unverified') {
    status = 'limited';
    messages.push(
      'Fantasy points are aggregate and their scoring format is unverified; custom Sleeper scoring is not recalculated.',
    );
  } else if (coverage === 'mixed') {
    status = 'limited';
    messages.push('Only rows with complete stat lines were recalculated for league scoring.');
  }
  if (valued.some((item) => item.scoring.limitations.length > 0)) {
    status = 'limited';
    messages.push(...new Set(valued.flatMap((item) => item.scoring.limitations)));
  }
  if (context.roster.value.SUPER_FLEX > 0 || context.roster.value.QB >= 2) {
    const hasMatchingAdp = valued.some(
      (item) => item.source.adpFormat === 'redraft_superflex',
    );
    if (!hasMatchingAdp) {
      messages.push(
        'Superflex/2QB replacement demand is incorporated, but next-pick probability is approximate until compatible Superflex ADP is available.',
      );
    }
  }

  const availableIds = new Set(board.availablePlayers.map((player) => player.id));
  const allowKickersAndDefense = board.currentRound >= Math.max(1, board.rounds - 2);
  const projectedCandidates = valued.filter(
    ({ scored }) =>
      availableIds.has(scored.playerId) &&
      (CORE_POSITIONS.has(scored.position) ||
        (allowKickersAndDefense && ['K', 'DEF'].includes(scored.position))),
  );

  /*
   * Nobody projects kickers or defenses, so in a league that starts them the
   * engine could never recommend one and finished with a lineup it could not
   * legally field. Stand-ins are offered in the closing rounds, and only while
   * the slot is still empty.
   */
  const preliminaryRosterId = context.draftState.value.userRosterId;
  const heldPositions =
    preliminaryRosterId === null
      ? {}
      : getRosterPositionCounts(
          preliminaryRosterId,
          picks,
          rosters,
          players,
          context.draftState.value.slotToRosterId,
        );
  const fillerProjections = buildFillerCandidates({
    board,
    slots: lineupSlotsFor(context.roster.value),
    heldPositions,
    alreadyProjected: new Set(valued.map((item) => item.scored.playerId)),
  });
  const fillerValued: ValuedProjection[] = fillerProjections.map((projection) => ({
    source: projection,
    scored: projection,
    scoring: {
      points: projection.projection,
      adjustedForLeagueScoring: false,
      source: 'provider-aggregate',
      limitations: [
        'Kicker and defense values are nominal; no provider projects these positions.',
      ],
    } satisfies ScoredProjection,
  }));
  const candidates = [...projectedCandidates, ...fillerValued];
  if (candidates.length === 0) {
    return {
      ...unavailableResult(context, status, messages),
      scoringCoverage: coverage,
    };
  }

  const scoredProjections = [...valued, ...fillerValued].map((item) => item.scored);
  const leagueRankByPlayer = new Map(
    [...scoredProjections]
      .sort((a, b) => b.projection - a.projection || a.playerName.localeCompare(b.playerName))
      .map((projection, index) => [projection.playerId, index + 1]),
  );
  const tiers = buildProjectionTiers(scoredProjections);
  const replacements = getReplacementProjections(scoredProjections, context);
  const userRosterId = context.draftState.value.userRosterId;
  const rosterCounts = new Map(
    rosters.map((roster) => [
      roster.roster_id,
      getRosterPositionCounts(roster.roster_id, picks, rosters, players),
    ]),
  );
  const roomByPlayerId = new Map(
    (roomRankings?.records ?? []).map((record) => [record.playerId, record]),
  );

  const availableByPosition = new Map<Position, ValuedProjection[]>();
  for (const candidate of candidates) {
    availableByPosition.set(candidate.scored.position, [
      ...(availableByPosition.get(candidate.scored.position) ?? []),
      candidate,
    ]);
  }
  for (const [position, records] of availableByPosition) {
    availableByPosition.set(
      position,
      [...records].sort((a, b) => b.scored.projection - a.scored.projection),
    );
  }

  /* ------------------------------------------------------- roster-aware inputs */

  const valuedById = new Map(
    [...valued, ...fillerValued].map((item) => [item.scored.playerId, item]),
  );
  const slots = lineupSlotsFor(context.roster.value);
  const slotToRosterId = context.draftState.value.slotToRosterId ?? draftSlotMap(rosters);
  const projectionByPlayerId = new Map(scoredProjections.map((item) => [item.playerId, item]));

  // Rank within a player's own position, used to describe starter quality.
  const positionalRankByPlayer = new Map<string, number>();
  {
    const grouped = new Map<Position, MappedProjection[]>();
    for (const item of scoredProjections) {
      grouped.set(item.position, [...(grouped.get(item.position) ?? []), item]);
    }
    for (const [, list] of grouped) {
      [...list]
        .sort((a, b) => b.projection - a.projection)
        .forEach((item, index) => positionalRankByPlayer.set(item.playerId, index + 1));
    }
  }

  // Our roster. Mock drafts report no roster id on picks, so ownership is
  // resolved through the draft slot as well.
  const ourSleeperIds = new Set<string>();
  const selectionRounds: { position: Position; round: number }[] = [];
  for (const pick of picks) {
    if (userRosterId === null) break;
    if (resolvePickRosterId(pick, slotToRosterId) !== userRosterId) continue;
    ourSleeperIds.add(pick.player_id);
    const owned = players.bySleeperId.get(pick.player_id);
    if (owned) selectionRounds.push({ position: owned.position, round: pick.round });
  }
  for (const sleeperId of rosters.find((r) => r.roster_id === userRosterId)?.players ?? []) {
    ourSleeperIds.add(sleeperId);
  }
  const rosterPlayers: LineupPlayer[] = [];
  for (const sleeperId of ourSleeperIds) {
    const owned = players.bySleeperId.get(sleeperId);
    if (!owned) continue;
    rosterPlayers.push({
      playerId: owned.id,
      position: owned.position,
      projection: projectionByPlayerId.get(owned.id)?.projection ?? 0,
    });
  }

  const ourFuturePicks = listUserSelections(
    board.currentOverallPick,
    board.teams,
    board.rounds,
    context.draftType.value,
    context.draftState.value.userDraftSlot,
    {
      userRosterId,
      slotToRosterId,
      tradedPicks: context.draftState.value.tradedPicks,
    },
  );
  const picksRemaining = ourFuturePicks.length;
  const lastOverallPick = board.teams * board.rounds;

  const rosterState = buildRosterConstructionState({
    rosterPlayers,
    slots,
    teams: board.teams,
    picksRemaining,
    positionalRank: (playerId) => positionalRankByPlayer.get(playerId) ?? null,
    selectionRounds,
  });

  /* --------------------------------------------------------- room behaviour */

  const orderedPicks = [...picks].sort((a, b) => a.pick_no - b.pick_no);
  const pickedPositions = orderedPicks
    .map((pick) => players.bySleeperId.get(pick.player_id)?.position)
    .filter((position): position is Position => Boolean(position));
  const roomBehavior = describeRoomBehavior(pickedPositions, pickedPositions);

  const interveningTeams: InterveningTeam[] = context.draftState.value.interveningSelections.map(
    (selection) => ({
      rosterId: selection.ownerRosterId,
      counts: selection.ownerRosterId === null ? {} : rosterCounts.get(selection.ownerRosterId) ?? {},
    }),
  );

  /* ------------------------------------------------- the plannable candidate pool */

  const consensusRankFor = (projection: MappedProjection): number => {
    // First Seed's Sleeper draft-room rank is the market signal for a Sleeper
    // draft. Market ADP is deliberately NOT consulted here.
    const room = roomByPlayerId.get(projection.playerId);
    if (room) return room.rank;
    return leagueRankByPlayer.get(projection.playerId) ?? 999;
  };

  const plannable: PlannablePlayer[] = candidates.map(({ scored }) => ({
    playerId: scored.playerId,
    position: scored.position,
    projection: scored.projection,
    consensusRank: consensusRankFor(scored),
  }));

  const basePlanInput = {
    rosterPlayers,
    available: plannable,
    ourFuturePicks,
    currentOverallPick: board.currentOverallPick,
    lastOverallPick,
    slots,
  };

  /* ------------------------------------------- shortlist, then plan properly */

  const currentRosterValue = evaluateRoster(rosterPlayers, slots);
  const immediateGain = (candidate: PlannablePlayer) =>
    evaluateRoster([...rosterPlayers, candidate], slots).total - currentRosterValue.total;

  const priorScored = plannable
    .map((candidate) => ({ candidate, gain: immediateGain(candidate) }))
    .sort((a, b) => b.gain - a.gain || a.candidate.consensusRank - b.candidate.consensusRank);

  // Keep the strongest overall options plus the best few at every position, so
  // a genuine need is never shortlisted out by raw value.
  const shortlisted = new Map<string, PlannablePlayer>();
  for (const entry of priorScored.slice(0, SHORTLIST_OVERALL)) {
    shortlisted.set(entry.candidate.playerId, entry.candidate);
  }
  const perPosition = new Map<Position, number>();
  for (const entry of priorScored) {
    const seen = perPosition.get(entry.candidate.position) ?? 0;
    if (seen >= SHORTLIST_PER_POSITION) continue;
    perPosition.set(entry.candidate.position, seen + 1);
    shortlisted.set(entry.candidate.playerId, entry.candidate);
  }

  /*
   * Always score the top of First Seed's board.
   *
   * The shortlist above is built from immediate roster gain, which can leave out
   * the very player the market rates highest - and an audit of real drafts found
   * exactly that: on six of fifteen picks the engine never even considered First
   * Seed's best available, so it could not have taken him however good he was.
   * Declining a consensus pick is a decision the engine is allowed to make; not
   * noticing him is not.
   */
  for (const candidate of [...plannable]
    .sort((a, b) => a.consensusRank - b.consensusRank)
    .slice(0, SHORTLIST_CONSENSUS)) {
    shortlisted.set(candidate.playerId, candidate);
  }

  /**
   * Bank what we are sure of, discount what we are guessing.
   *
   * `immediate` is the roster we hold the moment this pick is made - certain.
   * Everything beyond it is the plan's expectation, which is discounted because
   * it assumes both the room's behaviour and our own later choices.
   */
  const decisionValueOf = (immediate: number, planTotal: number) =>
    immediate + PLAN_FUTURE_DISCOUNT * (planTotal - immediate);

  /*
   * First Seed's board is the prior, so reaching past it costs something.
   *
   * Without this the engine drifted six to fifty ranks down the board on almost
   * every pick, each time convinced by its own simulation that it had gained a
   * dozen points - and finished hundreds of points behind simply taking the
   * best player available. The anchor makes a deviation prove itself.
   */
  /*
   * The anchor only exists when there is a real board to anchor to.
   *
   * Without a First Seed draft-room ranking, `consensusRank` falls back to our
   * own projection order - and in a one-quarterback league that order puts
   * quarterbacks on top, because they score the most raw points. Deferring to
   * that is not deferring to a consensus, it is deferring to precisely the
   * mistake this engine was built to stop making.
   */
  const rankedCandidates = plannable.filter((candidate) =>
    roomByPlayerId.has(candidate.playerId),
  );
  const hasPublishedBoard = rankedCandidates.length > 0;

  /*
   * How many bodies at a position could ever reach the lineup: every slot it can
   * occupy, plus one backup. Beyond that they are unusable whatever the board
   * says about them.
   */
  const heldAt = new Map<Position, number>();
  for (const player of rosterPlayers) {
    heldAt.set(player.position, (heldAt.get(player.position) ?? 0) + 1);
  }
  const surplusPenaltyFor = (candidate: PlannablePlayer) => {
    // Only a position with a single lineup spot can be stacked meaninglessly.
    // Running back and receiver depth is genuinely useful and is already
    // governed by declining bench value, so it is left alone.
    const footprint = startingFootprint(candidate.position, slots);
    if (footprint > 1.5) return 0;
    const capacity = 2; // the starter, plus one backup for byes and injuries
    const surplus = (heldAt.get(candidate.position) ?? 0) + 1 - capacity;
    return surplus > 0 ? SURPLUS_STACK_PENALTY * surplus : 0;
  };

  /*
   * What the board is measured from.
   *
   * Preferably First Seed's best available player who would improve our starting
   * lineup. Once the lineup is full nobody does, and the reference falls back to
   * the best-ranked player we could still USE - never to one we have already
   * stacked past what a roster can play. Anchoring to an unusable quarterback
   * gave him a zero reach and charged everyone else for not being him, which
   * walked the roster toward a third and a fourth.
   */
  /*
   * What the reach is measured from: First Seed's best available player the
   * roster could still use.
   *
   * A published board is a global ranking and cannot know we already have a
   * quarterback. Late in a one-quarterback league the highest-ranked player left
   * is often one we could never play, and letting him set the bar charged
   * everyone else for not being him - which walked the roster toward a third and
   * a fourth. Excluding positions we have already stacked past capacity is
   * enough; narrowing further, to players who improve the lineup TODAY, threw
   * the bar away entirely once the lineup was full and let the engine wander
   * twenty ranks down the board on bench picks that were all worth the same.
   */
  const anchorApplies = hasPublishedBoard;
  const notSurplus = (candidate: PlannablePlayer) => surplusPenaltyFor(candidate) === 0;
  const withoutSurplus = rankedCandidates.filter(notSurplus);
  const anchorPool = withoutSurplus.length > 0 ? withoutSurplus : rankedCandidates;
  const bestConsensusRank = anchorApplies
    ? Math.min(...anchorPool.map((candidate) => candidate.consensusRank))
    : Number.NaN;
  // Not appearing on First Seed's board at all is itself information, so an
  // unranked player is treated as sitting just past its end.
  const unrankedGap = roomByPlayerId.size + 1;
  const anchorPenaltyFor = (candidate: PlannablePlayer) => {
    if (!anchorApplies) return 0;
    const gap = roomByPlayerId.has(candidate.playerId)
      ? candidate.consensusRank - bestConsensusRank
      : unrankedGap;
    return consensusAnchorPenalty(gap);
  };

  const planned = [...shortlisted.values()].map((candidate) => {
    const immediate = evaluateRoster([...rosterPlayers, candidate], slots).total;
    const plan = planRemainingRoster(basePlanInput, candidate);
    return {
      candidate,
      plan,
      immediate,
      decisionValue:
        decisionValueOf(immediate, plan.total) -
        anchorPenaltyFor(candidate) -
        surplusPenaltyFor(candidate),
    };
  });
  planned.sort(
    (a, b) =>
      b.decisionValue - a.decisionValue ||
      b.immediate - a.immediate ||
      a.candidate.consensusRank - b.candidate.consensusRank,
  );
  const bestPlanValue = planned[0]?.decisionValue ?? 0;
  const referenceLoss = Math.max(
    DRAFT_SCORE_SHAPE.minimumReferenceLoss,
    Math.abs(bestPlanValue) * DRAFT_SCORE_SHAPE.referenceLossShare,
  );

  /* ------------------------------------ availability and the wait comparison */

  const probabilityFor = (candidate: PlannablePlayer): { value: number | null; confidence: Confidence; teamsWithNeed: number; demand: number } => {
    const nextUserPick = context.draftState.value.nextUserPick;
    const { demand, teamsWithNeed } = opponentDemandForPosition({
      position: candidate.position,
      interveningTeams,
      slots,
      runs: roomBehavior.runs,
    });
    if (nextUserPick === null) {
      return { value: null, confidence: 'low', teamsWithNeed, demand };
    }
    // Back-to-back selections at the turn: nobody picks in between, so everyone
    // on the board is available, exactly and with certainty. Estimating this is
    // both unnecessary and misleading.
    if (interveningTeams.length === 0) {
      return { value: 100, confidence: 'high', teamsWithNeed, demand };
    }
    const source = projectionByPlayerId.get(candidate.playerId);
    const room = roomByPlayerId.get(candidate.playerId);
    const confidence: Confidence = room
      ? roomRankings?.compatibility.level === 'weak'
        ? 'medium'
        : 'high'
      : 'low';
    const raw = probabilityAvailableAtNextPick({
      adp: candidate.consensusRank,
      currentOverallPick: board.currentOverallPick,
      nextUserPick,
      interveningDemand: demand,
      position: candidate.position,
    });
    // An estimate we do not trust must not be acted on as though we did. With no
    // compatible draft-room rank the ordering is our own projection order, which
    // says little about when the ROOM will take him, so the estimate is pulled
    // toward even odds rather than being reported as a confident 3% or 97%.
    const reliability = confidenceWeight(confidence);
    const value = round(clamp(50 + (raw - 50) * reliability, 0, 100), 1);
    void source;
    return { value, confidence, teamsWithNeed, demand };
  };

  /**
   * Take him now, or take somebody else and hope he comes back?
   *
   * Both branches are played out the same way, which is what the old rule got
   * wrong. It fired DRAFT NOW on a thin tier or a high score without ever
   * asking whether waiting would actually cost anything, so a player with a 97%
   * chance of still being there was still marked urgent.
   *
   * Here each option is completed into a full roster:
   *
   *   take now  - we take him, and the alternative either survives to our next
   *               pick or does not, weighted by how likely that is.
   *   wait      - we take the alternative, and HE either survives or does not.
   *
   * A player certain to come back makes the wait branch strictly better, because
   * that branch ends up with both players. That is the behaviour we want, and it
   * now falls out of the arithmetic instead of a threshold.
   */
  const pinned = (pool: PlannablePlayer[], playerId: string) =>
    pool.map((item) =>
      item.playerId === playerId ? { ...item, consensusRank: Number.MAX_SAFE_INTEGER } : item,
    );
  const without = (pool: PlannablePlayer[], playerId: string) =>
    pool.filter((item) => item.playerId !== playerId);

  const branchValue = (
    take: PlannablePlayer,
    other: PlannablePlayer,
    otherSurvivalProbability: number,
  ): number => {
    const p = clamp(otherSurvivalProbability, 0, 100) / 100;
    const immediate = evaluateRoster([...rosterPlayers, take], slots).total;
    const anchor = anchorPenaltyFor(take) + surplusPenaltyFor(take);
    const survives = planRemainingRoster(
      { ...basePlanInput, available: pinned(plannable, other.playerId) },
      take,
    ).total;
    const gone = planRemainingRoster(
      { ...basePlanInput, available: without(plannable, other.playerId) },
      take,
    ).total;
    // Same yardstick as the ranking, so urgency and order cannot disagree.
    return (
      p * decisionValueOf(immediate, survives) +
      (1 - p) * decisionValueOf(immediate, gone) -
      anchor
    );
  };

  const probabilityCache = new Map<string, ReturnType<typeof probabilityFor>>();
  const probabilityOf = (candidate: PlannablePlayer) => {
    const cached = probabilityCache.get(candidate.playerId);
    if (cached) return cached;
    const computed = probabilityFor(candidate);
    probabilityCache.set(candidate.playerId, computed);
    return computed;
  };

  const contenders = planned.slice(0, WAIT_ANALYSIS_DEPTH);
  const decisions = new Map<
    string,
    { takeNow: number; wait: number; edge: number; exceptional: string | null }
  >();
  for (const entry of contenders) {
    const alternative = contenders.find(
      (candidate) => candidate.candidate.playerId !== entry.candidate.playerId,
    );
    if (!alternative || context.draftState.value.nextUserPick === null) continue;
    const mine = probabilityOf(entry.candidate).value ?? 50;
    const theirs = probabilityOf(alternative.candidate).value ?? 50;
    const takeNow = branchValue(entry.candidate, alternative.candidate, theirs);
    const wait = branchValue(alternative.candidate, entry.candidate, mine);
    const edge = round(takeNow - wait, 1);
    decisions.set(entry.candidate.playerId, {
      takeNow,
      wait,
      edge,
      exceptional:
        edge > DRAFT_NOW_THRESHOLD && mine >= 90
          ? 'Taking him now still wins even though he is likely to come back, because no alternative on the board improves the expected final roster.'
          : null,
    });
  }

  /*
   * Rank by that edge, not by raw plan value.
   *
   * The edge already contains everything the ordering needs: how good the final
   * roster is if we take him, minus how good it is if we take the alternative
   * and he comes back. A player who is certain to survive scores badly here even
   * when his own plan looks strong, because we can simply have him later. That
   * is what makes the headline pick the pick to actually MAKE, rather than the
   * best name on the board.
   */
  if (decisions.size > 0) {
    const ranked = [...contenders].sort(
      (a, b) =>
        (decisions.get(b.candidate.playerId)?.edge ?? -Infinity) -
          (decisions.get(a.candidate.playerId)?.edge ?? -Infinity) ||
        b.decisionValue - a.decisionValue ||
        a.candidate.consensusRank - b.candidate.consensusRank,
    );
    planned.splice(0, contenders.length, ...ranked);
  }

  /*
   * The simulation is the arbiter; heuristics only break ties.
   *
   * A starter need, a tier cliff or a thin position are reasons to prefer a
   * player when the completed-roster simulation is close. They are not reasons
   * to override it. The audit kept finding picks where the engine reached past
   * First Seed's board for a named heuristic while its OWN final-roster
   * evaluation said the player it passed produced the better team - a tight end
   * taken over a running back at minus six points of final roster, a backup
   * quarterback at minus a third of a point.
   *
   * So a candidate who is beaten on BOTH counts - First Seed ranks the other
   * player higher, and our own simulation finishes with a better roster from him
   * - is dominated, and cannot be recommended above him. Nothing else about him
   * matters, because there is no axis on which he is the better choice.
   *
   * The tolerance keeps genuine ties out of it: the plan is a greedy completion
   * and wobbles by a point or two for reasons that have nothing to do with the
   * pick, and inside that band the heuristics are exactly what should decide.
   */
  const dominated = new Set<string>();
  for (const entry of planned) {
    const ownRank = roomByPlayerId.get(entry.candidate.playerId)?.rank;
    if (ownRank === undefined) continue;
    for (const other of planned) {
      if (other === entry) continue;
      const otherRank = roomByPlayerId.get(other.candidate.playerId)?.rank;
      if (otherRank === undefined || otherRank >= ownRank) continue;
      if (other.plan.total > entry.plan.total + DOMINANCE_PLAN_TOLERANCE) {
        dominated.add(entry.candidate.playerId);
        break;
      }
    }
  }
  if (dominated.size > 0 && dominated.size < planned.length) {
    // A stable partition, so the established order survives within each group.
    const clear = planned.filter((entry) => !dominated.has(entry.candidate.playerId));
    const beaten = planned.filter((entry) => dominated.has(entry.candidate.playerId));
    planned.splice(0, planned.length, ...clear, ...beaten);
  }

  // Absolute anchor for the 0-100 score: how much the best pick available can
  // actually improve the starting lineup. Late in a draft nothing does, and the
  // headline number should say so rather than reading 100 every round.
  const bestMarginalStartingValue = Math.max(
    0,
    ...planned.map(
      (entry) =>
        evaluateRoster([...rosterPlayers, entry.candidate], slots).startingValue -
        currentRosterValue.startingValue,
    ),
  );
  const topProjection = Math.max(1, ...plannable.map((item) => item.projection));
  const situationQuality =
    0.55 + 0.45 * clamp(bestMarginalStartingValue / topProjection, 0, 1);

  /* -------------------------------------------------- assemble recommendations */

  const saturationScore: Record<string, number> = {
    none: 0,
    low: 25,
    medium: 55,
    high: 80,
    complete: 100,
  };

  const recommendations: DraftRecommendation[] = planned.map((entry, index) => {
    const { candidate, plan } = entry;
    const projection = projectionByPlayerId.get(candidate.playerId)!;
    const source = valuedById.get(candidate.playerId)?.source ?? projection;
    const scoring = valuedById.get(candidate.playerId)?.scoring;
    const player = players.byId.get(candidate.playerId)!;
    const positionState = rosterState.byPosition[candidate.position];
    const tierInfo = tiers.get(candidate.playerId) ?? { tier: 1, tierSize: 1, gapAfterTier: 0 };
    const positionPool = availableByPosition.get(candidate.position) ?? [];
    const playersRemainingInTier = positionPool.filter(
      (item) => tiers.get(item.scored.playerId)?.tier === tierInfo.tier,
    ).length;

    const withHim = evaluateRoster([...rosterPlayers, candidate], slots);
    const marginalStartingValue = round(
      withHim.startingValue - currentRosterValue.startingValue,
      1,
    );
    const depthValue = round(withHim.benchValue - currentRosterValue.benchValue, 1);

    const { value: probability, confidence, teamsWithNeed } = probabilityOf(candidate);
    const decision = decisions.get(candidate.playerId);
    const opportunityCost = decision?.edge ?? round(entry.decisionValue - bestPlanValue, 1);
    const backToBack = context.draftState.value.picksBeforeNextSelection === 0;
    const exceptional =
      decision?.exceptional ??
      (index === 0 && backToBack
        ? 'You pick again immediately, so both of your targets should still be there. This is simply the better one to take first.'
        : index === 0 && probability !== null && probability >= 90
          ? 'He is likely to come back, but nothing else on the board improves the expected final roster more, so he is still the pick.'
          : null);

    const planDelta = round(entry.decisionValue - bestPlanValue, 1);
    const score = round(
      clamp(100 - (Math.abs(planDelta) / referenceLoss) * 100, 0, 100) * situationQuality,
      1,
    );

    const tierUrgency = round(
      clamp(
        (playersRemainingInTier <= 1
          ? 100
          : playersRemainingInTier === 2
            ? 78
            : playersRemainingInTier === 3
              ? 54
              : playersRemainingInTier <= 5
                ? 32
                : 14) *
          0.6 +
          (tierInfo.gapAfterTier > 0 ? Math.min(100, tierInfo.gapAfterTier * 2.5) : 0) * 0.4,
      ),
      1,
    );

    /*
     * The headline pick is, by construction, the one to make now, so it never
     * tells you to wait on itself. Every other candidate is flagged only when
     * taking HIM now would also beat waiting - which a player who is coming back
     * never does, however good he is. That is the contradiction this replaces:
     * a 97%-available quarterback marked DRAFT NOW.
     */
    const action: RecommendationAction =
      index === 0
        ? 'DRAFT_NOW'
        : (decision?.edge ?? -Infinity) > DRAFT_NOW_THRESHOLD
          ? 'DRAFT_NOW'
          : 'WAIT';

    const replacementProjection = replacements.get(candidate.position) ?? candidate.projection;
    const marketAdp = Number.isFinite(source.adp) ? source.adp! : null;

    const insight: RecommendationInsight = {
      positionCount: positionState?.drafted ?? 0,
      startersRequired: positionState?.startersRequired ?? 0,
      startersFilled: positionState?.startersFilled ?? 0,
      openStartingSlots: positionState?.openStartingSlots ?? 0,
      depthNeed: positionState?.depthNeed ?? 'none',
      saturation: positionState?.saturation ?? 'none',
      starterQuality: positionState?.starterQuality ?? 'none',
      build: rosterState.build,
      strategicPriority: rosterState.strategicPriority,
      possiblePivots: rosterState.possiblePivots,
      expectedFinalRosterValue: plan.total,
      expectedStartingValue: plan.startingValue,
      expectedBenchValue: plan.benchValue,
      expectedUnfilledSlots: plan.unfilledSlots,
      roomTendency: roomBehavior.tendency,
      positionRunActive: roomBehavior.runs[candidate.position]?.isRun ?? false,
      opponentTeamsNeedingPosition: teamsWithNeed,
      exceptionalReason: exceptional,
      juanchoBoardRank: index + 1,
      bestAvailableFirstSeedRank: Number.isFinite(bestConsensusRank)
        ? Math.round(bestConsensusRank)
        : null,
      firstSeedRankGap:
        roomByPlayerId.get(candidate.playerId) && Number.isFinite(bestConsensusRank)
          ? Math.round(candidate.consensusRank - bestConsensusRank)
          : null,
    };

    const components: DraftScoreComponents = {
      planValue: plan.total,
      planDelta,
      marginalStartingValue,
      depthValue,
      opportunityCost,
      nextPickRisk: probability === null ? 50 : round(100 - probability, 1),
      tierUrgency,
      positionalSaturation: saturationScore[positionState?.saturation ?? 'none'] ?? 0,
    };

    return {
      player,
      projection,
      score,
      juanchoRank: leagueRankByPlayer.get(candidate.playerId) ?? projection.rank ?? 0,
      marketAdp,
      draftRoomRank: roomByPlayerId.get(candidate.playerId)?.rank ?? null,
      externalExpertRank: roomByPlayerId.get(candidate.playerId)?.upstreamExpertRank ?? null,
      firstSeedValueDelta: roomByPlayerId.get(candidate.playerId)?.firstSeedValueDelta ?? null,
      marketEdge: null,
      action,
      availableNextPickProbability: probability,
      nextPickConfidence: confidence,
      nextUserPick: context.draftState.value.nextUserPick,
      picksUntilNextUserPick: context.draftState.value.picksBeforeNextSelection,
      tier: tierInfo.tier,
      playersRemainingInTier,
      components,
      insight,
      raw: {
        projectedPoints: candidate.projection,
        sourceProjectedPoints: source.projection,
        vorp: round(candidate.projection - replacementProjection, 1),
        scarcityGap: round(marginalStartingValue, 1),
        adpDelta: marketAdp === null ? null : round(board.currentOverallPick - marketAdp, 1),
        replacementProjection: round(replacementProjection, 1),
        replacementDemand: calculateReplacementDemand(candidate.position, context),
        rosterNeed: components.positionalSaturation,
        scoringAdjusted: scoring?.adjustedForLeagueScoring ?? false,
        interveningTeamsWithNeed: teamsWithNeed,
        interveningDemand: round(probabilityOf(candidate).demand, 1),
      },
      nextPickExplanation: {
        picksBeforeNextSelection: context.draftState.value.picksBeforeNextSelection,
        interveningTeamsWithNeed: teamsWithNeed,
        playerAdp: marketAdp,
        draftRoomRank: roomByPlayerId.get(candidate.playerId)?.rank ?? null,
        currentSelection: board.currentOverallPick,
        adpSource: roomByPlayerId.get(candidate.playerId)
          ? 'First Seed Sleeper draft-room rank'
          : 'Juancho-Fico projection rank',
        adpMatchLevel: roomByPlayerId.get(candidate.playerId) ? 'exact' : 'approximate',
        adpMatchReasons: roomByPlayerId.get(candidate.playerId)
          ? ['Availability is estimated from the Sleeper draft-room rank for this format.']
          : ['No draft-room rank matched this player; availability falls back to projection order.'],
      },
      reasons: buildStrategicReasons({
        player,
        components,
        insight,
        probability,
        playersRemainingInTier,
        rosterState,
      }),
    };
  });

  const withMarketEdge = recommendations.map((recommendation) => ({
    ...recommendation,
    marketEdge:
      recommendation.marketAdp === null
        ? null
        : Math.round((recommendation.marketAdp - recommendation.juanchoRank) * 10) / 10,
  }));

  return {
    recommendations: withMarketEdge,
    status,
    messages: [...new Set(messages)],
    scoringCoverage: coverage,
    context,
    nextUserPick: context.draftState.value.nextUserPick,
    picksUntilNextUserPick: context.draftState.value.picksBeforeNextSelection,
    userDraftSlot: context.draftState.value.userDraftSlot,
    userRosterId: context.draftState.value.userRosterId,
  };
}
