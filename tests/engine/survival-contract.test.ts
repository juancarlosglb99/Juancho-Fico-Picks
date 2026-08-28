/**
 * "Not modelled" and "certain to survive" are different claims.
 *
 * The contract these tests pin down: `modeled` says whether a figure was
 * actually estimated, and the field a screen reads is null unless it was. The
 * internal `value` keeps whatever default the ranking arithmetic needs, so
 * nothing about the ordering depends on this.
 *
 * The first test is the important one, and it is the one that would have caught
 * a claim made carelessly: the simulation is handed the WHOLE projected pool,
 * so a deep player's 100% is a counted result rather than an assumption.
 * `CANDIDATE_DEPTH` bounds who a simulated team will TAKE, not who is tracked.
 */
import { describe, expect, it } from 'vitest';
import { generateDraftRecommendations } from '../../packages/engine/draft/recommendations';
import { CANDIDATE_DEPTH } from '../../packages/engine/draft/room-simulation';
import type { SleeperDraftPick } from '../../packages/sleeper/types';
import {
  makeContext,
  makeDraft,
  makeLeague,
  makePlayerPool,
  makeProjections,
  makeRoomRankings,
  makeRosters,
} from './fixtures';

const TEAMS = 12;
const players = makePlayerPool(64);
const projections = makeProjections(players);
const roomRankings = makeRoomRankings(projections);

function board(picksMade: number) {
  const ranked = [...projections].sort((a, b) => b.projection - a.projection);
  const picks: SleeperDraftPick[] = Array.from({ length: picksMade }, (_, index) => {
    const overall = index + 1;
    const round = Math.ceil(overall / TEAMS);
    const pickInRound = ((overall - 1) % TEAMS) + 1;
    const slot = round % 2 === 0 ? TEAMS + 1 - pickInRound : pickInRound;
    return {
      player_id: players.byId.get(ranked[index].playerId)!.externalIds.sleeper!,
      picked_by: `user-${slot}`,
      roster_id: String(slot),
      round,
      draft_slot: slot,
      pick_no: overall,
      metadata: {},
    };
  });
  const league = makeLeague({ teams: TEAMS });
  const draft = makeDraft({ teams: TEAMS });
  const rosters = makeRosters(TEAMS);
  const { context, board: state } = makeContext({ league, draft, picks, rosters, players });
  return generateDraftRecommendations({
    context,
    picks,
    rosters,
    board: state,
    players,
    projections,
    roomRankings,
  });
}

describe('survival is reported only when it was estimated', () => {
  const result = board(14);
  const internals = result.internals!;

  it('estimates the players actually in contention', () => {
    const top = internals.survivalOf(result.recommendations[0].player.id);
    expect(top.modeled).toBe(true);
    expect(top.value).not.toBeNull();
    expect(result.recommendations[0].availableNextPickProbability).toBe(top.value);
  });

  it('estimates the whole pool, not only the players in contention', () => {
    const ordered = [...internals.candidatePool].sort(
      (a, b) => a.consensusRank - b.consensusRank,
    );
    // Far more players than a simulated team will ever consider taking.
    expect(ordered.length).toBeGreaterThan(CANDIDATE_DEPTH * 2);

    const deep = internals.survivalOf(ordered[ordered.length - 1].playerId);
    expect(deep.modeled).toBe(true);
    expect(deep.value).not.toBeNull();

    // Every projected candidate, without exception.
    for (const candidate of internals.candidatePool) {
      expect(internals.survivalOf(candidate.playerId).modeled).toBe(true);
    }
  });

  it('says nothing about a player who is not a candidate at all', () => {
    const estimate = internals.survivalOf('jfp:not-a-real-player');
    expect(estimate.value).toBeNull();
    expect(estimate.modeled).toBe(false);
  });

  it('never publishes an unmodelled figure as a recommendation', () => {
    for (const recommendation of result.recommendations) {
      const estimate = internals.survivalOf(recommendation.player.id);
      if (!estimate.modeled) {
        expect(recommendation.availableNextPickProbability).toBeNull();
      } else {
        expect(recommendation.availableNextPickProbability).toBe(estimate.value);
      }
    }
  });

  it('still reports a real 100% when nobody picks in between', () => {
    /*
     * Back-to-back selections at the turn are certain, not unknown: the
     * simulation has nothing to simulate because no selection intervenes, and
     * everyone on the board is available by construction.
     */
    const turn = board(11);
    if (turn.picksUntilNextUserPick !== 0) return;
    const estimate = turn.internals!.survivalOf(turn.recommendations[0].player.id);
    expect(estimate.modeled).toBe(true);
    expect(estimate.value).toBe(100);
    expect(turn.recommendations[0].availableNextPickProbability).toBe(100);
  });

  it('reports nothing at all when there is no next selection to survive to', () => {
    const last = board(TEAMS * 16 - 1);
    const estimate = last.internals!.survivalOf(
      last.recommendations[0]?.player.id ?? 'none',
    );
    expect(estimate.value).toBeNull();
    expect(estimate.modeled).toBe(false);
    expect(last.recommendations[0]?.availableNextPickProbability ?? null).toBeNull();
  });
});
