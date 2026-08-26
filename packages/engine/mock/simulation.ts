import type { DraftRoomRankingSnapshot } from '../../data/types';
import type { CanonicalPlayerMap, Position } from '../../players/types';
import type { MappedProjection } from '../../projections/types';
import type { SleeperDraft, SleeperDraftPick, SleeperRoster } from '../../sleeper/types';
import type { LeagueContext } from '../context/types';
import { slotForOverallPick } from '../draft/next-pick-probability';
import { getRosterPositionCounts } from '../draft/roster-fit';
import { resolvePickRosterId } from '../draft/pick-ownership';
import { evaluateRoster, lineupSlotsFor, type LineupPlayer } from '../draft/lineup';
import type { DraftBoardState } from '../draft/types';
import { archetypeForRoster, chooseOpponentPlayer, type OpponentCandidate } from './opponent-model';
import {
  MONTE_CARLO_MODEL_VERSION,
  OPPONENT_MODEL_VERSION,
  type CandidateSimulationResult,
  type MockDraftResult,
  type MonteCarloComparison,
  type SimulatedPick,
} from './types';

export interface SimulationInput {
  context: LeagueContext;
  draft: SleeperDraft;
  board: DraftBoardState;
  picks: SleeperDraftPick[];
  rosters: SleeperRoster[];
  players: CanonicalPlayerMap;
  projections: MappedProjection[];
  roomRankings?: DraftRoomRankingSnapshot | null;
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function increment(counts: Partial<Record<Position, number>>, position: Position) {
  counts[position] = (counts[position] ?? 0) + 1;
}

function ownerForPick(draft: SleeperDraft, overallPick: number): number | null {
  const slot = slotForOverallPick(
    overallPick,
    draft.settings.teams ?? 1,
    draft.type === 'snake' || draft.type === 'linear' || draft.type === '3rr'
      ? draft.type
      : 'unknown',
  );
  return draft.slot_to_roster_id?.[String(slot)] ?? slot;
}

/**
 * How the simulated Juancho seat picks.
 *
 * It uses the same roster evaluation the live engine does, so a simulated draft
 * cannot conclude that a roster shape is good when the recommendation engine
 * would refuse to build it. The old version added a flat bonus per unfilled
 * starter and otherwise sorted on raw projection, which is precisely the
 * behaviour that let simulated rosters pile up quarterbacks.
 */
function userChoice(
  candidates: OpponentCandidate[],
  selected: MappedProjection[],
  context: LeagueContext,
): OpponentCandidate | null {
  const slots = lineupSlotsFor(context.roster.value);
  const current: LineupPlayer[] = selected.map((projection) => ({
    playerId: projection.playerId,
    position: projection.position,
    projection: projection.projection,
  }));
  const baseline = evaluateRoster(current, slots).total;

  let best: OpponentCandidate | null = null;
  let bestGain = -Infinity;
  // Only the strongest few at each position can matter, so this stays cheap.
  const considered = new Map<Position, number>();
  for (const candidate of [...candidates].sort(
    (a, b) => b.projection.projection - a.projection.projection,
  )) {
    const seen = considered.get(candidate.projection.position) ?? 0;
    if (seen >= 3) continue;
    considered.set(candidate.projection.position, seen + 1);
    const gain =
      evaluateRoster(
        [
          ...current,
          {
            playerId: candidate.projection.playerId,
            position: candidate.projection.position,
            projection: candidate.projection.projection,
          },
        ],
        slots,
      ).total - baseline;
    if (gain > bestGain) {
      bestGain = gain;
      best = candidate;
    }
  }
  return best;
}

/**
 * Scores a finished roster.
 *
 * This delegates to the same evaluation the recommendation engine uses, which
 * fixes three things the old version got wrong: FLEX slots were never counted,
 * so a flex starter was worth nothing; "bench" value was taken from the top N of
 * ALL selected players, double-counting the starters instead of measuring the
 * bench; and every extra body added a flat 8% of his projection with no cap, so
 * hoarding quarterbacks actually RAISED the simulated score.
 */
function rosterOutcome(selected: MappedProjection[], context: LeagueContext): number {
  const slots = lineupSlotsFor(context.roster.value);
  const players: LineupPlayer[] = selected.map((projection) => ({
    playerId: projection.playerId,
    position: projection.position,
    projection: projection.projection,
  }));
  return evaluateRoster(players, slots).total;
}

export function simulateMockDraft(
  input: SimulationInput,
  {
    seed = 1,
    forcedFirstPlayerId,
    withholdFirstPlayerId,
  }: {
    seed?: number;
    forcedFirstPlayerId?: string;
    withholdFirstPlayerId?: string;
  } = {},
): MockDraftResult {
  const random = mulberry32(seed);
  const roomByPlayer = new Map((input.roomRankings?.records ?? []).map((record) => [record.playerId, record]));
  const unavailable = new Set(input.board.unavailableSleeperIds);
  const candidatePool: OpponentCandidate[] = input.projections
    .filter((projection) => {
      const sleeperId = input.players.byId.get(projection.playerId)?.externalIds.sleeper;
      return sleeperId && !unavailable.has(sleeperId) && ['QB', 'RB', 'WR', 'TE'].includes(projection.position);
    })
    .map((projection) => ({ projection, roomRanking: roomByPlayer.get(projection.playerId) ?? null }));
  const available = new Map(candidatePool.map((candidate) => [candidate.projection.playerId, candidate]));
  const counts = new Map<number, Partial<Record<Position, number>>>(
    input.rosters.map((roster) => [
      roster.roster_id,
      getRosterPositionCounts(
        roster.roster_id,
        input.picks,
        input.rosters,
        input.players,
        input.draft.slot_to_roster_id,
      ),
    ]),
  );
  const userRosterId = input.context.draftState.value.userRosterId;
  const currentOwner = ownerForPick(input.draft, input.board.currentOverallPick);
  const firstUserDecisionPick =
    userRosterId !== null && currentOwner === userRosterId
      ? input.board.currentOverallPick
      : input.context.draftState.value.nextUserPick;
  /*
   * Seed the simulated roster with what we ALREADY hold.
   *
   * A simulation that starts mid-draft from an empty roster will happily draft
   * a position we have three of, and will score the finished team as though the
   * earlier rounds never happened. Both make the comparison meaningless.
   */
  const projectionByPlayerId = new Map(
    input.projections.map((projection) => [projection.playerId, projection]),
  );
  const existingUserPlayers: MappedProjection[] = [];
  if (userRosterId !== null) {
    const ownedSleeperIds = new Set<string>();
    for (const pick of input.picks) {
      if (resolvePickRosterId(pick, input.draft.slot_to_roster_id) !== userRosterId) continue;
      ownedSleeperIds.add(pick.player_id);
    }
    for (const sleeperId of input.rosters.find((r) => r.roster_id === userRosterId)?.players ?? []) {
      ownedSleeperIds.add(sleeperId);
    }
    for (const sleeperId of ownedSleeperIds) {
      const player = input.players.bySleeperId.get(sleeperId);
      const projection = player ? projectionByPlayerId.get(player.id) : undefined;
      if (projection) existingUserPlayers.push(projection);
    }
  }
  const userSelected: MappedProjection[] = [...existingUserPlayers];
  const simulated: SimulatedPick[] = [];
  const recentPositions: Position[] = [];
  const totalPicks = input.board.teams * input.board.rounds;

  for (let overallPick = input.board.currentOverallPick; overallPick <= totalPicks; overallPick += 1) {
    const rosterId = ownerForPick(input.draft, overallPick);
    const rosterCounts = rosterId === null ? {} : counts.get(rosterId) ?? {};
    const isUser = userRosterId !== null && rosterId === userRosterId;
    let selected: OpponentCandidate | null;
    if (isUser && overallPick === firstUserDecisionPick && forcedFirstPlayerId) {
      selected = available.get(forcedFirstPlayerId) ?? null;
    } else if (isUser) {
      const userCandidates = overallPick === firstUserDecisionPick && withholdFirstPlayerId
        ? [...available.values()].filter((candidate) => candidate.projection.playerId !== withholdFirstPlayerId)
        : [...available.values()];
      selected = userChoice(userCandidates, userSelected, input.context);
    } else {
      selected = chooseOpponentPlayer({
        candidates: [...available.values()],
        archetype: archetypeForRoster(rosterId ?? overallPick),
        counts: rosterCounts,
        roster: input.context.roster.value,
        currentPick: overallPick,
        recentPositions,
        random,
      });
    }
    if (!selected) break;
    available.delete(selected.projection.playerId);
    increment(rosterCounts, selected.projection.position);
    if (rosterId !== null) counts.set(rosterId, rosterCounts);
    if (isUser) {
      userSelected.push(selected.projection);
    }
    recentPositions.push(selected.projection.position);
    simulated.push({
      overallPick,
      rosterId,
      playerId: selected.projection.playerId,
      position: selected.projection.position,
      archetype: isUser ? 'juancho' : archetypeForRoster(rosterId ?? overallPick),
    });
  }
  return {
    modelVersion: MONTE_CARLO_MODEL_VERSION,
    seed,
    picks: simulated,
    userPlayerIds: userSelected
      .slice(existingUserPlayers.length)
      .map((projection) => projection.playerId),
    rosterScore: rosterOutcome(userSelected, input.context),
  };
}

function percentile(values: number[], amount: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * amount))] ?? 0;
}

export function runMonteCarloCandidateComparison(
  input: SimulationInput,
  candidatePlayerIds: string[],
  { simulations = 80, seed = 20260826 }: { simulations?: number; seed?: number } = {},
): MonteCarloComparison {
  const nextPick = input.context.draftState.value.nextUserPick;
  const candidates: CandidateSimulationResult[] = candidatePlayerIds.map((playerId, candidateIndex) => {
    const scores: number[] = [];
    let survived = 0;
    for (let run = 0; run < simulations; run += 1) {
      const result = simulateMockDraft(input, {
        seed: seed + candidateIndex * 100_003 + run * 997,
        forcedFirstPlayerId: playerId,
      });
      scores.push(result.rosterScore);
      if (nextPick !== null) {
        const waitResult = simulateMockDraft(input, {
          seed: seed + candidateIndex * 100_003 + run * 997,
          withholdFirstPlayerId: playerId,
        });
        const takenBeforeNext = waitResult.picks.some(
          (pick) => pick.overallPick < nextPick && pick.playerId === playerId,
        );
        if (!takenBeforeNext) survived += 1;
      }
    }
    return {
      playerId,
      simulations,
      availableNextPickProbability: nextPick === null ? null : Math.round((survived / simulations) * 1000) / 10,
      averageRosterScore: Math.round((scores.reduce((sum, value) => sum + value, 0) / scores.length) * 10) / 10,
      rosterScoreP25: percentile(scores, 0.25),
      rosterScoreP75: percentile(scores, 0.75),
    };
  });
  return {
    modelVersion: MONTE_CARLO_MODEL_VERSION,
    opponentModelVersion: OPPONENT_MODEL_VERSION,
    simulationsPerCandidate: simulations,
    candidates: candidates.sort((a, b) => b.averageRosterScore - a.averageRosterScore),
  };
}
