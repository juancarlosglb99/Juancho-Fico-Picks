/**
 * The brief has to describe the whole room, not a summary of it.
 *
 * These are structural: the strategist can only reason about what it is handed,
 * so the failures worth catching are omissions - an opponent missing, a drafted
 * player still in the pool, a candidate whose First Seed number and Juancho
 * number have been quietly blended into one score.
 */
import { describe, expect, it } from 'vitest';
import { generateDraftRecommendations } from '../../packages/engine/draft/recommendations';
import { buildDraftBrief } from '../../packages/engine/strategist/brief';
import { fingerprintBoard } from '../../packages/engine/strategist/state-version';
import type { SleeperDraftPick } from '../../packages/sleeper/types';
import {
  makeContext,
  makeDraft,
  makeLeague,
  makePlayerPool,
  makeProjections,
  makeRosters,
} from './fixtures';

const players = makePlayerPool(64);
const TEAMS = 12;

/** Picks 1..count in slot order, taking the best projected player each time. */
function makePicks(count: number): SleeperDraftPick[] {
  const ordered = [...makeProjections(players)].sort((a, b) => b.projection - a.projection);
  return Array.from({ length: count }, (_, index) => {
    const overall = index + 1;
    const round = Math.ceil(overall / TEAMS);
    const pickInRound = ((overall - 1) % TEAMS) + 1;
    const slot = round % 2 === 0 ? TEAMS + 1 - pickInRound : pickInRound;
    return {
      player_id: players.byId.get(ordered[index].playerId)!.externalIds.sleeper!,
      picked_by: `user-${slot}`,
      roster_id: String(slot),
      round,
      draft_slot: slot,
      pick_no: overall,
      metadata: {},
    } satisfies SleeperDraftPick;
  });
}

function brief(pickCount: number, candidatePool?: Parameters<typeof buildDraftBrief>[0]['candidatePool']) {
  const picks = makePicks(pickCount);
  const league = makeLeague({ teams: TEAMS });
  const draft = makeDraft({ teams: TEAMS });
  const rosters = makeRosters(TEAMS);
  const { context, board } = makeContext({ league, draft, picks, rosters, players });
  const result = generateDraftRecommendations({
    context,
    picks,
    rosters,
    board,
    players,
    projections: makeProjections(players),
  });
  return {
    picks,
    result,
    brief: buildDraftBrief({
      context,
      board,
      picks,
      rosters,
      players,
      result,
      draftId: 'draft-1',
      candidatePool,
    }),
  };
}

describe('the draft brief', () => {
  it('describes every team in the room, not just ours', () => {
    const { brief: built } = brief(24);
    expect(built).not.toBeNull();
    expect(built!.opponents).toHaveLength(TEAMS - 1);
    expect(built!.ourTeam.isUs).toBe(true);
    expect(built!.opponents.every((team) => !team.isUs)).toBe(true);
  });

  it('gives every opponent actual players, needs and a lineup, not just counts', () => {
    const { brief: built } = brief(36);
    const opponent = built!.opponents.find((team) => team.players.length > 0)!;

    expect(opponent.players[0]).toMatchObject({
      name: expect.any(String),
      position: expect.any(String),
      overallPick: expect.any(Number),
    });
    expect(opponent.needs.length).toBeGreaterThan(0);
    expect(opponent.startingLineup.length).toBeGreaterThan(0);
    // Counts must agree with the players they are counts of.
    const counted = Object.values(opponent.positionCounts).reduce((sum, n) => sum + (n ?? 0), 0);
    expect(counted).toBe(opponent.players.length);
  });

  it('never offers a player who has already been drafted', () => {
    const { brief: built } = brief(40);
    const drafted = new Set(built!.room.allDraftedPlayerIds);
    const offered = built!.candidates.filter((candidate) => drafted.has(candidate.playerId));
    expect(offered.map((candidate) => candidate.name)).toEqual([]);
  });

  it('keeps First Seed and Juancho as separate numbers', () => {
    const { brief: built } = brief(20);
    const candidate = built!.candidates[0];
    expect(candidate).toHaveProperty('firstSeed');
    expect(candidate).toHaveProperty('juancho');
    expect(candidate.juancho).toHaveProperty('projectedPoints');
    expect(candidate.juancho).toHaveProperty('planValue');
    // Raw simulation and penalty-adjusted order are separate numbers, because
    // they can disagree and the disagreement is Juancho's actual opinion.
    expect(candidate.juancho).toHaveProperty('planValueVsRecommended');
    expect(candidate.juancho).toHaveProperty('decisionValue');
    expect(candidate.survival).toHaveProperty('probability');
  });

  it('always carries the deterministic recommendation in the pool', () => {
    const { brief: built } = brief(20, { topOverall: 1, topPerPosition: 1, tierDepth: 0, includeJuanchoShortlist: false });
    const recommended = built!.deterministic.recommended!;
    const inPool = built!.candidates.find(
      (candidate) => candidate.playerId === recommended.playerId,
    );
    expect(inPool, 'the strategist must be able to see what it is disagreeing with').toBeTruthy();
    expect(inPool!.inclusionReasons).toContain('juancho_recommendation');
  });

  it('honours a hard candidate cap without dropping Juancho\'s own picks', () => {
    const { brief: built, result } = brief(20, { maxCandidates: 12 });
    expect(built!.candidates.length).toBeGreaterThanOrEqual(result.recommendations.length);
    for (const recommendation of result.recommendations) {
      expect(
        built!.candidates.some((candidate) => candidate.playerId === recommendation.player.id),
      ).toBe(true);
    }
  });

  it('records why each candidate is in the pool', () => {
    const { brief: built } = brief(20);
    expect(built!.candidates.every((candidate) => candidate.inclusionReasons.length > 0)).toBe(true);
  });

  it('reports the room: recent picks, runs and who picks before us', () => {
    const { brief: built } = brief(30);
    expect(built!.room.recentPicks.length).toBeGreaterThan(0);
    expect(built!.room.recentPicks.at(-1)!.overallPick).toBe(30);
    expect(built!.room.positionalRuns.length).toBeGreaterThan(0);
    expect(built!.room.totalDrafted).toBe(30);
    for (const team of built!.room.teamsBeforeOurNextPick) {
      expect(team.selections.length).toBeGreaterThan(0);
      expect(team.needs.length).toBeGreaterThan(0);
    }
  });

  it('states the constraints the guardrails will enforce', () => {
    const { brief: built } = brief(20);
    // One starting quarterback: a third could never play, so capacity is stated.
    expect(built!.constraints.usableCapacity.QB).toBe(2);
    expect(built!.constraints.rosterSpotsRemaining).toBeGreaterThan(0);
    expect(built!.constraints.kickersAndDefensesAllowed).toBe(false);
  });

  it('leaves the strategy and news extension points present but empty', () => {
    const { brief: built } = brief(20);
    expect(built!.strategyContext).toBeNull();
    expect(built!.playerNews).toBeNull();
  });

  it('identifies the exact board state it describes', () => {
    const { brief: built, picks } = brief(25);
    expect(built!.state.picksMade).toBe(25);
    expect(built!.state.currentOverallPick).toBe(26);
    expect(built!.state.boardFingerprint).toBe(
      fingerprintBoard(picks.map((pick) => pick.player_id)),
    );
  });

  it('builds the same brief twice from the same board', () => {
    const first = brief(25).brief;
    const second = brief(25).brief;
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });
});
