/**
 * Selections left against slots still owed.
 *
 * A draft ends with a fixed number of picks and a fixed number of compulsory
 * slots, and the gap between them is the whole budget for optional depth. At
 * pick 132 of a saved mock that budget was one, the strategist spent it on a
 * receiver who could never start, and the reason it looked free was that the
 * room simulation had every defense surviving with certainty.
 *
 * Nothing here knows what round it is. "Take a defense in round 14" is right in
 * one league and wrong in the next; "you have two picks and two empty
 * compulsory slots" is right in all of them.
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

/** A closing-round board: ranked skill players plus unranked kickers/defenses. */
function lateBoard(): SimulationCandidate[] {
  const candidates: SimulationCandidate[] = [];
  let rank = 1;
  for (let index = 0; index < 20; index += 1) {
    for (const position of ['RB', 'WR'] as Position[]) {
      candidates.push({ playerId: `${position}${index + 1}`, position, consensusRank: rank++ });
    }
  }
  // Unranked, exactly as First Seed leaves them: past the end of the board.
  for (let index = 0; index < 6; index += 1) {
    candidates.push({ playerId: `K${index + 1}`, position: 'K', consensusRank: 500 });
    candidates.push({ playerId: `DEF${index + 1}`, position: 'DEF', consensusRank: 500 });
  }
  return candidates;
}

/** Teams holding `held` players each, none with a kicker or defense yet. */
function roomHolding(held: number) {
  return new Map(
    Array.from({ length: 10 }, (_, index) => [
      index + 1,
      { RB: Math.ceil(held / 2), WR: Math.floor(held / 2) } as Partial<Record<Position, number>>,
    ]),
  );
}

function input(overrides: Partial<RoomSimulationInput> = {}): RoomSimulationInput {
  return {
    selections: Array.from({ length: 16 }, (_, index) => ({
      overallPick: 133 + index,
      rosterId: (index % 8) + 1,
    })),
    available: lateBoard(),
    rosterCounts: roomHolding(13),
    slots: SLOTS,
    teams: 10,
    totalRounds: 15,
    runs: 300,
    seed: 777,
    ...overrides,
  };
}

describe('opponents fill compulsory slots when the arithmetic makes them', () => {
  it('does not leave every defense untouched across sixteen closing picks', () => {
    /*
     * The bug this replaces: unranked players sit past the end of the board and
     * never survived the top-40 walk, so no kicker or defense could ever be
     * chosen and all of them reported 100% survival.
     */
    const result = simulateRoom(input());
    const defenses = ['DEF1', 'DEF2', 'DEF3'].map((id) => result.survival.get(id)!);
    expect(Math.min(...defenses), 'a needed defense must be reachable').toBeLessThan(95);
  });

  it('postpones them while a team still has room, and takes them when it does not', () => {
    // Same board, same picks; only how many players each team already holds.
    const roomy = simulateRoom(input({ rosterCounts: roomHolding(8) }));
    const tight = simulateRoom(input({ rosterCounts: roomHolding(13) }));

    const defenceSurvival = (result: typeof roomy) =>
      ['DEF1', 'DEF2', 'DEF3', 'DEF4'].reduce(
        (sum, id) => sum + result.survival.get(id)!,
        0,
      ) / 4;

    expect(defenceSurvival(tight)).toBeLessThan(defenceSurvival(roomy));
  });

  it('reads appetite from the team\'s own budget, not from the round', () => {
    const held = new Map<Position, number>([['RB', 7], ['WR', 6]]);
    // Two compulsory slots owed. With five picks left they can wait; with two
    // they cannot.
    const roomy = appetiteFor('DEF', held, SLOTS, true, 5);
    const forced = appetiteFor('DEF', held, SLOTS, true, 2);
    expect(forced).toBeGreaterThan(roomy);
    expect(roomy).toBeLessThan(1);
  });

  it('still never takes one before the closing rounds', () => {
    const held = new Map<Position, number>();
    expect(appetiteFor('K', held, SLOTS, false, 2)).toBeLessThan(0.05);
  });

  it('never wants a second one', () => {
    const held = new Map<Position, number>([['K', 1], ['RB', 7], ['WR', 5]]);
    expect(appetiteFor('K', held, SLOTS, true, 1)).toBeLessThan(0.05);
  });

  it('keeps exactly one player leaving per selection', () => {
    // The property the whole model rests on, re-checked now that unranked
    // players can be chosen.
    const picks = simulateOnce(input(), mulberry32(5));
    expect(picks).toHaveLength(16);
    expect(new Set(picks.map((pick) => pick.playerId)).size).toBe(16);
  });

  it('takes kickers and defenses without flooding the board with them', () => {
    let kd = 0;
    const runs = 100;
    for (let seed = 1; seed <= runs; seed += 1) {
      kd += simulateOnce(input(), mulberry32(seed)).filter((pick) =>
        ['K', 'DEF'].includes(pick.position),
      ).length;
    }
    const perRun = kd / runs;
    // Eight teams, two picks each, most owing both slots: a handful, not all.
    expect(perRun).toBeGreaterThan(1);
    expect(perRun).toBeLessThan(14);
  });
});
