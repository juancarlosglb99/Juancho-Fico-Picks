/**
 * Every team in the room, described team by team.
 *
 * The engine already knew how many players each opponent held at each position,
 * and used it for one thing: estimating whether a quarterback survives a
 * stretch of teams that all already have one. That is a real improvement over
 * generic demand, but it is still a histogram - it cannot tell you that the
 * team picking twice before us has an empty flex, a tight end hole and has
 * taken a receiver with four of its last five selections.
 *
 * So each roster is put through exactly the same description our own goes
 * through: the same lineup solver, the same needs, the same build classifier.
 * "What does this opponent need" and "what do we need" are then answered on
 * identical terms, rather than by two classifiers that quietly disagree.
 */
import type { CanonicalPlayerMap, Position } from '../../players/types';
import type { SleeperDraftPick, SleeperRoster } from '../../sleeper/types';
import type { LeagueContext } from '../context/types';
import { solveBestLineup, type LineupPlayer, type LineupSlots } from '../draft/lineup';
import { listUserSelections } from '../draft/next-pick-probability';
import { resolvePickRosterId } from '../draft/pick-ownership';
import {
  buildRosterConstructionState,
  type PositionState,
  type RosterConstructionState,
} from '../draft/roster-state';
import type { DraftDecisionInternals } from '../draft/internals';
import type {
  BriefLineupSlotState,
  BriefPositionNeed,
  BriefRosterPlayer,
  BriefTeam,
  BriefTeamTendency,
} from './types';

/**
 * How far past the board a selection has to be before it counts as a reach.
 *
 * Twelve ranks is roughly a round in a twelve-team league, which is the point
 * at which "they liked him" stops explaining it and "they needed the position"
 * starts to.
 */
const REACH_RANK_GAP = 12;

const DESCRIBED_POSITIONS: Position[] = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF'];

export interface TeamModelInput {
  context: LeagueContext;
  picks: SleeperDraftPick[];
  rosters: SleeperRoster[];
  players: CanonicalPlayerMap;
  internals: DraftDecisionInternals;
  slots: LineupSlots;
  currentOverallPick: number;
  teams: number;
  rounds: number;
  ourRosterId: number | null;
  nextOurPick: number | null;
}

/** Every roster in the league, ours included and flagged as such. */
export function buildTeamModels(input: TeamModelInput): BriefTeam[] {
  const { rosters, ourRosterId } = input;
  const slotByRosterId = new Map<number, number>();
  for (const [slot, rosterId] of Object.entries(input.internals.slotToRosterId)) {
    if (!slotByRosterId.has(rosterId)) slotByRosterId.set(rosterId, Number(slot));
  }

  const picksByRosterId = new Map<number, SleeperDraftPick[]>();
  for (const pick of [...input.picks].sort((a, b) => a.pick_no - b.pick_no)) {
    const rosterId = resolvePickRosterId(pick, input.internals.slotToRosterId);
    if (rosterId === null) continue;
    picksByRosterId.set(rosterId, [...(picksByRosterId.get(rosterId) ?? []), pick]);
  }

  return rosters
    .map((roster) =>
      buildTeamModel({
        input,
        roster,
        draftSlot: slotByRosterId.get(roster.roster_id) ?? null,
        rosterPicks: picksByRosterId.get(roster.roster_id) ?? [],
        isUs: ourRosterId !== null && roster.roster_id === ourRosterId,
      }),
    )
    .sort((a, b) => a.rosterId - b.rosterId);
}

function buildTeamModel({
  input,
  roster,
  draftSlot,
  rosterPicks,
  isUs,
}: {
  input: TeamModelInput;
  roster: SleeperRoster;
  draftSlot: number | null;
  rosterPicks: SleeperDraftPick[];
  isUs: boolean;
}): BriefTeam {
  const { internals, players, slots, context } = input;

  /*
   * Drafted picks and a pre-existing roster are both sources of ownership, and
   * in a mock only the first exists. Collecting into a set keeps a keeper who
   * appears in both from being counted twice.
   */
  const ownedSleeperIds = new Set<string>(rosterPicks.map((pick) => pick.player_id));
  for (const sleeperId of roster.players ?? []) ownedSleeperIds.add(sleeperId);

  const pickBySleeperId = new Map(rosterPicks.map((pick) => [pick.player_id, pick]));
  const rosterPlayers: BriefRosterPlayer[] = [];
  const lineupPlayers: LineupPlayer[] = [];
  const selectionRounds: { position: Position; round: number }[] = [];

  for (const sleeperId of ownedSleeperIds) {
    const player = players.bySleeperId.get(sleeperId);
    if (!player) continue;
    const projection = internals.projectionOf(player.id)?.projection ?? 0;
    const pick = pickBySleeperId.get(sleeperId) ?? null;
    rosterPlayers.push({
      playerId: player.id,
      sleeperId,
      name: player.name,
      position: player.position,
      team: player.team,
      projectedPoints: round1(projection),
      overallPick: pick?.pick_no ?? null,
      round: pick?.round ?? null,
      firstSeedRank: internals.firstSeedOf(player.id)?.rank ?? null,
    });
    lineupPlayers.push({ playerId: player.id, position: player.position, projection });
    if (pick) selectionRounds.push({ position: player.position, round: pick.round });
  }
  rosterPlayers.sort(
    (a, b) => (a.overallPick ?? Infinity) - (b.overallPick ?? Infinity) || b.projectedPoints - a.projectedPoints,
  );

  const remainingSelections = listUserSelections(
    input.currentOverallPick,
    input.teams,
    input.rounds,
    context.draftType.value,
    draftSlot,
    {
      userRosterId: roster.roster_id,
      slotToRosterId: internals.slotToRosterId,
      tradedPicks: context.draftState.value.tradedPicks,
    },
  );

  /*
   * Our own state is reused rather than rebuilt.
   *
   * The engine already produced it from the same inputs, and rebuilding it here
   * would introduce a second answer to a question that already has one - which
   * is exactly the drift this module exists to avoid.
   */
  const state: RosterConstructionState = isUs
    ? internals.rosterState
    : buildRosterConstructionState({
        rosterPlayers: lineupPlayers,
        slots,
        teams: input.teams,
        picksRemaining: remainingSelections.length,
        positionalRank: (playerId) => internals.positionalRankOf(playerId) ?? null,
        selectionRounds,
      });

  const lineup = solveBestLineup(lineupPlayers, slots);
  const nameOf = (playerId: string) => players.byId.get(playerId)?.name ?? playerId;

  const startingLineup: BriefLineupSlotState[] = [
    ...lineup.assignments.map((assignment) => ({
      slot: assignment.slot as string,
      filledBy: {
        playerId: assignment.player.playerId,
        name: nameOf(assignment.player.playerId),
        position: assignment.player.position,
      },
    })),
    ...lineup.unfilled.flatMap((hole) =>
      Array.from({ length: hole.count }, () => ({ slot: hole.slot as string, filledBy: null })),
    ),
  ];

  const positionCounts: Partial<Record<Position, number>> = {};
  for (const player of rosterPlayers) {
    positionCounts[player.position] = (positionCounts[player.position] ?? 0) + 1;
  }

  const byPlayerId = new Map(rosterPlayers.map((player) => [player.playerId, player]));
  const orderedPicks = rosterPicks.map((pick) => {
    const player = players.bySleeperId.get(pick.player_id);
    return {
      overallPick: pick.pick_no,
      round: pick.round,
      position: (player?.position ?? 'UNKNOWN') as Position,
      name: player?.name ?? pick.player_id,
    };
  });

  return {
    rosterId: roster.roster_id,
    draftSlot,
    teamName: null,
    isUs,
    players: rosterPlayers,
    positionCounts,
    startingLineup,
    lineupHoles: lineup.unfilled.map((hole) => ({ slot: hole.slot as string, count: hole.count })),
    bench: lineup.benchPlayers
      .map((player) => byPlayerId.get(player.playerId))
      .filter((player): player is BriefRosterPlayer => Boolean(player)),
    needs: describeNeeds(state),
    build: state.build,
    strengths: state.strengths,
    weaknesses: state.weaknesses,
    strategicPriority: state.strategicPriority,
    unfilledStarterSlots: state.unfilledStarterSlots,
    picks: orderedPicks,
    selectionsBeforeOurNextPick:
      input.nextOurPick === null
        ? []
        : remainingSelections.filter((pick) => pick < input.nextOurPick!),
    nextSelectionOverall: remainingSelections[0] ?? null,
    tendency: describeTendency(orderedPicks, rosterPlayers),
  };
}

function describeNeeds(state: RosterConstructionState): BriefPositionNeed[] {
  return DESCRIBED_POSITIONS.map((position) => state.byPosition[position])
    .filter((entry): entry is PositionState => Boolean(entry))
    .map((entry) => ({
      position: entry.position,
      startersRequired: entry.startersRequired,
      startersFilled: entry.startersFilled,
      openStartingSlots: round1(entry.openStartingSlots),
      drafted: entry.drafted,
      depthNeed: entry.depthNeed,
      saturation: entry.saturation,
      starterQuality: entry.starterQuality,
    }));
}

/**
 * What this team's selections say about how it drafts.
 *
 * Everything here is read off picks that have already happened. A team is only
 * described as reaching at a position when it took somebody meaningfully before
 * First Seed's board said to - which is observable, unlike a guess about what
 * they intend to do next.
 */
function describeTendency(
  picks: { overallPick: number; round: number; position: Position; name: string }[],
  players: BriefRosterPlayer[],
): BriefTeamTendency {
  const total = Math.max(1, picks.length);
  const positionShare: Record<string, number> = {};
  const firstRoundByPosition: Partial<Record<Position, number>> = {};
  for (const position of DESCRIBED_POSITIONS) {
    const atPosition = picks.filter((pick) => pick.position === position);
    positionShare[position] = round2(atPosition.length / total);
    const earliest = atPosition.reduce<number | null>(
      (best, pick) => (best === null || pick.round < best ? pick.round : best),
      null,
    );
    if (earliest !== null) firstRoundByPosition[position] = earliest;
  }

  const lastPickPosition = picks.length > 0 ? picks[picks.length - 1].position : null;
  let consecutiveSamePosition = 0;
  for (let index = picks.length - 1; index >= 0; index -= 1) {
    if (picks[index].position !== lastPickPosition) break;
    consecutiveSamePosition += 1;
  }

  const byOverallPick = new Map(players.map((player) => [player.overallPick, player]));
  const reachedEarlyAt = [
    ...new Set(
      picks
        .filter((pick) => {
          const rank = byOverallPick.get(pick.overallPick)?.firstSeedRank;
          return rank !== null && rank !== undefined && rank - pick.overallPick >= REACH_RANK_GAP;
        })
        .map((pick) => pick.position),
    ),
  ];

  return {
    positionShare,
    firstRoundByPosition,
    lastPickPosition,
    consecutiveSamePosition,
    reachedEarlyAt,
  };
}

const round1 = (value: number) => Math.round(value * 10) / 10;
const round2 = (value: number) => Math.round(value * 100) / 100;
