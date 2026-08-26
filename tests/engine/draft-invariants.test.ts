/**
 * Invariants that must hold on every recommendation, in every league.
 *
 * These are not the model. They are the tripwires that catch the model failing
 * in ways a person would notice immediately - advice that contradicts itself,
 * or a roster nobody would build - so a regression cannot ship quietly.
 */
import { describe, expect, it } from 'vitest';
import { generateDraftRecommendations } from '../../packages/engine/draft/recommendations';
import { autodraftWithRecommendationOne } from '../../packages/engine/mock/autodraft';
import { deriveDraftBoardState } from '../../packages/engine/draft/state';
import { normalizeLeagueContext } from '../../packages/engine/context/normalize';
import type { Position } from '../../packages/players/types';
import type { SleeperDraftPick } from '../../packages/sleeper/types';
import { makeDraft, makeLeague, makePlayerPool, makeProjections, makeRosters } from './fixtures';

const ROSTER_POSITIONS = ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', ...Array(8).fill('BN')];
const SLOTS = { slots_qb: 1, slots_rb: 2, slots_wr: 2, slots_te: 1, slots_flex: 1, slots_bn: 8 };

function pickFor(overallPick: number, playerId: string, teams: number): SleeperDraftPick {
  const round = Math.ceil(overallPick / teams);
  const inRound = ((overallPick - 1) % teams) + 1;
  const slot = round % 2 === 0 ? teams + 1 - inRound : inRound;
  return {
    player_id: playerId,
    picked_by: `user-${slot}`,
    // Mock drafts report null here; the engine must survive that.
    roster_id: null as unknown as string,
    round,
    draft_slot: slot,
    pick_no: overallPick,
    metadata: {},
  };
}

/**
 * Builds a live draft state where OUR seat already holds the named positions,
 * using picks that carry no roster id - exactly what Sleeper returns in a mock.
 */
function scenarioWithRoster(ourPositions: Position[], teams = 12) {
  const players = makePlayerPool(70);
  const projections = makeProjections(players);
  const league = makeLeague({ teams, rosterPositions: ROSTER_POSITIONS });
  const draft = makeDraft({ teams, rounds: 15, settings: SLOTS });
  const rosters = makeRosters(teams);

  const byPosition = new Map<Position, string[]>();
  for (const player of players.players) {
    byPosition.set(player.position, [
      ...(byPosition.get(player.position) ?? []),
      player.externalIds.sleeper!,
    ]);
  }
  const consumed = new Map<Position, number>();
  const picks: SleeperDraftPick[] = [];
  let overall = 1;
  for (const position of ourPositions) {
    const index = consumed.get(position) ?? 0;
    consumed.set(position, index + 1);
    const sleeperId = byPosition.get(position)![index];
    // Place each of our picks on our own slot (seat 1, picks 1, 24, 25, ...).
    const ourPick = picks.length === 0 ? 1 : picks.length % 2 === 1 ? 24 : 25;
    picks.push(pickFor(ourPick + (picks.length >= 3 ? (picks.length - 1) * 24 : 0), sleeperId, teams));
    overall += 1;
  }
  void overall;

  const board = deriveDraftBoardState(draft, picks, rosters, players);
  const context = normalizeLeagueContext({
    league,
    draft,
    drafts: [draft],
    picks,
    tradedPicks: [],
    rosters,
    board,
    userId: 'user-1',
  });
  return {
    result: generateDraftRecommendations({
      context,
      picks,
      rosters,
      board,
      players,
      projections,
    }),
    context,
  };
}

describe('advice never contradicts itself', () => {
  it('does not mark a player urgent when he is almost certain to come back', () => {
    const players = makePlayerPool(70);
    const projections = makeProjections(players);
    const league = makeLeague({ teams: 12, rosterPositions: ROSTER_POSITIONS });
    const draft = makeDraft({ teams: 12, rounds: 15, settings: SLOTS });
    const rosters = makeRosters(12);
    const board = deriveDraftBoardState(draft, [], rosters, players);
    const context = normalizeLeagueContext({
      league,
      draft,
      drafts: [draft],
      picks: [],
      tradedPicks: [],
      rosters,
      board,
      userId: 'user-1',
    });
    const result = generateDraftRecommendations({
      context,
      picks: [],
      rosters,
      board,
      players,
      projections,
    });

    for (const recommendation of result.recommendations) {
      const probability = recommendation.availableNextPickProbability;
      if (probability === null || probability < 90) continue;
      if (recommendation.action !== 'DRAFT_NOW') continue;
      // A 90%+ survival chance paired with DRAFT NOW is exactly the
      // contradiction that was reported. It is allowed only when the engine can
      // say why, in words a person can read.
      expect(
        recommendation.insight.exceptionalReason,
        `${recommendation.player.name} says DRAFT_NOW at ${probability}% with no explanation`,
      ).toBeTruthy();
    }
  });

  it('always explains itself', () => {
    const { result } = scenarioWithRoster(['RB', 'RB']);
    for (const recommendation of result.recommendations.slice(0, 10)) {
      expect(recommendation.reasons.length).toBeGreaterThan(0);
      for (const reason of recommendation.reasons) {
        expect(reason.trim().length).toBeGreaterThan(0);
      }
    }
  });

  it('never recommends a player who is already off the board', () => {
    const { result } = scenarioWithRoster(['RB', 'WR', 'QB', 'TE']);
    const drafted = new Set(result.context.draftState.value.draftedPlayerIds);
    for (const recommendation of result.recommendations) {
      const sleeperId = recommendation.player.externalIds.sleeper;
      if (sleeperId) expect(drafted.has(sleeperId)).toBe(false);
    }
  });
});

describe('roster awareness survives a mock draft', () => {
  it('sees our roster even though mock picks carry no roster id', () => {
    const { result } = scenarioWithRoster(['QB', 'RB', 'WR']);
    const quarterback = result.recommendations.find(
      (item) => item.player.position === 'QB',
    );
    expect(quarterback).toBeTruthy();
    // The whole failure began here: the engine believed it owned nothing.
    expect(quarterback!.insight.positionCount).toBeGreaterThanOrEqual(1);
    expect(quarterback!.insight.startersFilled).toBeGreaterThanOrEqual(1);
  });

  it('reports a filled single-slot position as saturated and worth nothing more', () => {
    const { result } = scenarioWithRoster(['QB']);
    const quarterback = result.recommendations.find(
      (item) => item.player.position === 'QB',
    )!;
    expect(['medium', 'high', 'complete']).toContain(quarterback.insight.saturation);
    expect(quarterback.components.marginalStartingValue).toBeLessThanOrEqual(0.001);
  });

  it('still values a running back once two are held, because flex exists', () => {
    const { result } = scenarioWithRoster(['RB', 'RB']);
    const back = result.recommendations.find((item) => item.player.position === 'RB')!;
    expect(back.insight.openStartingSlots).toBeGreaterThan(0);
  });
});

describe('safety guards on a completed draft', () => {
  const build = (userSlot: number) => {
    const players = makePlayerPool(70);
    return autodraftWithRecommendationOne({
      league: makeLeague({ teams: 12, rosterPositions: ROSTER_POSITIONS }),
      draft: makeDraft({ teams: 12, rounds: 15, settings: SLOTS }),
      rosters: makeRosters(12),
      players,
      projections: makeProjections(players),
      userSlot,
      userId: `user-${userSlot}`,
    });
  };

  it.each([1, 6, 12])('never accumulates an unusable bench from slot %i', (userSlot) => {
    const counts = build(userSlot).userPositionCounts;
    // QB4+ must never happen in a one-quarterback league; QB3 is already a
    // roster nobody would build.
    expect(counts.QB ?? 0).toBeLessThanOrEqual(2);
    expect(counts.TE ?? 0).toBeLessThanOrEqual(2);
  });

  it.each([1, 6, 12])('fields a legal starting lineup from slot %i', (userSlot) => {
    const counts = build(userSlot).userPositionCounts;
    expect(counts.QB ?? 0).toBeGreaterThanOrEqual(1);
    expect(counts.RB ?? 0).toBeGreaterThanOrEqual(2);
    expect(counts.WR ?? 0).toBeGreaterThanOrEqual(2);
    expect(counts.TE ?? 0).toBeGreaterThanOrEqual(1);
  });
});
