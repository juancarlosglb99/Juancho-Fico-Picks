import { describe, expect, it } from 'vitest';
import {
  findNextUserSelection,
  probabilityAvailableAtNextPick,
  slotForOverallPick,
} from '../../packages/engine/draft/next-pick-probability';

describe('snake draft pick sequencing', () => {
  it('reverses draft slots in even rounds', () => {
    expect([1, 2, 3, 4].map((pick) => slotForOverallPick(pick, 4, 'snake'))).toEqual([
      1, 2, 3, 4,
    ]);
    expect([5, 6, 7, 8].map((pick) => slotForOverallPick(pick, 4, 'snake'))).toEqual([
      4, 3, 2, 1,
    ]);
  });

  it('finds the following selection when the user is currently on the clock', () => {
    expect(findNextUserSelection(1, 4, 10, 'snake', 1)).toBe(8);
    expect(findNextUserSelection(5, 4, 10, 'snake', 1)).toBe(8);
  });
});

describe('next-pick availability', () => {
  it('makes an early-ADP player less likely to survive than a later-ADP player', () => {
    const early = probabilityAvailableAtNextPick({
      adp: 5,
      currentOverallPick: 5,
      nextUserPick: 12,
      interveningDemand: 2,
      position: 'WR',
    });
    const late = probabilityAvailableAtNextPick({
      adp: 30,
      currentOverallPick: 5,
      nextUserPick: 12,
      interveningDemand: 2,
      position: 'RB',
    });

    expect(early).toBeLessThan(late);
    expect(early).toBeGreaterThanOrEqual(0);
    expect(late).toBeLessThanOrEqual(100);
  });

  it('reduces survival probability when intervening teams need the position', () => {
    const neutral = probabilityAvailableAtNextPick({
      adp: 18,
      currentOverallPick: 8,
      nextUserPick: 16,
      interveningDemand: 0,
      position: 'WR',
    });
    const demand = probabilityAvailableAtNextPick({
      adp: 18,
      currentOverallPick: 8,
      nextUserPick: 16,
      interveningDemand: 5,
      position: 'WR',
    });
    expect(demand).toBeLessThan(neutral);
  });
});
