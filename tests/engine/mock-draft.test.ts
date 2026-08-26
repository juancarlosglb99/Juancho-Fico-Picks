import { describe, expect, it } from 'vitest';
import type { DraftRoomRankingSnapshot } from '../../packages/data/types';
import { runDraftBacktest } from '../../packages/engine/mock/backtest';
import { archetypeForRoster, opponentCandidateLogit } from '../../packages/engine/mock/opponent-model';
import {
  runMonteCarloCandidateComparison,
  simulateMockDraft,
  type SimulationInput,
} from '../../packages/engine/mock/simulation';
import {
  MONTE_CARLO_MODEL_VERSION,
  OPPONENT_MODEL_VERSION,
} from '../../packages/engine/mock/types';
import {
  makeContext,
  makeDraft,
  makeLeague,
  makePlayerPool,
  makeProjections,
  makeRosters,
} from './fixtures';
import type { SleeperDraftPick } from '../../packages/sleeper/types';

function scenario(superflex = false): SimulationInput {
  const teams = 10;
  const players = makePlayerPool(45);
  const rosterPositions = superflex
    ? ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'SUPER_FLEX', 'BN', 'BN', 'BN']
    : undefined;
  const league = makeLeague({ teams, rosterPositions });
  const draft = makeDraft({ teams, rounds: 12 });
  const rosters = makeRosters(teams);
  const { board, context } = makeContext({ league, draft, rosters, players });
  const projections = makeProjections(
    players,
    superflex ? 'redraft_superflex' : 'redraft_1qb',
  );
  const roomRankings: DraftRoomRankingSnapshot = {
    kind: 'draft-room-ranking',
    provenance: {
      sourceId: 'room',
      sourceLabel: 'Sleeper room',
      season: '2026',
      fetchedAt: '2026-08-26T00:00:00.000Z',
      sourceUpdatedAt: '2026-08-20T00:00:00.000Z',
      sourceConfidence: 'high',
    },
    context: {
      platform: 'sleeper',
      scoringFormat: 'standard',
      qbFormat: superflex ? 'superflex' : '1qb',
      sheet: superflex ? 'Sleeper Superflex' : 'Sleeper Standard',
    },
    records: projections.map((projection, index) => ({
      sourceRow: index + 2,
      playerId: projection.playerId,
      playerName: projection.playerName,
      position: projection.position,
      team: 'TST',
      rank: projections.length - index,
      upstreamMarketAdp: projection.adp ?? null,
      upstreamExpertRank: null,
      firstSeedValueDelta: null,
      firstSeedLandmineScore: null,
      resolutionMethod: 'direct-external-id',
      resolutionConfidence: 1,
    })),
    unresolved: [],
    resolution: {
      total: projections.length,
      matched: projections.length,
      directExternalId: projections.length,
      exactCanonical: 0,
      normalizedName: 0,
      ambiguous: 0,
      unresolved: 0,
    },
    compatibility: { level: 'exact', confidence: 'high', reasons: ['Exact.'] },
  };
  return { context, draft, board, picks: [], rosters, players, projections, roomRankings };
}

describe('opponent mock and Monte Carlo model', () => {
  it('assigns stable heterogeneous opponent archetypes', () => {
    expect(new Set(Array.from({ length: 10 }, (_, index) => archetypeForRoster(index + 1))).size)
      .toBe(5);
    expect(archetypeForRoster(1)).toBe(archetypeForRoster(6));
  });

  it('lets room-followers respond to platform rank without using Juancho projection rank', () => {
    const input = scenario();
    const [first, second] = input.projections;
    const common = {
      archetype: 'room_rank_follower' as const,
      counts: {},
      roster: input.context.roster.value,
      currentPick: 20,
      recentPositions: [],
    };
    const earlier = opponentCandidateLogit({
      ...common,
      candidate: { projection: { ...first, rank: 999 }, roomRanking: { ...input.roomRankings!.records[0], rank: 20 } },
    });
    const later = opponentCandidateLogit({
      ...common,
      candidate: { projection: { ...second, rank: 1 }, roomRanking: { ...input.roomRankings!.records[1], rank: 90 } },
    });
    expect(earlier).toBeGreaterThan(later);
  });

  it.each([false, true])('completes deterministic 1QB/superflex continuations (%s)', (superflex) => {
    const input = scenario(superflex);
    const first = simulateMockDraft(input, { seed: 42 });
    const second = simulateMockDraft(input, { seed: 42 });
    expect(first).toEqual(second);
    expect(first.modelVersion).toBe(MONTE_CARLO_MODEL_VERSION);
    expect(first.picks.length).toBeGreaterThan(80);
    expect(first.userPlayerIds.length).toBeGreaterThan(5);
  });

  it.each([1, 5, 10])('starts a complete mock from early/middle/late slot %s', (slot) => {
    const teams = 10;
    const players = makePlayerPool(45);
    const league = makeLeague({ teams });
    const draft = makeDraft({ teams, rounds: 12 });
    const rosters = makeRosters(teams);
    const picked = players.players.slice(0, slot - 1);
    const picks: SleeperDraftPick[] = picked.map((player, index) => ({
      player_id: player.externalIds.sleeper!,
      picked_by: `user-${index + 1}`,
      roster_id: String(index + 1),
      round: 1,
      draft_slot: index + 1,
      pick_no: index + 1,
      metadata: { first_name: player.name, position: player.position, team: player.team ?? undefined },
      is_keeper: false,
    }));
    const { board, context } = makeContext({
      league,
      draft,
      rosters,
      players,
      picks,
      userId: `user-${slot}`,
    });
    const result = simulateMockDraft({
      context,
      draft,
      board,
      picks,
      rosters,
      players,
      projections: makeProjections(players),
    }, { seed: slot });
    expect(result.picks[0].overallPick).toBe(slot);
    expect(result.userPlayerIds.length).toBeGreaterThan(5);
  });

  it('keeps prefilled keeper selections unavailable in a continuation', () => {
    const input = scenario();
    const keeper = input.players.players[0];
    const keeperPick: SleeperDraftPick = {
      player_id: keeper.externalIds.sleeper!,
      picked_by: 'user-2',
      roster_id: '2',
      round: 1,
      draft_slot: 2,
      pick_no: 1,
      metadata: { first_name: keeper.name, position: keeper.position },
      is_keeper: true,
    };
    const { board, context } = makeContext({
      league: makeLeague({ teams: 10, type: 1, settings: { max_keepers: 1 } }),
      draft: input.draft,
      rosters: input.rosters,
      players: input.players,
      picks: [keeperPick],
    });
    const result = simulateMockDraft({ ...input, board, context, picks: [keeperPick] }, { seed: 9 });
    expect(result.picks.some((pick) => pick.playerId === keeper.id)).toBe(false);
  });

  it('compares complete-roster outcomes and measures wait availability independently', () => {
    const input = scenario();
    const candidates = [input.projections[0].playerId, input.projections.at(-1)!.playerId];
    const comparison = runMonteCarloCandidateComparison(input, candidates, {
      simulations: 12,
      seed: 818,
    });
    expect(comparison.opponentModelVersion).toBe(OPPONENT_MODEL_VERSION);
    expect(comparison.candidates).toHaveLength(2);
    expect(comparison.candidates.every((candidate) => candidate.averageRosterScore > 0)).toBe(true);
    expect(comparison.candidates.find((candidate) => candidate.playerId === candidates[1])!
      .availableNextPickProbability).toBeGreaterThan(0);
  });

  it('exposes repeatable backtest output with the actual selection kept separate', () => {
    const input = scenario();
    const ids = input.projections.slice(0, 2).map((projection) => projection.playerId);
    const [result] = runDraftBacktest([{ id: 'early-1qb', input, candidatePlayerIds: ids, actualPlayerId: ids[0] }]);
    expect(result.id).toBe('early-1qb');
    expect(result.actualPlayerId).toBe(ids[0]);
    expect(result.comparison.simulationsPerCandidate).toBe(40);
  });
});
