/**
 * Is the strategy-aware engine actually better, or just differently confident?
 *
 * A model that grades its own homework proves nothing, so this scores every
 * approach with the SAME roster evaluation and compares the finished teams. The
 * baselines are the obvious things a person might do instead:
 *
 *   A. First Seed rank only          - take the highest projected player, always
 *   C. rank plus positional need     - fill empty starting slots first, then rank
 *   E. the strategy-aware engine     - what ships
 *
 * Baseline B (Sleeper room rank only) is not run here: the deterministic
 * fixtures have no room ranking, and against the live snapshot it collapses into
 * A. It is covered by the smoke suite instead.
 */
import { describe, expect, it } from 'vitest';
import { autodraftWithRecommendationOne } from '../../packages/engine/mock/autodraft';
import {
  evaluateRoster,
  lineupSlotsFor,
  type LineupPlayer,
  type LineupSlots,
} from '../../packages/engine/draft/lineup';
import { normalizeLeagueContext } from '../../packages/engine/context/normalize';
import { deriveDraftBoardState } from '../../packages/engine/draft/state';
import { slotForOverallPick } from '../../packages/engine/draft/next-pick-probability';
import {
  archetypeForRoster,
  chooseOpponentPlayer,
} from '../../packages/engine/mock/opponent-model';
import type { Position } from '../../packages/players/types';
import type { MappedProjection } from '../../packages/projections/types';
import { makeDraft, makeLeague, makePlayerPool, makeProjections, makeRosters } from './fixtures';

const TEAMS = 12;
const ROUNDS = 15;
const ROSTER_POSITIONS = ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', ...Array(8).fill('BN')];
const SLOTS = { slots_qb: 1, slots_rb: 2, slots_wr: 2, slots_te: 1, slots_flex: 1, slots_bn: 8 };

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function setup() {
  const players = makePlayerPool(70);
  const projections = makeProjections(players);
  const league = makeLeague({ teams: TEAMS, rosterPositions: ROSTER_POSITIONS });
  const draft = makeDraft({ teams: TEAMS, rounds: ROUNDS, settings: SLOTS });
  const rosters = makeRosters(TEAMS);
  const board = deriveDraftBoardState(draft, [], rosters, players);
  const context = normalizeLeagueContext({
    league,
    draft,
    drafts: [draft],
    picks: [],
    tradedPicks: [],
    rosters,
    board,
    userId: 'user-1',
  });
  return { players, projections, league, draft, rosters, slots: lineupSlotsFor(context.roster.value) };
}

/**
 * Runs a draft where OUR seat uses the supplied rule and the rest of the room
 * uses the same opponent model the engine faces.
 */
function draftWithRule(
  userSlot: number,
  rule: (available: MappedProjection[], owned: MappedProjection[], slots: LineupSlots) => MappedProjection | null,
  seed = 20260826,
): MappedProjection[] {
  const { players, projections, rosters, slots } = setup();
  const random = mulberry32(seed);
  const available = new Map(projections.map((projection) => [projection.playerId, projection]));
  const owned: MappedProjection[] = [];
  const countsByRoster = new Map<number, Partial<Record<Position, number>>>(
    rosters.map((roster) => [roster.roster_id, {}]),
  );
  const recentPositions: Position[] = [];
  const roster = {
    QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, SUPER_FLEX: 0, K: 0, DEF: 0,
    bench: 8, taxi: 0, IR: 0, idp: {}, unknown: {}, totalStarterSpots: 9,
  };

  for (let overallPick = 1; overallPick <= TEAMS * ROUNDS; overallPick += 1) {
    const slot = slotForOverallPick(overallPick, TEAMS, 'snake');
    const counts = countsByRoster.get(slot) ?? {};
    let chosen: MappedProjection | null;
    if (slot === userSlot) {
      chosen = rule([...available.values()], owned, slots);
    } else {
      chosen =
        chooseOpponentPlayer({
          candidates: [...available.values()].map((projection) => ({ projection, roomRanking: null })),
          archetype: archetypeForRoster(slot),
          counts,
          roster,
          currentPick: overallPick,
          recentPositions,
          random,
        })?.projection ?? null;
    }
    if (!chosen) break;
    available.delete(chosen.playerId);
    counts[chosen.position] = (counts[chosen.position] ?? 0) + 1;
    countsByRoster.set(slot, counts);
    recentPositions.push(chosen.position);
    if (slot === userSlot) owned.push(chosen);
  }
  void players;
  return owned;
}

const asLineup = (projections: MappedProjection[]): LineupPlayer[] =>
  projections.map((projection) => ({
    playerId: projection.playerId,
    position: projection.position,
    projection: projection.projection,
  }));

/** A. Highest projected player available, every single round. */
const bestAvailableRule = (available: MappedProjection[]) =>
  [...available].sort((a, b) => b.projection - a.projection)[0] ?? null;

/** C. Fill empty starting slots first, then fall back to best available. */
const needThenRankRule = (available: MappedProjection[], owned: MappedProjection[]) => {
  const targets: Record<string, number> = { QB: 1, RB: 2, WR: 2, TE: 1 };
  const held: Record<string, number> = {};
  for (const projection of owned) held[projection.position] = (held[projection.position] ?? 0) + 1;
  const needed = Object.keys(targets).filter(
    (position) => (held[position] ?? 0) < targets[position],
  );
  const pool = needed.length > 0
    ? available.filter((projection) => needed.includes(projection.position))
    : available;
  return [...pool].sort((a, b) => b.projection - a.projection)[0] ?? null;
};

function engineRoster(userSlot: number): MappedProjection[] {
  const { players, projections, league, draft, rosters } = setup();
  const result = autodraftWithRecommendationOne({
    league,
    draft,
    rosters,
    players,
    projections,
    userSlot,
    userId: `user-${userSlot}`,
  });
  const byId = new Map(projections.map((projection) => [projection.playerId, projection]));
  return result.userPicks
    .map((pick) => byId.get(pick.playerId))
    .filter((projection): projection is MappedProjection => Boolean(projection));
}

describe('benchmark against simpler approaches', () => {
  const slots = setup().slots;

  const score = (roster: MappedProjection[]) => evaluateRoster(asLineup(roster), slots);
  const composition = (roster: MappedProjection[]) => {
    const counts: Record<string, number> = {};
    for (const projection of roster) {
      counts[projection.position] = (counts[projection.position] ?? 0) + 1;
    }
    return counts;
  };

  it.each([1, 6, 12])('beats rank-only and need-then-rank from slot %i', (userSlot) => {
    const rankOnly = score(draftWithRule(userSlot, bestAvailableRule));
    const needFirst = score(draftWithRule(userSlot, needThenRankRule));
    const engine = score(engineRoster(userSlot));

    console.log(
      `[benchmark] slot ${userSlot} — ` +
        `A rank-only ${rankOnly.total} ${JSON.stringify(composition(draftWithRule(userSlot, bestAvailableRule)))} | ` +
        `C need+rank ${needFirst.total} | ` +
        `E engine ${engine.total} ${JSON.stringify(composition(engineRoster(userSlot)))}`,
    );

    // The engine must produce a genuinely better team, judged by the same
    // yardstick as every baseline rather than by its own internal score.
    expect(engine.total).toBeGreaterThan(rankOnly.total);
    expect(engine.total).toBeGreaterThanOrEqual(needFirst.total);

    // And it must never leave a starting slot empty, which rank-only does.
    expect(engine.unfilledSlots).toBe(0);
  });

  it('shows rank-only hoarding the position with the biggest raw numbers', () => {
    const rankOnly = composition(draftWithRule(6, bestAvailableRule));
    const engine = composition(engineRoster(6));
    // The fixtures make quarterbacks the highest-projected players, which is
    // exactly the trap the old model fell into.
    expect(rankOnly.QB ?? 0).toBeGreaterThan(engine.QB ?? 0);
    expect(engine.QB ?? 0).toBeLessThanOrEqual(2);
  });
});
