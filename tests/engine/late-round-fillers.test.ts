/**
 * Which kicker gets offered, and why it used to be the same one every time.
 *
 * Every filler carries the same nominal value by design, so the only thing that
 * could separate them was the order they arrived in - and the player map is
 * sorted by name. The shortlist was therefore the first six kickers
 * alphabetically, in every league, forever. A supplemental board fixes the
 * order without touching the value.
 */
import { describe, expect, it } from 'vitest';
import {
  buildFillerCandidates,
  shouldOfferFillers,
  FILLER_SHORTLIST,
} from '../../packages/engine/draft/late-round-fillers';
import { lineupSlotsFor } from '../../packages/engine/draft/lineup';
import { generateDraftRecommendations } from '../../packages/engine/draft/recommendations';
import type { SupplementalRankingSnapshot } from '../../packages/fantasy-pros/types';
import { deriveDraftBoardState } from '../../packages/engine/draft/state';
import { buildCanonicalPlayerMap } from '../../packages/players/player-map';
import { makeDraft, makeLeague, makeRosters, makeContext, makePlayerPool, makeProjections } from './fixtures';

/** Ten kickers whose alphabetical order is deliberately the reverse of merit. */
const kickers = Object.fromEntries(
  ['Aaron', 'Bruce', 'Colin', 'Dennis', 'Ernie', 'Frank', 'Gary', 'Harold', 'Ivan', 'Jack'].map(
    (first, index) => [
      String(100 + index),
      {
        player_id: String(100 + index),
        full_name: `${first} Kicker`,
        position: 'K',
        team: 'TST',
      },
    ],
  ),
);

const players = buildCanonicalPlayerMap(kickers);
const draft = makeDraft({ teams: 12, rounds: 15 });
const league = makeLeague({ teams: 12 });
const { board } = makeContext({ league, draft, picks: [], rosters: makeRosters(12), players });

/** Round 13 of 15, which is when kickers become offerable. */
const lateBoard = { ...board, currentRound: 13, rounds: 15 };
const slots = lineupSlotsFor({
  QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, SUPER_FLEX: 0, K: 1, DEF: 1,
  bench: 6, taxi: 0, IR: 0, idp: {}, unknown: {}, totalStarterSpots: 9,
});

function shortlist(expertRankOf?: (playerId: string) => number | null) {
  return buildFillerCandidates({
    board: lateBoard,
    slots,
    heldPositions: {},
    alreadyProjected: new Set(),
    expertRankOf,
  }).map((filler) => filler.playerName);
}

describe('kicker and defense shortlist', () => {
  it('only opens in the closing rounds', () => {
    expect(shouldOfferFillers({ ...board, currentRound: 10, rounds: 15 })).toBe(false);
    expect(shouldOfferFillers({ ...board, currentRound: 13, rounds: 15 })).toBe(true);
  });

  it('falls back to alphabetical order with no ranking source - the old behaviour', () => {
    expect(shortlist()).toEqual([
      'Aaron Kicker',
      'Bruce Kicker',
      'Colin Kicker',
      'Dennis Kicker',
      'Ernie Kicker',
      'Frank Kicker',
    ]);
  });

  it('offers the best-ranked kickers when a board says which are best', () => {
    // Merit is the reverse of the alphabet, so a wrong order is unmissable.
    const merit = new Map(
      [...players.players].reverse().map((player, index) => [player.id, index + 1]),
    );
    expect(shortlist((playerId) => merit.get(playerId) ?? null)).toEqual([
      'Jack Kicker',
      'Ivan Kicker',
      'Harold Kicker',
      'Gary Kicker',
      'Frank Kicker',
      'Ernie Kicker',
    ]);
  });

  it('puts an unranked kicker behind every ranked one, then sorts by name', () => {
    const partial = new Map([
      [players.players.find((player) => player.name === 'Jack Kicker')!.id, 1],
      [players.players.find((player) => player.name === 'Ivan Kicker')!.id, 2],
    ]);
    const offered = shortlist((playerId) => partial.get(playerId) ?? null);
    expect(offered.slice(0, 2)).toEqual(['Jack Kicker', 'Ivan Kicker']);
    expect(offered.slice(2)).toEqual([
      'Aaron Kicker',
      'Bruce Kicker',
      'Colin Kicker',
      'Dennis Kicker',
    ]);
    expect(offered).toHaveLength(FILLER_SHORTLIST);
  });

  it('never offers a player who is not eligible to be drafted', () => {
    const withRetired = buildCanonicalPlayerMap({
      ...kickers,
      '999': { player_id: '999', full_name: 'AAA Retired', position: 'K', team: null },
    });
    const state = deriveDraftBoardState(draft, [], [], withRetired);
    const offered = buildFillerCandidates({
      board: { ...state, currentRound: 13, rounds: 15 },
      slots,
      heldPositions: {},
      alreadyProjected: new Set(),
    }).map((filler) => filler.playerName);
    // Alphabetically first, and correctly absent.
    expect(offered).not.toContain('AAA Retired');
  });

  it('offers nothing once the slot is filled', () => {
    expect(
      buildFillerCandidates({
        board: lateBoard,
        slots,
        heldPositions: { K: 1, DEF: 1 },
        alreadyProjected: new Set(),
      }),
    ).toEqual([]);
  });
});


/* ---------------------------- the root cause, through the real engine */

/**
 * WHY THE SAME MEDIOCRE KICKER CAME UP EVERY DRAFT.
 *
 * Two bugs wore the same costume, and fixing the first only made the second
 * visible.
 *
 *   The SHORTLIST was alphabetical, because the player map is sorted by name
 *   and every filler ties on value. That is the one that produced Adam
 *   Vinatieri, and ordering the shortlist off the supplemental board fixed it.
 *
 *   The ORDER INSIDE the shortlist was still decided by `consensusRank`, and
 *   First Seed does not publish kickers - so every kicker carried the same
 *   fallback constant, the engine's last tie-break compared 999 with 999, and
 *   the winner was whichever happened to be first in the array. A shortlist in
 *   merit order went in and the engine reordered it back to arbitrary.
 *
 * This drives the whole engine rather than restating its rule, because what was
 * broken was the interaction between two layers that each looked right alone.
 */
describe('which kicker the engine actually recommends', () => {
  /** Merit is the reverse of alphabetical, so the two orders cannot be confused. */
  const MERIT = ['Jack', 'Ivan', 'Harold', 'Gary', 'Ernie', 'Frank', 'Dennis', 'Colin', 'Bruce', 'Aaron'];

  /** Real players, so the engine runs its normal path, plus the ten kickers. */
  const skill = makePlayerPool(30);
  const pool = buildCanonicalPlayerMap({
    ...Object.fromEntries(
      skill.players.map((player) => [
        player.externalIds.sleeper!,
        {
          player_id: player.externalIds.sleeper!,
          full_name: player.name,
          position: player.position,
          team: 'TST',
        },
      ]),
    ),
    ...kickers,
  });
  const projections = makeProjections(pool).filter(
    (projection) => projection.position !== 'K' && projection.position !== 'DEF',
  );

  /*
   * A league that actually STARTS a kicker and a defense. The default fixture
   * does not, and without those slots there is nothing for a filler to fill -
   * which is its own small lesson about why this bug survived so long.
   */
  const fillerLeague = makeLeague({
    teams: 12,
    rosterPositions: [
      'QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'K', 'DEF',
      'BN', 'BN', 'BN', 'BN', 'BN', 'BN',
    ],
  });

  function boardFor() {
    const rosters = makeRosters(12);
    const { context, board } = makeContext({
      league: fillerLeague,
      draft,
      picks: [],
      rosters,
      players: pool,
    });
    return { context, rosters, board: { ...board, currentRound: 14, rounds: 15 } };
  }

  function supplementalBoard(): SupplementalRankingSnapshot {
    return {
      kind: 'supplemental-ranking',
      provenance: {
        sourceId: 'fantasypros-test',
        sourceLabel: 'FantasyPros 2026 draft rankings (test)',
        season: '2026',
        fetchedAt: '2026-08-01T00:00:00.000Z',
        sourceUpdatedAt: null,
        sourceConfidence: 'high',
      },
      season: '2026',
      positions: ['K', 'DEF'],
      records: MERIT.map((first, index) => {
        const player = pool.byName.get(`${first.toLowerCase()} kicker`)![0];
        return {
          playerId: player.id,
          sleeperId: player.externalIds.sleeper!,
          sourceName: `${first} Kicker`,
          name: player.name,
          team: 'TST',
          position: 'K' as const,
          positionRank: index + 1,
          overallRank: index + 1,
        };
      }),
      unresolved: [],
      resolution: {
        total: MERIT.length,
        matched: MERIT.length,
        directExternalId: MERIT.length,
        exactCanonical: 0,
        normalizedName: 0,
        ambiguous: 0,
        unresolved: 0,
      },
    };
  }

  function kickersRecommended(supplementalRankings: SupplementalRankingSnapshot | null) {
    const { context, rosters, board: late } = boardFor();
    const result = generateDraftRecommendations({
      context,
      picks: [],
      rosters,
      board: late,
      players: pool,
      projections,
      supplementalRankings,
    });
    return result.recommendations
      .filter((recommendation) => recommendation.player.position === 'K')
      .map((recommendation) => recommendation.player.name);
  }

  it('leads with the best-ranked kicker, not the first one alphabetically', () => {
    const ranked = kickersRecommended(supplementalBoard());
    expect(ranked.length).toBeGreaterThan(1);
    // Jack is K1 and LAST alphabetically. Before the fix he was never offered.
    expect(ranked[0]).toBe('Jack Kicker');
    // Aaron is K10 and first alphabetically. He used to be the recommendation;
    // now he does not make the shortlist at all.
    expect(ranked).not.toContain('Aaron Kicker');
  });

  it('orders every offered kicker by the supplemental board', () => {
    const ranked = kickersRecommended(supplementalBoard());
    const byMerit = MERIT.map((first) => `${first} Kicker`).filter((name) => ranked.includes(name));
    /*
     * Not merely "the best one first": the tie-break has to hold all the way
     * down, because that is exactly what was broken. A K4 above a K2 anywhere
     * in this list is the original bug.
     */
    expect(ranked).toEqual(byMerit);
  });

  it('is deterministic with no board, so a draft never depends on iteration order', () => {
    expect(kickersRecommended(null)).toEqual(kickersRecommended(null));
  });
});
