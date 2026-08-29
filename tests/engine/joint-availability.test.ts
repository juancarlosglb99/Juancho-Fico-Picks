/**
 * The joint figures have to BE the simulation, not a story about it.
 *
 * The whole reason this exists is that the strategist inferred a joint claim
 * from marginal numbers - "two TEs cannot both survive" from 10% and 72%. A
 * joint section that itself multiplied marginals would make exactly the same
 * mistake one layer down, with more authority.
 *
 * So these tests check the numbers against the runs that produced them, and
 * against each other: the identities between "both", "either" and "neither"
 * hold arithmetically, and each figure is independently recomputed from the
 * traces rather than from its siblings.
 */
import { describe, expect, it } from 'vitest';
import {
  groupSurvival,
  jointOutcome,
  likelyBestAvailable,
} from '../../packages/engine/draft/joint-availability';
import {
  mulberry32,
  simulateOnce,
  simulateRoom,
  type RoomSimulationInput,
  type SimulationCandidate,
} from '../../packages/engine/draft/room-simulation';
import type { LineupSlots } from '../../packages/engine/draft/lineup';
import type { Position } from '../../packages/players/types';

const SLOTS: LineupSlots = { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 2, SUPER_FLEX: 0, K: 1, DEF: 1 };

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

function input(overrides: Partial<RoomSimulationInput> = {}): RoomSimulationInput {
  return {
    selections: Array.from({ length: 14 }, (_, index) => ({
      overallPick: 100 + index,
      rosterId: (index % 10) + 1,
    })),
    available: board(),
    rosterCounts: new Map(Array.from({ length: 10 }, (_, index) => [index + 1, {}])),
    slots: SLOTS,
    teams: 10,
    totalRounds: 15,
    runs: 300,
    seed: 4242,
    ...overrides,
  };
}

/**
 * Replays the same runs by hand, so the assertions below compare against the
 * traces rather than against the aggregate the code under test produced.
 */
function replayTraces(config: RoomSimulationInput): Set<string>[] {
  const random = mulberry32(config.seed);
  return Array.from({ length: config.runs ?? 300 }, () => {
    const picks = simulateOnce(config, random);
    return new Set(picks.map((pick) => pick.playerId));
  });
}

describe('joint availability comes from the runs', () => {
  it('matches a hand replay of the same simulated futures', () => {
    const config = input();
    const result = simulateRoom(config);
    const traces = replayTraces(config);
    expect(traces).toHaveLength(result.runs);

    const a = 'RB1';
    const b = 'WR2';
    const outcome = jointOutcome(result.outcomes, a, b)!;

    // Counted independently, off the traces, with no reference to the result.
    let both = 0;
    let neither = 0;
    let either = 0;
    let aGone = 0;
    let bAliveWhenAGone = 0;
    for (const taken of traces) {
      const aSurvived = !taken.has(a);
      const bSurvived = !taken.has(b);
      if (aSurvived && bSurvived) both += 1;
      if (!aSurvived && !bSurvived) neither += 1;
      if (aSurvived || bSurvived) either += 1;
      if (!aSurvived) {
        aGone += 1;
        if (bSurvived) bAliveWhenAGone += 1;
      }
    }
    const pct = (count: number) => Math.round((count / traces.length) * 1000) / 10;

    expect(outcome.bothSurvive).toBeCloseTo(pct(both), 1);
    expect(outcome.neitherSurvives).toBeCloseTo(pct(neither), 1);
    expect(outcome.atLeastOneSurvives).toBeCloseTo(pct(either), 1);
    expect(outcome.bSurvivesGivenAGone).toBeCloseTo(
      Math.round((bAliveWhenAGone / aGone) * 1000) / 10,
      1,
    );
  });

  it('agrees with the marginals it sits beside', () => {
    const result = simulateRoom(input());
    for (const [a, b] of [
      ['RB1', 'WR1'],
      ['QB3', 'TE2'],
      ['WR5', 'WR6'],
    ]) {
      const outcome = jointOutcome(result.outcomes, a, b)!;
      expect(outcome.aSurvives).toBeCloseTo(result.survival.get(a)!, 1);
      expect(outcome.bSurvives).toBeCloseTo(result.survival.get(b)!, 1);
    }
  });

  it('satisfies the identities a joint distribution must satisfy', () => {
    const result = simulateRoom(input());
    const candidates = board();
    for (let index = 0; index < 40; index += 1) {
      const a = candidates[index].playerId;
      const b = candidates[(index * 7 + 3) % candidates.length].playerId;
      if (a === b) continue;
      const outcome = jointOutcome(result.outcomes, a, b)!;

      /*
       * P(A or B) = P(A) + P(B) - P(A and B), to within rounding.
       *
       * Each figure is rounded to a tenth before it is reported, and this
       * identity combines three of them, so it can be off by up to about
       * 0.15 without anything being wrong. Tightening the tolerance would only
       * test the rounding.
       */
      expect(
        Math.abs(
          outcome.atLeastOneSurvives -
            (outcome.aSurvives + outcome.bSurvives - outcome.bothSurvive),
        ),
      ).toBeLessThanOrEqual(0.2);
      // P(neither) = 1 - P(A or B)
      expect(Math.abs(outcome.neitherSurvives - (100 - outcome.atLeastOneSurvives)))
        .toBeLessThanOrEqual(0.2);
      // A joint probability can never exceed either marginal.
      expect(outcome.bothSurvive).toBeLessThanOrEqual(outcome.aSurvives + 0.001);
      expect(outcome.bothSurvive).toBeLessThanOrEqual(outcome.bSurvives + 0.001);
    }
  });

  it('is NOT the product of the marginals, which is the whole point', () => {
    /*
     * If the joint numbers matched independence, this section would add nothing
     * over the two figures already on the board.
     *
     * Measured only among CONTESTED players - those the room might plausibly
     * take. A pair of deep bench players both survive in almost every run
     * whatever happens, so independence holds trivially for them and averaging
     * them in just dilutes the signal with cases nobody would ask about.
     *
     * The thresholds are set well inside what the mechanism produces rather
     * than at it: finite picks GUARANTEE some coupling, so the test is that it
     * is detectable, not that it hits a particular size.
     */
    const result = simulateRoom(input());
    const contested = board().filter((candidate) => {
      const survival = result.survival.get(candidate.playerId)!;
      return survival > 5 && survival < 95;
    });
    expect(contested.length).toBeGreaterThan(10);

    const deviations: number[] = [];
    for (let i = 0; i < contested.length; i += 1) {
      for (let j = i + 1; j < contested.length; j += 1) {
        const outcome = jointOutcome(result.outcomes, contested[i].playerId, contested[j].playerId)!;
        const independent = (outcome.aSurvives / 100) * (outcome.bSurvives / 100) * 100;
        deviations.push(outcome.bothSurvive - independent);
      }
    }
    const mean = deviations.reduce((sum, value) => sum + value, 0) / deviations.length;
    const substantial = deviations.filter((value) => Math.abs(value) > 1).length;

    expect(Math.abs(mean), 'joint outcomes should not look independent').toBeGreaterThan(0.25);
    expect(substantial / deviations.length).toBeGreaterThan(0.1);
  });

  it('shows coupling in the conditional, in whichever direction it runs', () => {
    /*
     * Two effects pull opposite ways and neither always wins. Taking one player
     * spends a selection that cannot also take the other, which makes the other
     * SAFER. But a room hungry enough to take the first is a room likely to
     * want the second too, which makes him LESS safe. Asserting a direction
     * here would be asserting which effect dominates in general, and the honest
     * answer is that it depends on the board - which is exactly why this is
     * counted from the runs rather than reasoned about.
     */
    const result = simulateRoom(input());
    const pairs = [
      ['RB1', 'RB2'],
      ['RB1', 'WR8'],
      ['QB2', 'TE1'],
    ] as const;
    const shifts = pairs.map(([a, b]) => {
      const outcome = jointOutcome(result.outcomes, a, b)!;
      return outcome.bSurvivesGivenAGone! - outcome.bSurvives;
    });
    expect(shifts.every((shift) => Number.isFinite(shift))).toBe(true);
    expect(
      shifts.some((shift) => Math.abs(shift) > 0.5),
      'conditioning on one player should move the other',
    ).toBe(true);
  });

  it('returns null rather than guessing about a player it never simulated', () => {
    const result = simulateRoom(input());
    expect(jointOutcome(result.outcomes, 'RB1', 'nobody')).toBeNull();
    expect(jointOutcome(result.outcomes, 'nobody', 'RB1')).toBeNull();
    expect(groupSurvival(result.outcomes, ['nobody'])).toBeNull();
  });

  it('has nothing to condition on when a player always survives', () => {
    const result = simulateRoom(input({ selections: [] }));
    const outcome = jointOutcome(result.outcomes, 'RB1', 'RB2')!;
    expect(outcome.aSurvives).toBe(100);
    expect(outcome.bothSurvive).toBe(100);
    expect(outcome.neitherSurvives).toBe(0);
    expect(outcome.bSurvivesGivenAGone).toBeNull();
  });
});

describe('group and tier survival', () => {
  it('counts a tier from the runs, not from its members multiplied', () => {
    const config = input();
    const result = simulateRoom(config);
    const traces = replayTraces(config);
    const members = ['TE1', 'TE2', 'TE3'];

    const group = groupSurvival(result.outcomes, members)!;
    const anyRuns = traces.filter((taken) =>
      members.some((member) => !taken.has(member)),
    ).length;
    const allRuns = traces.filter((taken) =>
      members.every((member) => !taken.has(member)),
    ).length;
    const total = traces.reduce(
      (sum, taken) => sum + members.filter((member) => !taken.has(member)).length,
      0,
    );

    expect(group.atLeastOne).toBeCloseTo((anyRuns / traces.length) * 100, 1);
    expect(group.allSurvive).toBeCloseTo((allRuns / traces.length) * 100, 1);
    expect(group.expectedSurvivors).toBeCloseTo(total / traces.length, 1);
  });

  it('places a tier between its best member and the sum of its members', () => {
    const result = simulateRoom(input());
    const members = ['WR1', 'WR2', 'WR3'];
    const group = groupSurvival(result.outcomes, members)!;
    const best = Math.max(...members.map((member) => result.survival.get(member)!));
    const sum = members.reduce((total, member) => total + result.survival.get(member)!, 0);

    expect(group.atLeastOne).toBeGreaterThanOrEqual(best - 0.001);
    expect(group.atLeastOne).toBeLessThanOrEqual(Math.min(100, sum) + 0.001);
    expect(group.allSurvive).toBeLessThanOrEqual(group.atLeastOne + 0.001);
  });
});

describe('the simulated next-pick board', () => {
  it('counts how often each player was the best name left', () => {
    const config = input();
    const result = simulateRoom(config);
    const traces = replayTraces(config);
    const ranked = [...config.available].sort((a, b) => a.consensusRank - b.consensusRank);

    const counts = new Map<string, number>();
    for (const taken of traces) {
      const best = ranked.find((candidate) => !taken.has(candidate.playerId));
      if (best) counts.set(best.playerId, (counts.get(best.playerId) ?? 0) + 1);
    }

    for (const entry of likelyBestAvailable(result.outcomes, { limit: 5 })) {
      expect(entry.frequency).toBeCloseTo(
        ((counts.get(entry.playerId) ?? 0) / traces.length) * 100,
        1,
      );
    }
  });

  it('sums to no more than everything, and is ordered by frequency', () => {
    const result = simulateRoom(input());
    const top = likelyBestAvailable(result.outcomes, { limit: 10 });
    expect(top.reduce((sum, entry) => sum + entry.frequency, 0)).toBeLessThanOrEqual(100.5);
    for (let index = 1; index < top.length; index += 1) {
      expect(top[index].frequency).toBeLessThanOrEqual(top[index - 1].frequency);
    }
  });

  it('answers per position as well as overall', () => {
    const result = simulateRoom(input());
    const bestTe = likelyBestAvailable(result.outcomes, { limit: 3, position: 'TE' });
    expect(bestTe.length).toBeGreaterThan(0);
    expect(bestTe.every((entry) => entry.playerId.startsWith('TE'))).toBe(true);
  });

  it('says the top player is always best available when nobody picks', () => {
    const result = simulateRoom(input({ selections: [] }));
    const top = likelyBestAvailable(result.outcomes, { limit: 1 });
    expect(top[0]).toMatchObject({ playerId: 'QB1', frequency: 100 });
  });
});
