/**
 * The properties the availability model must hold by construction.
 *
 * The model it replaced was not slightly miscalibrated - it described drafts
 * that cannot happen, expecting sixty-two departures across eighteen picks. The
 * point of simulating the selections rather than each player independently is
 * that the constraint stops being something to check and starts being something
 * that cannot be violated. These tests confirm that is actually true.
 */
import { describe, expect, it } from 'vitest';
import {
  appetiteFor,
  mulberry32,
  simulateOnce,
  simulateRoom,
  type RoomSimulationInput,
  type SimulationCandidate,
} from '../../packages/engine/draft/room-simulation';
import type { LineupSlots } from '../../packages/engine/draft/lineup';
import type { Position } from '../../packages/players/types';

const SLOTS: LineupSlots = { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 2, SUPER_FLEX: 0, K: 1, DEF: 1 };

/** A board of `count` players per position, interleaved so ranks are mixed. */
function board(count = 30): SimulationCandidate[] {
  const positions: Position[] = ['QB', 'RB', 'WR', 'TE'];
  const candidates: SimulationCandidate[] = [];
  let rank = 1;
  for (let index = 0; index < count; index += 1) {
    for (const position of positions) {
      candidates.push({ playerId: `${position}${index + 1}`, position, consensusRank: rank++ });
    }
  }
  return candidates;
}

function selections(count: number, rosterIds?: (number | null)[]) {
  return Array.from({ length: count }, (_, index) => ({
    overallPick: 100 + index,
    rosterId: rosterIds ? rosterIds[index % rosterIds.length] : (index % 10) + 1,
  }));
}

function input(overrides: Partial<RoomSimulationInput> = {}): RoomSimulationInput {
  return {
    selections: selections(12),
    available: board(),
    rosterCounts: new Map(Array.from({ length: 10 }, (_, index) => [index + 1, {}])),
    slots: SLOTS,
    teams: 10,
    totalRounds: 15,
    runs: 200,
    seed: 12345,
    ...overrides,
  };
}

/* --------------------------------------------------- one player per selection */

describe('exactly one player leaves per selection', () => {
  it('makes as many picks as there are selections', () => {
    for (const count of [1, 5, 12, 18, 30]) {
      const picks = simulateOnce(input({ selections: selections(count) }), mulberry32(7));
      expect(picks, `${count} selections`).toHaveLength(count);
    }
  });

  it('never selects the same player twice', () => {
    for (let seed = 1; seed <= 25; seed += 1) {
      const picks = simulateOnce(input({ selections: selections(30) }), mulberry32(seed));
      expect(new Set(picks.map((pick) => pick.playerId)).size).toBe(picks.length);
    }
  });

  it('cannot expect more departures than there are picks', () => {
    /*
     * The failure that prompted the rewrite, checked directly. Summing
     * (1 - survival) across the whole board is the model's expected number of
     * departures, and it must equal the number of selections - not approximately,
     * but exactly, because each run removes exactly one player per selection.
     */
    for (const count of [2, 8, 18]) {
      const result = simulateRoom(input({ selections: selections(count) }));
      const expectedDepartures = [...result.survival.values()].reduce(
        (sum, survival) => sum + (100 - survival) / 100,
        0,
      );
      expect(expectedDepartures, `${count} selections`).toBeCloseTo(count, 1);
    }
  });

  it('holds even when the board is barely deeper than the selections', () => {
    const tiny = board(3); // twelve players
    const result = simulateRoom(input({ available: tiny, selections: selections(10) }));
    const expectedDepartures = [...result.survival.values()].reduce(
      (sum, survival) => sum + (100 - survival) / 100,
      0,
    );
    expect(expectedDepartures).toBeCloseTo(10, 1);
  });
});

/* -------------------------------------------------- sequential roster updates */

describe('a team knows what it just drafted', () => {
  it('updates its roster before its next selection', () => {
    // One team taking every pick: by the end it must hold one of each player it
    // took, which is only possible if its own state carried forward.
    const picks = simulateOnce(
      input({ selections: selections(8, [4]), runs: 1 }),
      mulberry32(3),
    );
    expect(picks.every((pick) => pick.rosterId === 4)).toBe(true);
    expect(new Set(picks.map((pick) => pick.playerId)).size).toBe(8);
  });

  it('stops wanting a quarterback once it has one, in a one-QB league', () => {
    /*
     * The concrete behaviour the old model could not express. A team picking
     * repeatedly should take at most a couple of quarterbacks across many
     * selections, because after the first its appetite collapses - not because
     * quarterbacks became less likely for everybody at once.
     */
    const runs = 200;
    let totalQbs = 0;
    for (let seed = 1; seed <= runs; seed += 1) {
      const picks = simulateOnce(input({ selections: selections(10, [4]) }), mulberry32(seed));
      totalQbs += picks.filter((pick) => pick.position === 'QB').length;
    }
    const meanQbs = totalQbs / runs;
    expect(meanQbs, 'a single team should not hoard quarterbacks').toBeLessThan(2.2);
  });

  it('charges a team that already has a quarterback far less appetite for another', () => {
    const empty = new Map<Position, number>();
    const hasOne = new Map<Position, number>([['QB', 1]]);
    const hasTwo = new Map<Position, number>([['QB', 2]]);

    const withNone = appetiteFor('QB', empty, SLOTS, false);
    const withOne = appetiteFor('QB', hasOne, SLOTS, false);
    const withTwo = appetiteFor('QB', hasTwo, SLOTS, false);

    expect(withOne).toBeLessThan(withNone);
    expect(withTwo).toBeLessThan(withOne);
    // A third quarterback in a one-quarterback league can never play.
    expect(withTwo).toBeLessThanOrEqual(0.05);
  });

  it('still wants running backs after two, because a flex can start one', () => {
    const twoBacks = new Map<Position, number>([['RB', 2]]);
    expect(appetiteFor('RB', twoBacks, SLOTS, false)).toBeGreaterThan(
      appetiteFor('QB', new Map([['QB', 2]]), SLOTS, false),
    );
  });

  it('takes a needed kicker only once the closing rounds arrive', () => {
    const none = new Map<Position, number>();
    expect(appetiteFor('K', none, SLOTS, false)).toBeLessThan(0.05);
    expect(appetiteFor('K', none, SLOTS, true)).toBeGreaterThan(1);
    expect(appetiteFor('K', new Map([['K', 1]]), SLOTS, true)).toBeLessThan(0.05);
  });

  it('treats an unknown seat as an average team rather than as no team', () => {
    const picks = simulateOnce(
      input({ selections: selections(6, [null]), runs: 1 }),
      mulberry32(11),
    );
    expect(picks).toHaveLength(6);
  });
});

/* --------------------------------------------------------------- monotonicity */

describe('survival behaves the way availability has to', () => {
  it('is exactly 100% when nobody picks in between', () => {
    const result = simulateRoom(input({ selections: [] }));
    expect(result.selectionsSimulated).toBe(0);
    expect([...result.survival.values()].every((value) => value === 100)).toBe(true);
  });

  it('gives higher-ranked players lower survival, all else equal', () => {
    // One position only, so appetite is identical and rank is the only variable.
    const onePosition: SimulationCandidate[] = Array.from({ length: 40 }, (_, index) => ({
      playerId: `RB${index + 1}`,
      position: 'RB' as Position,
      consensusRank: index + 1,
    }));
    const result = simulateRoom(input({ available: onePosition, selections: selections(10) }));

    const survivals = onePosition.map((candidate) => result.survival.get(candidate.playerId)!);
    // Not strictly monotone - it is a sample - but the trend must be unambiguous.
    expect(survivals[0]).toBeLessThan(survivals[10]);
    expect(survivals[10]).toBeLessThan(survivals[30]);
    expect(survivals[0]).toBeLessThan(20);
    expect(survivals[39]).toBeGreaterThan(80);
  });

  it('never raises survival when more selections intervene', () => {
    const available = board();
    const shorter = simulateRoom(input({ available, selections: selections(4) }));
    const longer = simulateRoom(input({ available, selections: selections(16) }));

    for (const candidate of available) {
      expect(
        longer.survival.get(candidate.playerId)!,
        `${candidate.playerId} survived more over a longer gap`,
      ).toBeLessThanOrEqual(shorter.survival.get(candidate.playerId)! + 0.001);
    }
  });

  it('decreases monotonically as the gap grows', () => {
    const available = board();
    const top = available[0].playerId;
    const survivals = [2, 6, 12, 20, 30].map(
      (count) => simulateRoom(input({ available, selections: selections(count) })).survival.get(top)!,
    );
    for (let index = 1; index < survivals.length; index += 1) {
      expect(survivals[index]).toBeLessThanOrEqual(survivals[index - 1]);
    }
  });
});

/* ------------------------------------------------------------------ stability */

describe('the same board always gives the same answer', () => {
  it('is deterministic for a fixed seed', () => {
    const first = simulateRoom(input());
    const second = simulateRoom(input());
    expect([...first.survival.entries()]).toEqual([...second.survival.entries()]);
  });

  it('produces a different future from a different seed', () => {
    const a = simulateOnce(input(), mulberry32(1));
    const b = simulateOnce(input(), mulberry32(2));
    expect(a.map((pick) => pick.playerId)).not.toEqual(b.map((pick) => pick.playerId));
  });

  it('records which selection took each player', () => {
    const picks = simulateOnce(input({ selections: selections(5) }), mulberry32(9));
    expect(picks.map((pick) => pick.overallPick)).toEqual([100, 101, 102, 103, 104]);
  });
});

/* ------------------------------------------------------- runs emerge, not applied */

describe('positional runs emerge from need rather than being imposed', () => {
  it('empties a position faster when the teams ahead all need it', () => {
    /*
     * Nothing in the model says "there is a run on tight ends". The effect has
     * to fall out of who needs what - which is the difference between a run
     * being modelled and a run being asserted.
     */
    const teamsNeedingTe = new Map<number, Partial<Record<Position, number>>>(
      Array.from({ length: 10 }, (_, index) => [index + 1, { QB: 1, RB: 3, WR: 3 }]),
    );
    const teamsWithTe = new Map<number, Partial<Record<Position, number>>>(
      Array.from({ length: 10 }, (_, index) => [index + 1, { QB: 1, RB: 3, WR: 3, TE: 1 }]),
    );

    const hungry = simulateRoom(input({ rosterCounts: teamsNeedingTe, selections: selections(10) }));
    const sated = simulateRoom(input({ rosterCounts: teamsWithTe, selections: selections(10) }));

    const teSurvival = (result: typeof hungry) =>
      ['TE1', 'TE2', 'TE3', 'TE4'].reduce(
        (sum, id) => sum + (result.survival.get(id) ?? 100),
        0,
      ) / 4;

    expect(teSurvival(hungry)).toBeLessThan(teSurvival(sated));
  });
});
