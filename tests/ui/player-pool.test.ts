import { describe, expect, it } from 'vitest';
import {
  buildPlayerPool,
  countByFilter,
  filterPool,
  sortPool,
  type PoolRow,
} from '../../packages/ui/player-pool';
import { scenario } from './scenario';

const state = scenario({ picksMade: 26 });
const rows = buildPlayerPool(state.result);

describe('available player pool', () => {
  it('covers the whole board, not just the engine shortlist', () => {
    expect(rows.length).toBeGreaterThan(state.result.recommendations.length);
    expect(rows.length).toBe(state.result.internals!.candidatePool.length);
  });

  it('never lists a player who has already been drafted', () => {
    const drafted = new Set(state.picks.map((pick) => pick.player_id));
    const listed = new Set(
      rows.map((row) => state.players.byId.get(row.playerId)?.externalIds.sleeper),
    );
    for (const sleeperId of drafted) expect(listed.has(sleeperId)).toBe(false);
  });

  it('carries the columns the table renders, from the engine itself', () => {
    const top = rows.find((row) => row.engineRank === 1);
    expect(top).toBeTruthy();
    expect(top!.projectedPoints).toBeGreaterThan(0);
    expect(top!.tier).not.toBeNull();
    expect(top!.firstSeedRank).not.toBeNull();
    expect(top!.survival).not.toBeNull();
    expect(top!.fit.need).toBeTruthy();

    // The pool and the recommendation must agree about the same player.
    const recommendation = state.result.recommendations[0];
    expect(top!.playerId).toBe(recommendation.player.id);
    expect(top!.survival).toBe(recommendation.availableNextPickProbability);
    expect(top!.tier).toBe(recommendation.tier);
  });

  it('puts the engine shortlist first by default, then the rest of the board', () => {
    const sorted = sortPool(rows, 'engine');
    expect(sorted[0].engineRank).toBe(1);
    expect(sorted[1].engineRank).toBe(2);
    const firstUnranked = sorted.findIndex((row) => row.engineRank === null);
    expect(firstUnranked).toBe(state.result.recommendations.length);
    // Past the shortlist the order falls back to the published board.
    const tail = sorted.slice(firstUnranked, firstUnranked + 5);
    const ranks = tail.map((row) => row.firstSeedRank ?? Number.MAX_SAFE_INTEGER);
    expect([...ranks].sort((a, b) => a - b)).toEqual(ranks);
  });

  it('sorts survival with the most endangered first, and unknowns last', () => {
    const withUnknown: PoolRow[] = [
      { ...rows[0], survival: 80 },
      { ...rows[1], survival: null },
      { ...rows[2], survival: 12 },
    ];
    expect(sortPool(withUnknown, 'survival').map((row) => row.survival)).toEqual([12, 80, null]);
  });

  it('sorts First Seed rank with unranked players last rather than first', () => {
    const mixed: PoolRow[] = [
      { ...rows[0], firstSeedRank: null },
      { ...rows[1], firstSeedRank: 40 },
      { ...rows[2], firstSeedRank: 4 },
    ];
    expect(sortPool(mixed, 'first_seed').map((row) => row.firstSeedRank)).toEqual([4, 40, null]);
  });

  it('filters by position, treats FLEX as RB/WR/TE, and searches by name and team', () => {
    const receivers = filterPool(rows, { search: '', filter: 'WR', sort: 'engine' });
    expect(receivers.every((row) => row.position === 'WR')).toBe(true);

    const flex = filterPool(rows, { search: '', filter: 'FLEX', sort: 'engine' });
    expect(flex.every((row) => ['RB', 'WR', 'TE'].includes(row.position))).toBe(true);
    expect(flex.some((row) => row.position === 'TE')).toBe(true);
    expect(flex.some((row) => row.position === 'QB')).toBe(false);

    const named = filterPool(rows, { search: rows[0].name, filter: 'ALL', sort: 'engine' });
    expect(named.map((row) => row.playerId)).toContain(rows[0].playerId);

    const byTeam = filterPool(rows, { search: 'tst', filter: 'ALL', sort: 'engine' });
    expect(byTeam.length).toBe(rows.length);
  });

  it('counts each filter so the chips can carry a number', () => {
    const counts = countByFilter(rows);
    expect(counts.ALL).toBe(rows.length);
    expect(counts.FLEX).toBe(counts.RB + counts.WR + counts.TE);
    expect(counts.QB).toBeGreaterThan(0);
  });

  it('shows an overall rank and a positional rank as different things', () => {
    const ranked = rows.find((row) => row.firstSeedRank !== null)!;
    // First Seed publishes an overall board.
    expect(ranked.expertRank).toEqual({
      label: String(ranked.firstSeedRank),
      source: 'First Seed',
    });
    /*
     * A kicker's "K4" must never render as "#4". The supplemental board is
     * positional, and a positional rank shown as an overall one would place a
     * kicker four picks from the top of the draft.
     */
    for (const row of rows) {
      if (row.position !== 'K' && row.position !== 'DEF') continue;
      expect(row.expertRank).not.toBeNull();
      expect(row.expertRank!.label).toMatch(/^(K|DST)\d+$|^Unranked$/);
    }
  });

  it('returns nothing rather than guessing when the engine kept no internals', () => {
    expect(buildPlayerPool({ ...state.result, internals: undefined })).toEqual([]);
  });
});
