/**
 * The drawer's data, and the rule that governs all of it: a chart appears only
 * when there is something real behind it. Half of these tests are about what
 * the module refuses to produce.
 */
import { describe, expect, it } from 'vitest';
import { buildPlayerAnalysis } from '../../packages/ui/player-analysis';
import { scenario } from './scenario';

const state = scenario({ picksMade: 26 });
const { result, brief } = state;
const drafted = new Set(
  state.picks
    .map((pick) => state.players.bySleeperId.get(pick.player_id)?.id)
    .filter((id): id is string => Boolean(id)),
);

function analyse(playerId: string, withBrief = true) {
  return buildPlayerAnalysis({
    playerId,
    result,
    brief: withBrief ? brief : null,
    draftedPlayerIds: drafted,
    teamNameFor: (rosterId) => (rosterId === null ? null : `Seat ${rosterId}`),
  });
}

const topPick = result.recommendations[0].player.id;

describe('player analysis drawer', () => {
  it('heads with the identity a drafter checks first', () => {
    const analysis = analyse(topPick)!;
    expect(analysis.header.name).toBeTruthy();
    expect(analysis.header.position).toBeTruthy();
    expect(analysis.header.firstSeedRank).not.toBeNull();
    expect(analysis.header.leagueProjection).toBeGreaterThan(0);
    expect(analysis.header.tier).not.toBeNull();
    expect(analysis.header.drafted).toBe(false);
    expect(analysis.header.engineRank).toBe(1);
    // `Active` is every player's status and would be noise on every header.
    expect(analysis.header.status).toBeNull();
  });

  it('returns nothing at all for a player the engine cannot describe', () => {
    expect(analyse('no-such-player')).toBeNull();
    expect(
      buildPlayerAnalysis({
        playerId: topPick,
        result: { ...result, internals: undefined },
        brief,
        draftedPlayerIds: drafted,
      }),
    ).toBeNull();
  });

  it('A. compares him against his positional peers, with himself marked', () => {
    const peers = analyse(topPick)!.peers!;
    expect(peers.bars.length).toBeGreaterThan(2);
    expect(peers.bars.filter((bar) => bar.isSubject)).toHaveLength(1);
    expect(peers.position).toBe(analyse(topPick)!.header.position);
    // Ordered by projection, best first, so the bars descend.
    const points = peers.bars.map((bar) => bar.projectedPoints);
    expect([...points].sort((a, b) => b - a)).toEqual(points);
    expect(peers.subjectIndex).toBeGreaterThan(0);
    expect(peers.totalAtPosition).toBeGreaterThanOrEqual(peers.bars.length);
  });

  it('B. names the replacement from the simulation, not from the next line of the board', () => {
    const replacement = analyse(topPick)!.replacement!;
    expect(replacement.subject.projectedPoints).toBeGreaterThan(0);
    expect(replacement.replacement).not.toBeNull();
    expect(replacement.replacement!.playerId).not.toBe(topPick);
    // The chance he is the best of his position left comes from counted runs.
    expect(replacement.replacement!.chanceBestOfPosition).toBeGreaterThan(0);
    expect(replacement.replacement!.chanceBestOfPosition).toBeLessThanOrEqual(100);
    expect(replacement.pointsDelta).not.toBeNull();
  });

  it('B. reports roster value as well as raw points, and never confuses the two', () => {
    const replacement = analyse(topPick)!.replacement!;
    expect(replacement.subject.rosterGain).not.toBeNull();
    /*
     * Two different quantities, each the difference of its own pair. Roster
     * gain is not the projection and is not bounded by it - filling an empty
     * starting slot is worth the points AND the end of the hole - which is
     * exactly why the chart shows both rather than one.
     */
    expect(replacement.pointsDelta).toBeCloseTo(
      replacement.subject.projectedPoints - replacement.replacement!.projectedPoints,
      1,
    );
    if (replacement.replacement?.rosterGain != null) {
      expect(replacement.rosterValueDelta).toBeCloseTo(
        replacement.subject.rosterGain! - replacement.replacement.rosterGain,
        1,
      );
    } else {
      expect(replacement.rosterValueDelta).toBeNull();
      expect(replacement.caveat).toBeTruthy();
    }
  });

  it('C. reports survival with its confidence and the runs behind it', () => {
    const survival = analyse(topPick)!.survival!;
    expect(survival.probability).toBeGreaterThanOrEqual(0);
    expect(survival.probability).toBeLessThanOrEqual(100);
    expect(survival.confidence).toBeTruthy();
    expect(survival.runs).toBeGreaterThan(0);
    expect(survival.probability).toBe(result.recommendations[0].availableNextPickProbability);
  });

  it('D. shows where the tier actually breaks', () => {
    const cliff = analyse(topPick)!.tierCliff!;
    expect(cliff.rows.length).toBeGreaterThan(2);
    expect(cliff.rows.filter((row) => row.isSubject)).toHaveLength(1);
    expect(cliff.subjectTier).not.toBeNull();
    // A boundary marked between two rows, never through one.
    const marked = cliff.rows.filter((row) => row.cliffAfter);
    for (const row of marked) {
      const index = cliff.rows.indexOf(row);
      expect(cliff.rows[index + 1].tier).not.toBe(row.tier);
    }
  });

  it('E. answers joint questions by counting runs, and the parts add to a hundred', () => {
    const joint = analyse(topPick)!.joint!;
    expect(joint.runs).toBeGreaterThan(0);
    expect(joint.rows.length).toBeGreaterThan(0);
    for (const row of joint.rows) {
      const total = row.bothSurvive + row.neitherSurvives;
      expect(row.atLeastOneSurvives).toBeGreaterThanOrEqual(row.bothSurvive);
      expect(Math.round(row.atLeastOneSurvives + row.neitherSurvives)).toBe(100);
      expect(total).toBeLessThanOrEqual(100.1);
      expect(row.playerId).not.toBe(topPick);
    }
  });

  it('F. lists only opponents that materially want the position', () => {
    const pressure = analyse(topPick)!.opponentPressure;
    if (pressure === null) return;
    expect(pressure.rows.every((row) => row.openStartingSlots > 0 || row.need !== 'none')).toBe(true);
    expect(pressure.rows.length).toBeLessThanOrEqual(pressure.totalSelectionsBefore + 1);
    // Ordered by pressure, most threatening first.
    const pressures = pressure.rows.map((row) => row.pressure);
    expect([...pressures].sort((a, b) => b - a)).toEqual(pressures);
    // Named through the resolver, never as "Roster 7".
    for (const row of pressure.rows) expect(row.teamName).toMatch(/^Seat \d+$/);
  });

  it('F. and H. need the brief, and say nothing rather than guessing without it', () => {
    const blind = analyse(topPick, false)!;
    expect(blind.opponentPressure).toBeNull();
    expect(blind.plan).toBeNull();
    // Everything derived purely from the engine still works.
    expect(blind.peers).not.toBeNull();
    expect(blind.survival).not.toBeNull();
    expect(blind.joint).not.toBeNull();
  });

  it('H. builds a timeline from this pick to the next turn', () => {
    const plan = analyse(topPick)!.plan!;
    expect(plan.steps[0].kind).toBe('now');
    expect(plan.steps[0].label).toContain(analyse(topPick)!.header.name);
    expect(plan.steps[0].overallPick).toBe(brief.draft.currentOverallPick);

    const gap = plan.steps.find((step) => step.kind === 'gap');
    expect(gap).toBeTruthy();
    expect(gap!.label).toContain(String(brief.draft.picksUntilOurNextSelection));

    const target = plan.steps.find((step) => step.kind === 'target');
    expect(target).toBeTruthy();
    expect(target!.overallPick).toBe(brief.draft.nextOurPick);
    // The names come from counted futures, so each has a frequency.
    for (const expected of target!.expected) {
      expect(expected.frequency).toBeGreaterThan(0);
      expect(expected.name).toBeTruthy();
    }
  });

  it('H. never targets the position this very pick just filled', () => {
    const analysis = analyse(topPick)!;
    const takenPosition = analysis.header.position;
    const need = brief.ourTeam.needs.find((entry) => entry.position === takenPosition);
    if (!need || need.openStartingSlots > 1) return;
    const target = analysis.plan!.steps.find((step) => step.kind === 'target');
    expect(target?.position).not.toBe(takenPosition);
  });

  it('opens for a player already drafted, and claims nothing about his future', () => {
    // Reached by clicking a cell on the draft board, which must work.
    const analysis = analyse([...drafted][0])!;
    expect(analysis.header.drafted).toBe(true);
    expect(analysis.header.name).toBeTruthy();
    // Everything that is a statement about availability is simply absent.
    expect(analysis.peers).toBeNull();
    expect(analysis.survival).toBeNull();
    expect(analysis.replacement).toBeNull();
    expect(analysis.tierCliff).toBeNull();
    expect(analysis.joint).toBeNull();
    expect(analysis.plan).toBeNull();
  });
});
