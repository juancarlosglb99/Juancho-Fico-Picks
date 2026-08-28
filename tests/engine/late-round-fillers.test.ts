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
import { deriveDraftBoardState } from '../../packages/engine/draft/state';
import { buildCanonicalPlayerMap } from '../../packages/players/player-map';
import { makeDraft, makeLeague, makeRosters, makeContext } from './fixtures';

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
