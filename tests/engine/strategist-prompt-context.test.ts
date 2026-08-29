/**
 * The compressed payload has to lose repetition, not information.
 *
 * That claim is easy to make and easy to get wrong, so it is tested the only
 * way it can be: field by field, against the brief it was derived from. Every
 * candidate still there, every team still there, every number that bears on a
 * decision still recoverable. Size is checked too, but second - a small payload
 * that hides the right player is worse than a large one.
 */
import { describe, expect, it } from 'vitest';
import { generateDraftRecommendations } from '../../packages/engine/draft/recommendations';
import { buildDraftBrief } from '../../packages/engine/strategist/brief';
import { buildStrategistPromptContext } from '../../packages/engine/strategist/prompt-context';
import type { DraftBrief } from '../../packages/engine/strategist/types';
import type { SleeperDraftPick } from '../../packages/sleeper/types';
import {
  makeContext,
  makeDraft,
  makeLeague,
  makePlayerPool,
  makeProjections,
  makeRoomRankings,
  makeRosters,
} from './fixtures';

const TEAMS = 12;
const players = makePlayerPool(64);
const projections = makeProjections(players);
const roomRankings = makeRoomRankings(projections);

const WITH_KICKERS = [
  'QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'K', 'DEF', 'BN', 'BN', 'BN', 'BN',
];

function briefAfter(pickCount: number, rosterPositions?: string[]): DraftBrief {
  const ranked = [...projections].sort((a, b) => b.projection - a.projection);
  const picks: SleeperDraftPick[] = Array.from({ length: pickCount }, (_, index) => {
    const overall = index + 1;
    const round = Math.ceil(overall / TEAMS);
    const pickInRound = ((overall - 1) % TEAMS) + 1;
    const slot = round % 2 === 0 ? TEAMS + 1 - pickInRound : pickInRound;
    return {
      player_id: players.byId.get(ranked[index].playerId)!.externalIds.sleeper!,
      picked_by: `user-${slot}`,
      roster_id: String(slot),
      round,
      draft_slot: slot,
      pick_no: overall,
      metadata: {},
    };
  });
  const league = makeLeague({ teams: TEAMS, rosterPositions });
  const draft = makeDraft({ teams: TEAMS });
  const rosters = makeRosters(TEAMS);
  const { context, board } = makeContext({ league, draft, picks, rosters, players });
  const result = generateDraftRecommendations({
    context,
    picks,
    rosters,
    board,
    players,
    projections,
    roomRankings,
  });
  return buildDraftBrief({
    context,
    board,
    picks,
    rosters,
    players,
    result,
    draftId: 'draft-1',
    isMock: true,
  })!;
}

/** Reads one column out of a table by name, so tests are not index-fragile. */
function column(
  table: { columns: string[]; rows: (string | number | null)[][] },
  name: string,
): (string | number | null)[] {
  const index = table.columns.indexOf(name);
  expect(index, `column ${name}`).toBeGreaterThanOrEqual(0);
  return table.rows.map((row) => row[index]);
}

describe('the strategist prompt context', () => {
  it('keeps every available player the brief offered', () => {
    const brief = briefAfter(40);
    const context = buildStrategistPromptContext(brief);
    expect(column(context.board, 'id').sort()).toEqual(
      brief.candidates.map((candidate) => candidate.playerId).sort(),
    );
  });

  it('keeps First Seed and Juancho as separate columns', () => {
    const brief = briefAfter(30);
    const context = buildStrategistPromptContext(brief);
    const ids = column(context.board, 'id');

    for (const field of ['fsRank', 'fsGap', 'fsVal', 'fsMine']) {
      expect(context.board.columns).toContain(field);
    }
    for (const field of ['proj', 'tier', 'left', 'jRank', 'posRank', 'jRec', 'dPlan', 'dDec']) {
      expect(context.board.columns).toContain(field);
    }
    // And the values survive the transposition intact.
    const sample = brief.candidates[5];
    const row = ids.indexOf(sample.playerId);
    expect(column(context.board, 'fsRank')[row]).toBe(sample.firstSeed.rank);
    expect(column(context.board, 'proj')[row]).toBe(sample.juancho.projectedPoints);
    expect(column(context.board, 'surv')[row]).toBe(sample.survival.probability);
    expect(column(context.board, 'dPlan')[row]).toBe(sample.juancho.planValueVsRecommended);
    expect(column(context.board, 'dDec')[row]).toBe(sample.juancho.decisionValueVsRecommended);
  });

  it('names every column it uses', () => {
    const brief = briefAfter(30);
    const context = buildStrategistPromptContext(brief);
    for (const table of [
      context.board,
      context.room.recent,
      context.room.tierCliffs,
      context.juancho!.top,
    ]) {
      for (const name of table.columns) {
        expect(table.legend[name], `${name} has no legend entry`).toBeTruthy();
      }
      for (const row of table.rows) expect(row).toHaveLength(table.columns.length);
    }
  });

  it('keeps every team, with its actual players', () => {
    const brief = briefAfter(48);
    const context = buildStrategistPromptContext(brief);
    expect(context.opponents).toHaveLength(TEAMS - 1);
    expect(context.us.id).toBe(brief.ourTeam.rosterId);

    for (const team of [brief.ourTeam, ...brief.opponents]) {
      const compact =
        team.rosterId === context.us.id
          ? context.us
          : context.opponents.find((entry) => entry.id === team.rosterId)!;
      for (const player of team.players) {
        expect(compact.roster, `roster ${team.rosterId}`).toContain(player.name);
      }
      expect(compact.build).toBe(team.build);
      expect(compact.nextPick).toBe(team.nextSelectionOverall);
    }
  });

  it('keeps who picks before us, in order, with their needs', () => {
    const brief = briefAfter(30);
    const context = buildStrategistPromptContext(brief);
    const expected = brief.room.teamsBeforeOurNextPick
      .flatMap((team) =>
        team.selections.map((pick) => [pick, team.rosterId] as [number, number | null]),
      )
      .sort((a, b) => a[0] - b[0]);
    expect(context.upcoming.order).toEqual(expected);
    for (const team of brief.room.teamsBeforeOurNextPick) {
      expect(context.upcoming.needs).toHaveProperty(String(team.rosterId));
    }
  });

  it('keeps the room: recent picks, runs and tier cliffs', () => {
    const brief = briefAfter(40);
    const context = buildStrategistPromptContext(brief);
    expect(context.room.recent.rows).toHaveLength(brief.room.recentPicks.length);
    expect(context.room.tierCliffs.rows).toHaveLength(brief.room.tierCliffs.length);
    expect(context.room.totalDrafted).toBe(brief.room.totalDrafted);
    expect(context.room.tendency).toBe(brief.room.tendency);
  });

  it('keeps Juancho\'s recommendation and the rules the guardrails enforce', () => {
    const brief = briefAfter(30);
    const context = buildStrategistPromptContext(brief);
    expect(context.juancho!.recommended!.playerId).toBe(brief.deterministic.recommended!.playerId);
    expect(context.juancho!.top.rows.length).toBeGreaterThan(0);
    expect(context.rules.selectionsRemaining).toBe(brief.constraints.rosterSpotsRemaining);
    expect(context.rules.usableCapacity).toEqual(brief.constraints.usableCapacity);
    expect(context.rules.blocked).toHaveLength(brief.constraints.blockedPositions.length);
  });

  it('keeps the extension points and states what it left out', () => {
    const context = buildStrategistPromptContext(briefAfter(30));
    expect(context.strategyContext).toBeNull();
    expect(context.playerNews).toBeNull();
    expect(context.omitted.length).toBeGreaterThan(0);
  });

  it('is far smaller than the brief, and does not grow as rosters fill', () => {
    const early = briefAfter(20);
    const late = briefAfter(120);
    const size = (value: unknown) => JSON.stringify(value).length;

    for (const brief of [early, late]) {
      const context = buildStrategistPromptContext(brief);
      expect(size(context)).toBeLessThan(size(brief) * 0.35);
    }

    /*
     * The brief grows through a draft because it describes every roster four
     * separate ways; the context describes each once. Its size should track the
     * board shrinking, not the rosters filling.
     */
    const earlyContext = size(buildStrategistPromptContext(early));
    const lateContext = size(buildStrategistPromptContext(late));
    expect(lateContext).toBeLessThan(earlyContext * 1.25);
  });

  it('never drops the deterministic pick when the board is capped', () => {
    const brief = briefAfter(30);
    const context = buildStrategistPromptContext(brief, { maxCandidates: 15 });
    const ids = column(context.board, 'id');
    expect(ids.length).toBeLessThan(brief.candidates.length);
    expect(ids).toContain(brief.deterministic.recommended!.playerId);
    for (const entry of brief.deterministic.top) {
      expect(ids, `Juancho ranked ${entry.name} but the board dropped him`).toContain(entry.playerId);
    }
  });

  it('withholds the verdict in blind mode while keeping all of its evidence', () => {
    const brief = briefAfter(30);
    const open = buildStrategistPromptContext(brief);
    const blind = buildStrategistPromptContext(brief, { blind: true });
    const serialised = JSON.stringify(blind);

    /* ------------------------------------------------- the verdict is gone */

    expect(blind.juancho, 'the deterministic conclusion must not be present').toBeUndefined();
    expect(blind.board.columns).not.toContain('jRec');
    expect(blind.board.columns).not.toContain('act');
    expect(blind.board.columns).not.toContain('dDec');
    // And it must not survive anywhere else in the payload by another name.
    expect(serialised).not.toContain('recommendedPlayerId');
    expect(serialised).not.toContain('DRAFT_NOW');

    /*
     * The subtle leak: dPlan is measured FROM the recommended pick, so the row
     * reading zero identifies it. Re-based to the best final roster, zero means
     * "the best simulated outcome" and names nobody's preference.
     */
    expect(blind.board.columns).not.toContain('dPlan');
    expect(blind.board.columns).toContain('simGap');
    const gapIndex = blind.board.columns.indexOf('simGap');
    const gaps = blind.board.rows
      .map((row) => row[gapIndex])
      .filter((value): value is number => typeof value === 'number');
    expect(gaps.every((value) => value <= 0), 'measured from the best outcome').toBe(true);
    expect(Math.max(...gaps)).toBe(0);

    /* -------------------------------------------------- the evidence stays */

    expect(blind.board.rows).toHaveLength(open.board.rows.length);
    for (const field of ['fsRank', 'fsGap', 'proj', 'tier', 'left', 'surv', 'gain', 'warn']) {
      expect(blind.board.columns, `${field} is evidence, not a verdict`).toContain(field);
    }
    expect(blind.jointAvailability).not.toBeNull();
    expect(blind.opponents).toHaveLength(open.opponents.length);
    expect(blind.room.tierCliffs.rows).toHaveLength(open.room.tierCliffs.rows.length);
    expect(blind.us.positions.length).toBeGreaterThan(0);
    expect(blind.rules.usableCapacity).toEqual(open.rules.usableCapacity);
    // First Seed's own best available is THEIR signal, not our conclusion.
    expect(blind.simulation!.firstSeedBestAvailable).toEqual(
      open.juancho!.firstSeedBestAvailable,
    );
    expect(blind.simulation!.bestFinalRosterValue).toBeTypeOf('number');
    expect(blind.omitted.join(' ')).toContain('deterministic ranking');
  });

  it('leaves the open context exactly as it was', () => {
    // The non-blind payload must not shift, or the runs already recorded
    // against it stop being comparable.
    const context = buildStrategistPromptContext(briefAfter(30));
    expect(context.simulation).toBeUndefined();
    expect(context.juancho).toBeDefined();
    expect(context.board.columns).toContain('jRec');
    expect(context.board.columns).toContain('dDec');
  });

  it('spends detail where the decision needs it, and loses no player', () => {
    const brief = briefAfter(40);
    const full = buildStrategistPromptContext(brief, { blind: true });
    const compact = buildStrategistPromptContext(brief, { blind: true, compact: true });

    /*
     * The rule that matters: nothing is truncated. A correct recommendation
     * must never disappear because it fell outside an arbitrary top-N, so every
     * available player is still reachable - just not all at twenty columns.
     */
    const ids = (table: { columns: string[]; rows: (string | number | null)[][] }) =>
      table.rows.map((row) => row[table.columns.indexOf('id')]);
    const reachable = new Set([...ids(compact.board), ...ids(compact.deepBoard!)]);
    expect([...reachable].sort()).toEqual(ids(full.board).sort());

    // The two layers partition the pool; nobody is in both.
    expect(ids(compact.board).filter((id) => ids(compact.deepBoard!).includes(id))).toEqual([]);
    expect(compact.board.rows.length).toBeLessThan(full.board.rows.length);
    expect(compact.deepBoard!.columns.length).toBeLessThan(compact.board.columns.length);

    // And it is materially smaller.
    expect(JSON.stringify(compact).length).toBeLessThan(JSON.stringify(full).length * 0.85);
  });

  it('keeps full metrics for the players a decision could turn on', () => {
    const brief = briefAfter(40);
    const compact = buildStrategistPromptContext(brief, { blind: true, compact: true });
    const rich = new Set(
      compact.board.rows.map((row) => row[compact.board.columns.indexOf('id')]),
    );

    // Everyone named in a joint comparison, because those are the comparisons
    // the pick is actually being decided between.
    for (const pair of brief.jointAvailability?.pairs ?? []) {
      expect(rich, `pair member ${pair.a.name}`).toContain(pair.a.playerId);
      expect(rich, `pair member ${pair.b.name}`).toContain(pair.b.playerId);
    }
    for (const tier of brief.jointAvailability?.scenarios.tiers ?? []) {
      // Bounded, because a flat projection curve can put a whole position in
      // one tier and an unbounded tier defeats the compaction entirely.
      for (const member of tier.members.slice(0, 8)) {
        expect(rich, `tier member ${member.name}`).toContain(member.playerId);
      }
    }
    // And the top of First Seed's board.
    const topFirstSeed = [...brief.candidates]
      .filter((candidate) => candidate.firstSeed.rank !== null)
      .sort((a, b) => a.firstSeed.rank! - b.firstSeed.rank!)
      .slice(0, 10);
    for (const candidate of topFirstSeed) {
      expect(rich, `First Seed #${candidate.firstSeed.rank}`).toContain(candidate.playerId);
    }
  });

  it('stays blind when compacted', () => {
    // Compaction must not become a way for the verdict to creep back in.
    const compact = buildStrategistPromptContext(briefAfter(40), {
      blind: true,
      compact: true,
    });
    const serialised = JSON.stringify(compact);
    expect(compact.juancho).toBeUndefined();
    expect(compact.board.columns).not.toContain('jRec');
    expect(compact.board.columns).not.toContain('dDec');
    expect(compact.deepBoard!.columns).not.toContain('jRec');
    expect(serialised).not.toContain('recommendedPlayerId');
  });

  it('names the opponents who bear on this pick and summarises the rest', () => {
    const brief = briefAfter(40);
    const compact = buildStrategistPromptContext(brief, { blind: true, compact: true });
    const mattering = new Set(
      brief.room.teamsBeforeOurNextPick
        .map((team) => team.rosterId)
        .filter((rosterId): rosterId is number => rosterId !== null),
    );

    for (const team of compact.opponents) {
      // Every team keeps what it needs; only the roster line is summarised.
      expect(team.counts).toBeTruthy();
      expect(team.holes).toBeTruthy();
      expect(team.build).toBeTruthy();
      if (mattering.has(team.id)) {
        expect(team.roster, `roster ${team.id} picks before us`).not.toBe('');
      }
    }
    if (mattering.size > 0 && mattering.size < compact.opponents.length) {
      expect(compact.opponents.some((team) => team.roster === '')).toBe(true);
    }
  });

  it('does not clutter every roster with a kicker need nobody can act on', () => {
    const brief = briefAfter(30, WITH_KICKERS);
    expect(brief.constraints.kickersAndDefensesAllowed).toBe(false);
    const context = buildStrategistPromptContext(brief);
    for (const team of [context.us, ...context.opponents]) {
      expect(team.needs).not.toContain('K:');
      expect(team.needs).not.toContain('DEF:');
    }
    // But the lineup gap they cause is still stated, in both places it matters.
    expect(context.us.holes).toContain('K');
    expect(context.rules.mustFillBeforeDraftEnds).toContain('K');
  });
});
