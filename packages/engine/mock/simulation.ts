import type { DraftRoomRankingSnapshot } from '../../data/types';
import type { CanonicalPlayerMap, Position } from '../../players/types';
import type { MappedProjection } from '../../projections/types';
import type { SleeperDraft, SleeperDraftPick, SleeperRoster } from '../../sleeper/types';
import type { LeagueContext } from '../context/types';
import { slotForOverallPick } from '../draft/next-pick-probability';
import { getRosterPositionCounts, getStarterTargets } from '../draft/roster-fit';
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

function userChoice(
  candidates: OpponentCandidate[],
  counts: Partial<Record<Position, number>>,
  context: LeagueContext,
): OpponentCandidate | null {
  const targets = getStarterTargets(context.roster.value);
  const targetFor = (position: Position) =>
    ['QB', 'RB', 'WR', 'TE', 'K', 'DEF'].includes(position)
      ? targets[position as keyof Omit<typeof targets, 'FLEX'>]
      : 0;
  return [...candidates].sort((a, b) => {
    const needA = Math.max(0, targetFor(a.projection.position) - (counts[a.projection.position] ?? 0));
    const needB = Math.max(0, targetFor(b.projection.position) - (counts[b.projection.position] ?? 0));
    return (
      b.projection.projection + needB * 18 -
      (a.projection.projection + needA * 18)
    );
  })[0] ?? null;
}

function rosterOutcome(
  selected: MappedProjection[],
  context: LeagueContext,
): number {
  const targets = getStarterTargets(context.roster.value);
  const byPosition = new Map<Position, MappedProjection[]>();
  for (const projection of selected) {
    byPosition.set(projection.position, [
      ...(byPosition.get(projection.position) ?? []),
      projection,
    ]);
  }
  let score = 0;
  let missing = 0;
  for (const position of ['QB', 'RB', 'WR', 'TE'] as const) {
    const count = Math.max(0, targets[position] ?? 0);
    const records = [...(byPosition.get(position) ?? [])]
      .sort((a, b) => b.projection - a.projection)
      .slice(0, count);
    score += records.reduce((sum, record) => sum + record.projection, 0);
    missing += Math.max(0, count - records.length);
  }
  const bench = selected
    .sort((a, b) => b.projection - a.projection)
    .slice(0, context.roster.value.bench)
    .reduce((sum, record) => sum + record.projection * 0.08, 0);
  return Math.round((score + bench - missing * 80) * 10) / 10;
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
      getRosterPositionCounts(roster.roster_id, input.picks, input.rosters, input.players),
    ]),
  );
  const userRosterId = input.context.draftState.value.userRosterId;
  const currentOwner = ownerForPick(input.draft, input.board.currentOverallPick);
  const firstUserDecisionPick =
    userRosterId !== null && currentOwner === userRosterId
      ? input.board.currentOverallPick
      : input.context.draftState.value.nextUserPick;
  const userSelected: MappedProjection[] = [];
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
      selected = userChoice(userCandidates, rosterCounts, input.context);
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
    userPlayerIds: userSelected.map((projection) => projection.playerId),
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
