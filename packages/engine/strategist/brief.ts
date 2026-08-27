/**
 * The whole draft, as one serializable object.
 *
 * This is the input to the AI Strategist. It is assembled almost entirely from
 * state the deterministic engine already computed and then discarded, so the
 * two layers are guaranteed to be reasoning about the same board rather than
 * two independent readings of it.
 *
 * The one rule that governs what goes in: never hide the correct player. A
 * candidate pool trimmed for token cost can only be wrong in one direction, so
 * the pool is a UNION of several selection rules - the top of the board, the
 * top of every position, whole tiers, and everyone Juancho itself considered -
 * and each candidate records why it is here. Cost can be optimised later; a
 * strategist that never saw the right name cannot be.
 */
import type { CanonicalPlayerMap, Position } from '../../players/types';
import type { LeagueRosterView, SleeperDraftPick, SleeperRoster } from '../../sleeper/types';
import type { LeagueContext } from '../context/types';
import type { DraftDecisionInternals } from '../draft/internals';
import { resolvePickRosterId } from '../draft/pick-ownership';
import { startingFootprint } from '../draft/roster-state';
import { solveBestLineup, type LineupSlots } from '../draft/lineup';
import type { DraftBoardState, DraftRecommendationResult } from '../draft/types';
import {
  buildCandidates,
  DEFAULT_CANDIDATE_POOL,
  type CandidatePoolOptions,
} from './candidates';
import { buildJointAvailability } from './joint';
import { buildDraftStateVersion } from './state-version';
import { buildTeamModels } from './teams';
import {
  DRAFT_BRIEF_VERSION,
  type BriefCandidate,
  type BriefConstraints,
  type BriefDeterministicView,
  type BriefRecentPick,
  type BriefRoomState,
  type BriefTierCliff,
  type DraftBrief,
} from './types';

export { DEFAULT_CANDIDATE_POOL };
export type { CandidatePoolOptions };

/** Selections carried in the room's recent history. */
const DEFAULT_RECENT_PICK_WINDOW = 15;
/** How far down Juancho's own board the brief reports. */
const DEFAULT_DETERMINISTIC_DEPTH = 10;

const CORE_POSITIONS: Position[] = ['QB', 'RB', 'WR', 'TE'];
const ALL_POSITIONS: Position[] = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF'];

/**
 * Bodies at a position that could ever reach a lineup.
 *
 * Only meaningful where the position has a single starting spot: a third
 * quarterback in a one-quarterback league can never play, while a fifth
 * receiver is ordinary depth. Positions with real flex access are deliberately
 * uncapped - their declining value is already handled by bench scoring, and a
 * cap there would forbid a legitimate pick.
 */
const SINGLE_SLOT_FOOTPRINT = 1.5;
const SINGLE_SLOT_CAPACITY = 2;

export interface BuildDraftBriefInput {
  context: LeagueContext;
  board: DraftBoardState;
  picks: SleeperDraftPick[];
  rosters: SleeperRoster[];
  players: CanonicalPlayerMap;
  result: DraftRecommendationResult;
  draftId: string;
  /** Owner names, when the draft is a league rather than a mock. */
  rosterViews?: LeagueRosterView[] | null;
  /**
   * Whether this is a Sleeper mock draft.
   *
   * Passed in rather than inferred: the absence of owner names looks identical
   * to a league draft whose users were never fetched, and a brief that guesses
   * would tell the strategist the room is anonymous when it is not.
   */
  isMock?: boolean;
  candidatePool?: Partial<CandidatePoolOptions>;
  recentPickWindow?: number;
  deterministicDepth?: number;
}

/**
 * Assembles the brief, or returns null when there is nothing to reason about.
 *
 * Null whenever the engine could not produce recommendations - an unsupported
 * draft, missing projections, a board with no available players. There is no
 * degraded brief: a strategist given a half-built picture would answer anyway.
 */
export function buildDraftBrief(input: BuildDraftBriefInput): DraftBrief | null {
  const { context, board, result, players } = input;
  const internals = result.internals;
  if (!internals) return null;

  const draftState = context.draftState.value;
  const slots = internals.slots;
  const teams = context.teams.value;
  const rounds = draftState.rounds;
  const ourRosterId = draftState.userRosterId;
  const poolOptions = { ...DEFAULT_CANDIDATE_POOL, ...(input.candidatePool ?? {}) };

  const orderedPicks = [...input.picks].sort((a, b) => a.pick_no - b.pick_no);
  const state = buildDraftStateVersion({
    draftId: input.draftId,
    board,
    orderedSleeperIds: orderedPicks.map((pick) => pick.player_id),
    onTheClockRosterId: draftState.currentSelection?.ownerRosterId ?? null,
    ourRosterId,
  });

  const nameByRosterId = new Map(
    (input.rosterViews ?? []).map((view) => [view.roster.roster_id, view.teamName]),
  );
  const allTeams = buildTeamModels({
    context,
    picks: input.picks,
    rosters: input.rosters,
    players,
    internals,
    slots,
    currentOverallPick: board.currentOverallPick,
    teams,
    rounds,
    ourRosterId,
    nextOurPick: draftState.nextUserPick,
  }).map((team) => ({ ...team, teamName: nameByRosterId.get(team.rosterId) ?? null }));

  const ourTeam = allTeams.find((team) => team.isUs) ?? null;
  if (!ourTeam) return null;
  const opponents = allTeams.filter((team) => !team.isUs);

  const candidates = buildCandidates({ internals, players, result, options: poolOptions });
  const room = buildRoomState({
    internals,
    players,
    orderedPicks,
    opponents,
    candidates,
    window: input.recentPickWindow ?? DEFAULT_RECENT_PICK_WINDOW,
  });

  const qbFormat: '1qb' | 'superflex' =
    slots.SUPER_FLEX > 0 || slots.QB >= 2 ? 'superflex' : '1qb';

  return {
    briefVersion: DRAFT_BRIEF_VERSION,
    state,
    league: {
      teams,
      rounds,
      leagueType: context.leagueType.value,
      draftType: context.draftType.value,
      lineupType: context.lineupType.value,
      scoringProfile: context.scoring.value.profile,
      qbFormat,
      slots,
      benchSlots: context.roster.value.bench,
      scoring: {
        receptionsBase: context.scoring.value.reception.base,
        receptionsByPosition: { ...context.scoring.value.reception.byPosition },
        passingTouchdowns: context.scoring.value.passing.touchdowns,
        tePremium: context.scoring.value.tePremium,
      },
      isMock: input.isMock ?? false,
    },
    draft: {
      currentOverallPick: board.currentOverallPick,
      currentRound: board.currentRound,
      pickInRound: board.pickInRound,
      ourDraftSlot: draftState.userDraftSlot,
      ourRosterId,
      isOurSelection: state.isOurSelection,
      nextOurPick: draftState.nextUserPick,
      picksUntilOurNextSelection: draftState.picksBeforeNextSelection,
      ourRemainingSelections: internals.ourFuturePicks,
      picksRemaining: internals.ourFuturePicks.length,
    },
    ourTeam,
    opponents,
    room,
    candidates,
    jointAvailability: buildJointAvailability({
      internals,
      candidates,
      recommendedPlayerId: result.recommendations[0]?.player.id ?? null,
      firstSeedBestPlayerId: internals.bestAvailableConsensusPlayerId,
      rankedTop: result.recommendations.map((recommendation) => recommendation.player.id),
      // Only positions we could still start somebody at: a tier breaking at a
      // position we have saturated is not a decision.
      openPositions: ourTeam.needs
        .filter((need) => need.openStartingSlots > 0 || need.depthNeed !== 'none')
        .map((need) => need.position),
      interveningSelections: draftState.interveningSelections.length,
    }),
    deterministic: buildDeterministicView(
      result,
      internals,
      input.deterministicDepth ?? DEFAULT_DETERMINISTIC_DEPTH,
    ),
    constraints: buildConstraints({ internals, slots, rounds }),
    strategyContext: null,
    playerNews: null,
  };
}

/* -------------------------------------------------------------- the room */

function buildRoomState({
  internals,
  players,
  orderedPicks,
  opponents,
  candidates,
  window,
}: {
  internals: DraftDecisionInternals;
  players: CanonicalPlayerMap;
  orderedPicks: SleeperDraftPick[];
  opponents: BriefTeamLike[];
  candidates: BriefCandidate[];
  window: number;
}): BriefRoomState {
  const recent = orderedPicks.slice(-Math.max(0, window));
  const teamNameByRosterId = new Map(opponents.map((team) => [team.rosterId, team.teamName]));

  const recentPicks: BriefRecentPick[] = recent.map((pick) => {
    const player = players.bySleeperId.get(pick.player_id);
    const firstSeedRank = player ? internals.firstSeedOf(player.id)?.rank ?? null : null;
    // The same resolver the engine uses, because a mock reports no roster id on
    // its picks and reading the field directly attributes nobody's picks to
    // anybody - which is how this project got a nine-quarterback draft.
    const rosterId = resolvePickRosterId(pick, internals.slotToRosterId);
    return {
      overallPick: pick.pick_no,
      round: pick.round,
      rosterId,
      draftSlot: pick.draft_slot ?? null,
      teamName: rosterId === null ? null : teamNameByRosterId.get(rosterId) ?? null,
      playerId: player?.id ?? null,
      sleeperId: pick.player_id,
      name: player?.name ?? pick.player_id,
      position: player?.position ?? null,
      firstSeedRank,
      // How far past the board this selection reached.
      firstSeedRankGap: firstSeedRank === null ? null : Math.round(firstSeedRank - pick.pick_no),
    };
  });

  const recentPositionCounts: Record<string, number> = {};
  for (const position of ALL_POSITIONS) {
    recentPositionCounts[position] = recentPicks.filter(
      (pick) => pick.position === position,
    ).length;
  }

  return {
    totalDrafted: orderedPicks.length,
    recentPicks,
    recentPositionCounts,
    positionalRuns: CORE_POSITIONS.map((position) => internals.roomBehavior.runs[position]).filter(
      Boolean,
    ),
    tendency: internals.roomBehavior.tendency,
    positionShare: internals.roomBehavior.positionShare,
    tierCliffs: buildTierCliffs(internals, candidates),
    teamsBeforeOurNextPick: opponents
      .filter((team) => team.selectionsBeforeOurNextPick.length > 0)
      .map((team) => ({
        rosterId: team.rosterId,
        teamName: team.teamName,
        selections: team.selectionsBeforeOurNextPick,
        needs: team.needs,
      })),
    allDraftedPlayerIds: orderedPicks
      .map((pick) => players.bySleeperId.get(pick.player_id)?.id)
      .filter((playerId): playerId is string => Boolean(playerId)),
  };
}

/**
 * Where each position's board is about to fall away.
 *
 * A tier is at risk when there are no more players in it than there are teams
 * ahead of us that need the position - the same demand figure the survival
 * estimate uses, so urgency here and urgency there cannot disagree.
 */
function buildTierCliffs(
  internals: DraftDecisionInternals,
  candidates: BriefCandidate[],
): BriefTierCliff[] {
  const cliffs: BriefTierCliff[] = [];
  for (const position of ALL_POSITIONS) {
    const atPosition = candidates
      .filter((candidate) => candidate.position === position)
      .sort((a, b) => b.juancho.projectedPoints - a.juancho.projectedPoints);
    const best = atPosition[0];
    if (!best || best.juancho.tier === null) continue;
    const remaining = best.juancho.playersRemainingInTier ?? 0;
    cliffs.push({
      position,
      tier: best.juancho.tier,
      playersRemainingInTier: remaining,
      gapAfterTier: internals.tierOf(best.playerId)?.gapAfterTier ?? 0,
      bestRemaining: {
        playerId: best.playerId,
        name: best.name,
        projectedPoints: best.juancho.projectedPoints,
      },
      atRisk: remaining > 0 && remaining <= best.survival.interveningTeamsWithNeed,
    });
  }
  return cliffs;
}

/* ------------------------------------------------- Juancho's own conclusion */

function buildDeterministicView(
  result: DraftRecommendationResult,
  internals: DraftDecisionInternals,
  depth: number,
): BriefDeterministicView {
  const top = result.recommendations.slice(0, Math.max(0, depth));
  const headline = top[0] ?? null;
  const bestId = internals.bestAvailableConsensusPlayerId;
  const bestPlayer = bestId === null ? null : internals.playerOf(bestId);

  return {
    status: result.status,
    messages: result.messages,
    scoringCoverage: result.scoringCoverage,
    recommended: headline
      ? {
          playerId: headline.player.id,
          name: headline.player.name,
          position: headline.player.position,
          score: headline.score,
          action: headline.action,
        }
      : null,
    top: top.map((recommendation, index) => ({
      rank: index + 1,
      playerId: recommendation.player.id,
      name: recommendation.player.name,
      position: recommendation.player.position,
      score: recommendation.score,
      planValue: round1(recommendation.components.planValue),
      decisionValueDelta: round1(recommendation.components.planDelta),
    })),
    bestAvailableFirstSeed:
      bestPlayer && internals.bestAvailableConsensusRank !== null
        ? {
            playerId: bestPlayer.id,
            name: bestPlayer.name,
            position: bestPlayer.position,
            rank: internals.bestAvailableConsensusRank,
          }
        : null,
  };
}

/* ------------------------------------------------------------- the rules */

function buildConstraints({
  internals,
  slots,
  rounds,
}: {
  internals: DraftDecisionInternals;
  slots: LineupSlots;
  rounds: number;
}): BriefConstraints {
  const held = new Map<Position, number>();
  for (const player of internals.ourRosterPlayers) {
    held.set(player.position, (held.get(player.position) ?? 0) + 1);
  }

  const usableCapacity: Partial<Record<Position, number>> = {};
  const blockedPositions: { position: Position; reason: string }[] = [];
  for (const position of ALL_POSITIONS) {
    if (startingFootprint(position, slots) > SINGLE_SLOT_FOOTPRINT) continue;
    usableCapacity[position] = SINGLE_SLOT_CAPACITY;
    if ((held.get(position) ?? 0) >= SINGLE_SLOT_CAPACITY) {
      blockedPositions.push({
        position,
        reason: `Already holding ${held.get(position)} at a position with one starting spot; another could never reach the lineup.`,
      });
    }
  }
  if (!internals.kickersAndDefensesAllowed) {
    for (const position of ['K', 'DEF'] as Position[]) {
      if (slots[position as 'K' | 'DEF'] > 0) {
        blockedPositions.push({
          position,
          reason: `Kickers and defenses are only selected in the final rounds of a ${rounds}-round draft.`,
        });
      }
    }
  }

  // Only DEDICATED starting slots make a lineup illegal when empty. An empty
  // flex is a quality problem and is visible in `ourTeam.lineupHoles`.
  const lineup = solveBestLineup(internals.ourRosterPlayers, slots);
  const mustFill = lineup.unfilled
    .filter((hole) => (ALL_POSITIONS as string[]).includes(hole.slot))
    .map((hole) => ({ position: hole.slot as Position, count: hole.count }));

  return {
    slots,
    rosterSpotsRemaining: internals.ourFuturePicks.length,
    usableCapacity,
    blockedPositions,
    mustFillBeforeDraftEnds: mustFill,
    kickersAndDefensesAllowed: internals.kickersAndDefensesAllowed,
  };
}

interface BriefTeamLike {
  rosterId: number;
  teamName: string | null;
  selectionsBeforeOurNextPick: number[];
  needs: BriefRoomState['teamsBeforeOurNextPick'][number]['needs'];
}

const round1 = (value: number) => Math.round(value * 10) / 10;
