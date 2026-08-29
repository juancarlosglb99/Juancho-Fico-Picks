/**
 * The acceptance test for the whole engine: if a person follows recommendation
 * #1 every single round, do they finish with a team that makes sense?
 *
 * This is deliberately the harshest possible use of the model. Every pick is
 * made by the engine with no human judgement correcting it, so any tendency to
 * over-weight a position compounds for fifteen rounds instead of being noticed
 * and ignored. That is exactly how a real draft produced nine quarterbacks.
 */
import { describe, expect, it } from 'vitest';
import { autodraftWithRecommendationOne } from '../../packages/engine/mock/autodraft';
import type { Position } from '../../packages/players/types';
import { makeDraft, makeLeague, makePlayerPool, makeProjections, makeRosters } from './fixtures';

type Format = {
  label: string;
  teams: number;
  rounds: number;
  rosterPositions: string[];
  slots: Record<string, number>;
};

const CLASSIC_1QB: Format = {
  label: '12-team 1QB',
  teams: 12,
  rounds: 15,
  rosterPositions: ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', ...Array(8).fill('BN')],
  slots: { slots_qb: 1, slots_rb: 2, slots_wr: 2, slots_te: 1, slots_flex: 1, slots_bn: 8 },
};

const TEN_TEAM_1QB: Format = {
  label: '10-team 1QB',
  teams: 10,
  rounds: 15,
  rosterPositions: ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', ...Array(8).fill('BN')],
  slots: { slots_qb: 1, slots_rb: 2, slots_wr: 2, slots_te: 1, slots_flex: 1, slots_bn: 8 },
};

const SUPERFLEX: Format = {
  label: '12-team Superflex',
  teams: 12,
  rounds: 15,
  rosterPositions: [
    'QB',
    'RB',
    'RB',
    'WR',
    'WR',
    'TE',
    'FLEX',
    'SUPER_FLEX',
    ...Array(7).fill('BN'),
  ],
  slots: {
    slots_qb: 1,
    slots_rb: 2,
    slots_wr: 2,
    slots_te: 1,
    slots_flex: 1,
    slots_super_flex: 1,
    slots_bn: 7,
  },
};

function run(
  format: Format,
  userSlot: number,
  forcedOpeningPositions: Position[] = [],
) {
  const players = makePlayerPool(70);
  const projections = makeProjections(players);
  const league = makeLeague({ teams: format.teams, rosterPositions: format.rosterPositions });
  const draft = makeDraft({
    teams: format.teams,
    rounds: format.rounds,
    settings: format.slots,
  });
  const rosters = makeRosters(format.teams);
  return autodraftWithRecommendationOne({
    league,
    draft,
    rosters,
    players,
    projections,
    userSlot,
    userId: `user-${userSlot}`,
    forcedOpeningPositions,
  });
}

const counts = (result: ReturnType<typeof run>) => ({
  QB: result.userPositionCounts.QB ?? 0,
  RB: result.userPositionCounts.RB ?? 0,
  WR: result.userPositionCounts.WR ?? 0,
  TE: result.userPositionCounts.TE ?? 0,
});

describe('following recommendation #1 for an entire draft', () => {
  describe.each([
    { format: CLASSIC_1QB, slots: [1, 6, 12] },
    { format: TEN_TEAM_1QB, slots: [1, 5, 10] },
  ])('$format.label', ({ format, slots }) => {
    it.each(slots)('builds a startable roster from slot %i', (userSlot) => {
      const result = run(format, userSlot);
      const roster = counts(result);

      // Every required starting slot can actually be filled.
      expect(roster.QB).toBeGreaterThanOrEqual(1);
      expect(roster.RB).toBeGreaterThanOrEqual(2);
      expect(roster.WR).toBeGreaterThanOrEqual(2);
      expect(roster.TE).toBeGreaterThanOrEqual(1);

      // And nothing is hoarded. This is the regression that matters: a 1QB
      // league has exactly one place to put a quarterback.
      expect(roster.QB).toBeLessThanOrEqual(2);
      expect(roster.TE).toBeLessThanOrEqual(2);

      // Running backs and receivers are where depth genuinely belongs.
      expect(roster.RB + roster.WR).toBeGreaterThanOrEqual(format.rounds - 6);

      // Nobody is drafted twice.
      const ids = result.userPicks.map((pick) => pick.playerId);
      expect(new Set(ids).size).toBe(ids.length);
    });
  });

  it.each([1, 6, 12])('wants a second quarterback in Superflex from slot %i', (userSlot) => {
    // Superflex has somewhere to put a second quarterback, and quarterbacks are
    // the scarcest position in that format - roughly two per team exist. Ending
    // with one means the superflex slot is holding a much weaker player all
    // season, which is exactly what the late seat used to do.
    const superflex = counts(run(SUPERFLEX, userSlot));
    expect(superflex.QB).toBeGreaterThanOrEqual(2);
  });

  it('does not want a second quarterback in a one-quarterback league', () => {
    expect(counts(run(CLASSIC_1QB, 3)).QB).toBeLessThanOrEqual(2);
  });

  it('never leaves a required starting slot empty in any format or seat', () => {
    for (const format of [CLASSIC_1QB, TEN_TEAM_1QB, SUPERFLEX]) {
      for (const userSlot of [1, Math.ceil(format.teams / 2), format.teams]) {
        const roster = counts(run(format, userSlot));
        expect({ format: format.label, userSlot, ...roster }).toMatchObject({
          QB: expect.any(Number),
        });
        expect(roster.QB, `${format.label} slot ${userSlot} QB`).toBeGreaterThanOrEqual(1);
        expect(roster.RB, `${format.label} slot ${userSlot} RB`).toBeGreaterThanOrEqual(2);
        expect(roster.WR, `${format.label} slot ${userSlot} WR`).toBeGreaterThanOrEqual(2);
        expect(roster.TE, `${format.label} slot ${userSlot} TE`).toBeGreaterThanOrEqual(1);
      }
    }
    /*
     * Nine complete autodrafts in a single test - three formats by three seats.
     * That fits inside the default five seconds on a developer machine and took
     * 6.6s on a shared CI runner, where it failed the suite without anything
     * being wrong with it. The work is the point of the test, so give it room
     * rather than shrink what it covers. 20s matches vitest.smoke.config.ts.
     */
  }, 20_000);
});

describe('finishing a roster it did not choose to start', () => {
  const openings: { label: string; opening: Position[] }[] = [
    { label: 'RB-heavy', opening: ['RB', 'RB', 'WR', 'RB'] },
    { label: 'Zero-RB', opening: ['WR', 'WR', 'TE', 'WR'] },
    { label: 'Hero-RB', opening: ['RB', 'WR', 'WR', 'WR'] },
    { label: 'early TE', opening: ['WR', 'TE', 'RB'] },
    { label: 'early QB', opening: ['RB', 'QB', 'WR'] },
  ];

  it.each(openings)('completes a $label opening sensibly', ({ opening }) => {
    const result = run(CLASSIC_1QB, 4, opening);
    const roster = counts(result);

    expect(roster.QB).toBeGreaterThanOrEqual(1);
    expect(roster.RB).toBeGreaterThanOrEqual(2);
    expect(roster.WR).toBeGreaterThanOrEqual(2);
    expect(roster.TE).toBeGreaterThanOrEqual(1);
    expect(roster.QB).toBeLessThanOrEqual(2);
    expect(roster.TE).toBeLessThanOrEqual(2);
  });

  it('deprioritizes quarterback for a long time after taking one early', () => {
    const result = run(CLASSIC_1QB, 4, ['RB', 'QB', 'WR']);
    const quarterbacks = result.userPicks.filter((pick) => pick.position === 'QB');

    // The forced pick is round 2. Any second quarterback must come much later,
    // because an early investment at a one-slot position has to be exploited.
    expect(quarterbacks.length).toBeLessThanOrEqual(2);
    const second = quarterbacks[1];
    if (second) expect(second.round).toBeGreaterThanOrEqual(10);
  });

  it('does not immediately double up after an early tight end', () => {
    const result = run(CLASSIC_1QB, 4, ['WR', 'TE', 'RB']);
    const tightEnds = result.userPicks.filter((pick) => pick.position === 'TE');
    expect(tightEnds.length).toBeLessThanOrEqual(2);
    const second = tightEnds[1];
    if (second) expect(second.round).toBeGreaterThanOrEqual(8);
  });
});
