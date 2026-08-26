import { describe, expect, it } from 'vitest';
import {
  benchUsabilityFactor,
  evaluateRoster,
  lineupSlotsFor,
  solveBestLineup,
  type LineupPlayer,
  type LineupSlots,
} from '../../packages/engine/draft/lineup';
import { inferBenchSlots, resolvePickRosterId } from '../../packages/engine/draft/pick-ownership';
import type { SleeperDraftPick } from '../../packages/sleeper/types';

const CLASSIC: LineupSlots = {
  QB: 1,
  RB: 2,
  WR: 2,
  TE: 1,
  FLEX: 1,
  SUPER_FLEX: 0,
  K: 0,
  DEF: 0,
};

const SUPERFLEX: LineupSlots = { ...CLASSIC, SUPER_FLEX: 1 };

function player(id: string, position: LineupPlayer['position'], projection: number): LineupPlayer {
  return { playerId: id, position, projection };
}

describe('solveBestLineup', () => {
  it('fills dedicated slots before flex', () => {
    const lineup = solveBestLineup(
      [
        player('qb1', 'QB', 300),
        player('rb1', 'RB', 250),
        player('rb2', 'RB', 200),
        player('rb3', 'RB', 190),
        player('wr1', 'WR', 240),
        player('wr2', 'WR', 220),
        player('te1', 'TE', 150),
      ],
      CLASSIC,
    );
    expect(lineup.starters).toHaveLength(7);
    // The third back is the best remaining flex option.
    expect(lineup.starters.map((entry) => entry.playerId)).toContain('rb3');
    expect(lineup.total).toBe(1550);
    expect(lineup.unfilled).toEqual([]);
  });

  it('reports slots it could not fill', () => {
    const lineup = solveBestLineup([player('qb1', 'QB', 300)], CLASSIC);
    expect(lineup.starters).toHaveLength(1);
    const unfilledCount = lineup.unfilled.reduce((sum, entry) => sum + entry.count, 0);
    expect(unfilledCount).toBe(6);
  });

  it('starts a tight end in flex when he genuinely outscores the alternatives', () => {
    const lineup = solveBestLineup(
      [
        player('qb1', 'QB', 300),
        player('rb1', 'RB', 250),
        player('rb2', 'RB', 200),
        player('wr1', 'WR', 240),
        player('wr2', 'WR', 220),
        player('te1', 'TE', 210),
        player('te2', 'TE', 205),
        player('rb3', 'RB', 60),
      ],
      CLASSIC,
    );
    expect(lineup.starters.map((entry) => entry.playerId)).toContain('te2');
    expect(lineup.starters.map((entry) => entry.playerId)).not.toContain('rb3');
  });

  it('lets a quarterback fill a superflex slot', () => {
    const lineup = solveBestLineup(
      [
        player('qb1', 'QB', 320),
        player('qb2', 'QB', 300),
        player('rb1', 'RB', 250),
        player('rb2', 'RB', 200),
        player('wr1', 'WR', 240),
        player('wr2', 'WR', 220),
        player('te1', 'TE', 150),
        player('rb3', 'RB', 120),
      ],
      SUPERFLEX,
    );
    expect(lineup.starters.map((entry) => entry.playerId)).toContain('qb2');
  });
});

describe('benchUsabilityFactor', () => {
  it('gives a single-slot position exactly one useful backup', () => {
    const first = benchUsabilityFactor({
      position: 'QB',
      depthIndexAtPosition: 0,
      slots: CLASSIC,
    });
    const second = benchUsabilityFactor({
      position: 'QB',
      depthIndexAtPosition: 1,
      slots: CLASSIC,
    });
    expect(first).toBeGreaterThan(0);
    // A third quarterback in a 1QB league can never enter the lineup.
    expect(second).toBe(0);
  });

  it('treats a third tight end as worthless too', () => {
    expect(
      benchUsabilityFactor({ position: 'TE', depthIndexAtPosition: 1, slots: CLASSIC }),
    ).toBe(0);
  });

  it('keeps depth valuable at running back and receiver', () => {
    for (const position of ['RB', 'WR'] as const) {
      const third = benchUsabilityFactor({
        position,
        depthIndexAtPosition: 2,
        slots: CLASSIC,
      });
      expect(third, `${position} depth`).toBeGreaterThan(0);
    }
  });

  it('values a backup quarterback more when Superflex gives him somewhere to play', () => {
    const oneQb = benchUsabilityFactor({
      position: 'QB',
      depthIndexAtPosition: 1,
      slots: CLASSIC,
    });
    const superflex = benchUsabilityFactor({
      position: 'QB',
      depthIndexAtPosition: 1,
      slots: SUPERFLEX,
    });
    expect(superflex).toBeGreaterThan(oneQb);
  });
});

describe('evaluateRoster', () => {
  it('does not reward stacking a position that cannot be started', () => {
    const base = [
      player('qb1', 'QB', 320),
      player('rb1', 'RB', 250),
      player('rb2', 'RB', 200),
      player('wr1', 'WR', 240),
      player('wr2', 'WR', 220),
      player('te1', 'TE', 150),
      player('rb3', 'RB', 180),
    ];
    const withThirdQb = evaluateRoster([...base, player('qb3', 'QB', 300)], CLASSIC);
    const withFourthReceiver = evaluateRoster([...base, player('wr4', 'WR', 150)], CLASSIC);

    // The quarterback projects twice what the receiver does and is still worth
    // less, because he has nowhere to play.
    expect(withThirdQb.startingValue).toBe(withFourthReceiver.startingValue);
    expect(withFourthReceiver.total).toBeGreaterThan(withThirdQb.total);
  });

  it('penalizes a roster that cannot field a lineup', () => {
    const incomplete = evaluateRoster([player('qb1', 'QB', 320)], CLASSIC);
    expect(incomplete.unfilledSlots).toBe(6);
    expect(incomplete.total).toBeLessThan(0);
  });

  it('counts flex starters, which the old simulation ignored entirely', () => {
    const withoutFlex = evaluateRoster(
      [
        player('qb1', 'QB', 320),
        player('rb1', 'RB', 250),
        player('rb2', 'RB', 200),
        player('wr1', 'WR', 240),
        player('wr2', 'WR', 220),
        player('te1', 'TE', 150),
      ],
      CLASSIC,
    );
    const withFlex = evaluateRoster(
      [
        player('qb1', 'QB', 320),
        player('rb1', 'RB', 250),
        player('rb2', 'RB', 200),
        player('wr1', 'WR', 240),
        player('wr2', 'WR', 220),
        player('te1', 'TE', 150),
        player('rb3', 'RB', 180),
      ],
      CLASSIC,
    );
    expect(withFlex.startingValue - withoutFlex.startingValue).toBe(180);
  });
});

describe('lineupSlotsFor', () => {
  it('reads the normalized roster configuration', () => {
    const slots = lineupSlotsFor({
      QB: 1,
      RB: 2,
      WR: 3,
      TE: 1,
      FLEX: 2,
      SUPER_FLEX: 1,
      K: 1,
      DEF: 1,
      bench: 6,
      taxi: 0,
      IR: 0,
      idp: {},
      unknown: {},
      totalStarterSpots: 12,
    });
    expect(slots).toEqual({ QB: 1, RB: 2, WR: 3, TE: 1, FLEX: 2, SUPER_FLEX: 1, K: 1, DEF: 1 });
  });
});

describe('pick ownership', () => {
  const pick = (overrides: Partial<SleeperDraftPick>): SleeperDraftPick => ({
    player_id: '1',
    picked_by: '',
    roster_id: null as unknown as string,
    round: 1,
    draft_slot: 4,
    pick_no: 4,
    metadata: {},
    ...overrides,
  });

  it('uses roster_id when a league draft supplies one', () => {
    expect(resolvePickRosterId(pick({ roster_id: '7' }), { '4': 9 })).toBe(7);
  });

  it('falls back to the draft slot when a mock supplies no roster id', () => {
    expect(resolvePickRosterId(pick({}), { '4': 9 })).toBe(9);
  });

  it('uses the slot itself when there is no slot map', () => {
    expect(resolvePickRosterId(pick({}), null)).toBe(4);
  });

  it('treats an empty string roster id as missing', () => {
    expect(resolvePickRosterId(pick({ roster_id: '' }), { '4': 3 })).toBe(3);
  });
});

describe('inferBenchSlots', () => {
  it('keeps an explicit bench count', () => {
    expect(inferBenchSlots({ explicitBench: 6, rounds: 15, totalStarterSpots: 9 })).toBe(6);
  });

  it('derives bench from rounds when a mock draft reports none', () => {
    expect(inferBenchSlots({ explicitBench: 0, rounds: 15, totalStarterSpots: 10 })).toBe(5);
  });

  it('never returns a negative bench', () => {
    expect(inferBenchSlots({ explicitBench: 0, rounds: 8, totalStarterSpots: 10 })).toBe(0);
  });
});
