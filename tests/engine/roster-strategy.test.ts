import { describe, expect, it } from 'vitest';
import type { LineupPlayer, LineupSlots } from '../../packages/engine/draft/lineup';
import {
  buildRosterConstructionState,
  classifyBuild,
  startingFootprint,
} from '../../packages/engine/draft/roster-state';
import { planRemainingRoster } from '../../packages/engine/draft/roster-plan';
import {
  describeRoomBehavior,
  detectPositionalRuns,
  opponentDemandForPosition,
} from '../../packages/engine/draft/room-behavior';
import type { Position } from '../../packages/players/types';

const CLASSIC: LineupSlots = { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, SUPER_FLEX: 0, K: 0, DEF: 0 };
const SUPERFLEX: LineupSlots = { ...CLASSIC, SUPER_FLEX: 1 };

const player = (id: string, position: Position, projection: number): LineupPlayer => ({
  playerId: id,
  position,
  projection,
});

const state = (players: LineupPlayer[], slots = CLASSIC, picksRemaining = 10) =>
  buildRosterConstructionState({
    rosterPlayers: players,
    slots,
    teams: 12,
    picksRemaining,
    positionalRank: () => 3,
    selectionRounds: [],
  });

describe('startingFootprint', () => {
  it('is one slot for a quarterback in a one-quarterback league', () => {
    expect(startingFootprint('QB', CLASSIC)).toBe(1);
  });

  it('grows in Superflex, which is why the same player is worth more there', () => {
    expect(startingFootprint('QB', SUPERFLEX)).toBeGreaterThan(startingFootprint('QB', CLASSIC));
  });

  it('gives running backs more of the flex slot than tight ends', () => {
    expect(startingFootprint('RB', CLASSIC)).toBeGreaterThan(2);
    expect(startingFootprint('TE', CLASSIC)).toBeLessThan(startingFootprint('RB', CLASSIC));
  });
});

describe('roster construction state', () => {
  it('marks an empty position as a high need', () => {
    const result = state([player('rb1', 'RB', 200)]);
    expect(result.byPosition.QB.depthNeed).toBe('high');
    expect(result.byPosition.QB.drafted).toBe(0);
    expect(result.byPosition.QB.saturation).toBe('none');
  });

  it('marks two missing starters as critical', () => {
    const result = state([player('qb1', 'QB', 300)]);
    expect(result.byPosition.RB.depthNeed).toBe('critical');
  });

  it('saturates a single-slot position as soon as it is filled', () => {
    const result = state([player('qb1', 'QB', 300)]);
    expect(result.byPosition.QB.startersFilled).toBe(1);
    expect(result.byPosition.QB.openStartingSlots).toBe(0);
    expect(['medium', 'high', 'complete']).toContain(result.byPosition.QB.saturation);
  });

  it('reports a surplus at a position as complete saturation', () => {
    const result = state([
      player('qb1', 'QB', 300),
      player('qb2', 'QB', 280),
      player('qb3', 'QB', 260),
    ]);
    expect(result.byPosition.QB.saturation).toBe('complete');
  });

  it('keeps running back open after two, because flex exists', () => {
    const result = state([player('rb1', 'RB', 250), player('rb2', 'RB', 220)]);
    expect(result.byPosition.RB.openStartingSlots).toBeGreaterThan(0);
  });

  it('counts unfilled starting slots and the pressure to fill them', () => {
    const result = state([player('qb1', 'QB', 300)], CLASSIC, 2);
    expect(result.unfilledStarterSlots).toBe(6);
    // Six slots to fill and two picks left is a roster in trouble.
    expect(result.starterDeficitPressure).toBe(4);
  });

  it('names what to target next, weakest starting requirement first', () => {
    const result = state([player('rb1', 'RB', 250), player('rb2', 'RB', 220)]);
    expect(result.strategicPriority[0]).not.toBe('RB');
    expect(result.weaknesses).toContain('WR');
  });
});

describe('build classification', () => {
  const filled = {
    QB: { starterQuality: 'none' },
    TE: { starterQuality: 'none' },
  } as never;

  it('says nothing until a shape exists', () => {
    expect(classifyBuild([{ position: 'RB', round: 1 }], filled)).toBe('undefined');
  });

  it('recognises a running-back-heavy opening', () => {
    expect(
      classifyBuild(
        [
          { position: 'RB', round: 1 },
          { position: 'RB', round: 2 },
          { position: 'RB', round: 3 },
        ],
        filled,
      ),
    ).toBe('rb_heavy');
  });

  it('recognises a Zero-RB opening', () => {
    expect(
      classifyBuild(
        [
          { position: 'WR', round: 1 },
          { position: 'WR', round: 2 },
          { position: 'TE', round: 3 },
        ],
        filled,
      ),
    ).toBe('zero_rb');
  });

  it('recognises Hero RB', () => {
    expect(
      classifyBuild(
        [
          { position: 'RB', round: 1 },
          { position: 'WR', round: 2 },
          { position: 'WR', round: 3 },
        ],
        filled,
      ),
    ).toBe('hero_rb');
  });

  it('recognises an early elite quarterback', () => {
    expect(
      classifyBuild(
        [
          { position: 'RB', round: 1 },
          { position: 'QB', round: 2 },
        ],
        { QB: { starterQuality: 'elite' }, TE: { starterQuality: 'none' } } as never,
      ),
    ).toBe('early_qb');
  });

  it('does not call it an early quarterback build when the quarterback is ordinary', () => {
    expect(
      classifyBuild(
        [
          { position: 'RB', round: 1 },
          { position: 'QB', round: 2 },
          { position: 'RB', round: 3 },
          { position: 'RB', round: 4 },
        ],
        { QB: { starterQuality: 'replacement' }, TE: { starterQuality: 'none' } } as never,
      ),
    ).toBe('rb_heavy');
  });
});

describe('positional runs', () => {
  it('does not call a single pick a run', () => {
    const runs = detectPositionalRuns(['RB', 'WR', 'WR', 'QB', 'WR', 'TE']);
    expect(runs.QB.isRun).toBe(false);
  });

  it('detects a cluster well above the normal rate', () => {
    const runs = detectPositionalRuns(['WR', 'QB', 'QB', 'QB', 'QB', 'WR', 'RB']);
    expect(runs.QB.isRun).toBe(true);
    expect(runs.QB.intensity).toBeGreaterThan(1.7);
  });

  it('needs a real window before judging', () => {
    expect(detectPositionalRuns(['QB', 'QB', 'QB']).QB.isRun).toBe(false);
  });
});

describe('opponent demand', () => {
  const teams = (counts: Partial<Record<Position, number>>[]) =>
    counts.map((entry, index) => ({ rosterId: index + 1, counts: entry }));

  it('counts a team without the position as full demand', () => {
    const { demand, teamsWithNeed } = opponentDemandForPosition({
      position: 'QB',
      interveningTeams: teams([{}, {}, {}]),
      slots: CLASSIC,
    });
    expect(teamsWithNeed).toBe(3);
    expect(demand).toBeCloseTo(3, 1);
  });

  it('all but ignores teams that already have the position filled', () => {
    const { demand, teamsWithNeed } = opponentDemandForPosition({
      position: 'QB',
      interveningTeams: teams([{ QB: 1 }, { QB: 2 }, { QB: 1 }]),
      slots: CLASSIC,
    });
    expect(teamsWithNeed).toBe(0);
    expect(demand).toBeLessThan(0.5);
  });

  it('still sees partial demand where a flex slot could take the position', () => {
    const { demand } = opponentDemandForPosition({
      position: 'RB',
      interveningTeams: teams([{ RB: 2 }, { RB: 2 }]),
      slots: CLASSIC,
    });
    expect(demand).toBeGreaterThan(0.5);
  });

  it('raises demand while a run at that position is underway', () => {
    const runs = detectPositionalRuns(['QB', 'QB', 'QB', 'QB', 'WR', 'RB']);
    const quiet = opponentDemandForPosition({
      position: 'QB',
      interveningTeams: teams([{}, {}]),
      slots: CLASSIC,
    }).demand;
    const during = opponentDemandForPosition({
      position: 'QB',
      interveningTeams: teams([{}, {}]),
      slots: CLASSIC,
      runs,
    }).demand;
    expect(during).toBeGreaterThan(quiet);
  });

  it('assumes average demand for a seat it cannot identify', () => {
    const { demand } = opponentDemandForPosition({
      position: 'WR',
      interveningTeams: [{ rosterId: null, counts: {} }],
      slots: CLASSIC,
    });
    expect(demand).toBeGreaterThan(0);
    expect(demand).toBeLessThan(1);
  });
});

describe('room behaviour', () => {
  it('calls a normal spread balanced', () => {
    const positions: Position[] = [
      'RB', 'WR', 'WR', 'RB', 'WR', 'TE', 'QB', 'WR', 'RB', 'WR', 'RB', 'TE',
    ];
    expect(describeRoomBehavior(positions, positions).tendency).toBe('balanced');
  });

  it('notices a quarterback-hungry room', () => {
    const positions: Position[] = [
      'QB', 'QB', 'QB', 'QB', 'QB', 'RB', 'WR', 'QB', 'WR', 'RB', 'QB', 'WR',
    ];
    expect(describeRoomBehavior(positions, positions).tendency).toBe('qb_aggressive');
  });

  it('waits for enough picks before judging', () => {
    expect(describeRoomBehavior(['QB', 'QB'], ['QB', 'QB']).tendency).toBe('balanced');
  });
});

describe('roster planning', () => {
  const pool = (count: number) =>
    Array.from({ length: count }, (_, index) => {
      const positions: Position[] = ['RB', 'WR', 'QB', 'TE'];
      const position = positions[index % positions.length];
      return {
        playerId: `p${index}`,
        position,
        projection: 300 - index * 2,
        consensusRank: index + 1,
      };
    });

  it('prefers a plan that fills the lineup over one that stacks a position', () => {
    const available = pool(60);
    const quarterback = available.find((entry) => entry.position === 'QB')!;
    const runningBack = available.find((entry) => entry.position === 'RB')!;
    const input = {
      rosterPlayers: [player('qb-owned', 'QB', 320)],
      available,
      ourFuturePicks: [10, 20, 30, 40],
      currentOverallPick: 10,
      lastOverallPick: 120,
      slots: CLASSIC,
    };
    const stacked = planRemainingRoster(input, quarterback);
    const balanced = planRemainingRoster(input, runningBack);
    // We already start a quarterback, so a second cannot improve the lineup and
    // costs us a pick we needed elsewhere.
    expect(balanced.total).toBeGreaterThan(stacked.total);
  });

  it('reports what it expects to end up with', () => {
    const plan = planRemainingRoster({
      rosterPlayers: [],
      available: pool(60),
      ourFuturePicks: [1, 24, 25, 48],
      currentOverallPick: 1,
      lastOverallPick: 120,
      slots: CLASSIC,
    });
    expect(plan.added.length).toBe(4);
    expect(plan.startingValue).toBeGreaterThan(0);
    expect(plan.players.length).toBe(4);
  });

  it('keeps the candidate we are evaluating, even when the room would take him first', () => {
    /*
     * The regression that made First Seed's number one unrecommendable.
     *
     * Sitting at seat three, two selections happen before ours. The simulated
     * room takes the consensus board during those, and the plan then found the
     * player we were asking about already gone - so it wasted our pick and
     * returned a roster one player short. The higher a player's consensus rank,
     * the more reliably this happened to him.
     */
    const available = pool(60);
    const consensusFirst = [...available].sort((a, b) => a.consensusRank - b.consensusRank)[0];
    const plan = planRemainingRoster(
      {
        rosterPlayers: [],
        available,
        // We pick third; picks one and two belong to the room.
        ourFuturePicks: [3, 22, 27],
        currentOverallPick: 1,
        lastOverallPick: 120,
        slots: CLASSIC,
      },
      consensusFirst,
    );

    expect(plan.added.map((entry) => entry.playerId)).toContain(consensusFirst.playerId);
    expect(plan.players.map((entry) => entry.playerId)).toContain(consensusFirst.playerId);
    // Every one of our selections is used, none thrown away.
    expect(plan.added).toHaveLength(3);
  });

  it('does not let the room draft the same player twice', () => {
    const available = pool(60);
    const consensusFirst = [...available].sort((a, b) => a.consensusRank - b.consensusRank)[0];
    const plan = planRemainingRoster(
      {
        rosterPlayers: [],
        available,
        ourFuturePicks: [5, 20],
        currentOverallPick: 1,
        lastOverallPick: 120,
        slots: CLASSIC,
      },
      consensusFirst,
    );
    const ids = plan.players.map((entry) => entry.playerId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('leaves the roster untouched when we have no picks left', () => {
    const plan = planRemainingRoster({
      rosterPlayers: [player('rb1', 'RB', 200)],
      available: pool(20),
      ourFuturePicks: [],
      currentOverallPick: 100,
      lastOverallPick: 120,
      slots: CLASSIC,
    });
    expect(plan.added).toEqual([]);
  });
});
