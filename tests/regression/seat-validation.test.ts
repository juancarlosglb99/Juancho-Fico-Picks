/**
 * Validates the ranking rules across every seat of every saved board.
 *
 * Two captured mocks would be a thin basis for a ranking rule, but each contains
 * a full room. Replaying the same real board from all ten or twelve seats keeps
 * the data honest while multiplying the situations the engine must handle -
 * and seat position changes the problem a great deal: who survives to your turn,
 * how long you wait between picks, whether you pick back-to-back at the turn.
 *
 * The bar is the one that matters: never materially worse than drafting the
 * board, and never overriding First Seed when our own simulation prefers it.
 */
import { describe, expect, it } from 'vitest';
import { draftByFirstSeedOnly } from '../../packages/engine/benchmark/first-seed-baseline';
import { MATERIAL_PLAN_LOSS, MEANINGFUL_RANK_GAP } from '../../packages/engine/benchmark/deviation';
import { listCases, readProjectionSnapshot, readRoomSnapshot } from '../../packages/engine/benchmark/store';
import { atSeat, draftFor, playersFor, replayCase } from './replay-harness';
import { buildDraftAttachment } from '../../packages/sleeper/attachment';

const cases = listCases();

interface SeatOutcome {
  draftId: string;
  seat: number;
  juancho: number;
  firstSeed: number;
  delta: number;
  unjustified: number;
  harmful: number;
  counts: Record<string, number | undefined>;
  unfilled: number;
}

function evaluateSeat(entry: ReturnType<typeof listCases>[number], seat: number): SeatOutcome {
  const scoped = atSeat(entry, seat);
  const players = playersFor(scoped);
  const draft = draftFor(scoped);
  const attachment = buildDraftAttachment({ draft, league: null, rosters: null });
  const baseline = draftByFirstSeedOnly({
    regression: scoped,
    projections: readProjectionSnapshot(scoped.projectionsRef),
    roomRankings: scoped.roomRankingsRef ? readRoomSnapshot(scoped.roomRankingsRef) : null,
    players,
    league: attachment.league,
    draft,
    rosters: attachment.rosters,
  });
  const replay = replayCase(scoped);
  return {
    draftId: entry.draftId,
    seat,
    juancho: replay.quality.roster.startingValue,
    firstSeed: baseline.quality.startingValue,
    delta: Math.round((replay.quality.roster.startingValue - baseline.quality.startingValue) * 10) / 10,
    unjustified: replay.deviations.filter(
      (record) => record.reason === 'unjustified' && (record.rankGap ?? 0) >= MEANINGFUL_RANK_GAP,
    ).length,
    harmful: replay.deviations.filter(
      (record) => (record.planDelta ?? 0) < -MATERIAL_PLAN_LOSS,
    ).length,
    counts: replay.quality.roster.counts,
    unfilled: replay.quality.roster.unfilledSlots,
  };
}

const outcomes: SeatOutcome[] = cases.flatMap((entry) =>
  Array.from({ length: entry.format.teams }, (_, index) => evaluateSeat(entry, index + 1)),
);

describe('every seat of every saved board', () => {
  it('reports the sweep', () => {
    console.log(`\n[seats] ${outcomes.length} seat-drafts across ${cases.length} real boards`);
    for (const entry of cases) {
      const mine = outcomes.filter((row) => row.draftId === entry.draftId);
      for (const row of mine) {
        const compact = Object.entries(row.counts)
          .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))
          .map(([position, count]) => `${position}${count}`)
          .join(' ');
        console.log(
          `  ${row.draftId.slice(-6)} seat ${String(row.seat).padStart(2)} · ` +
            `juancho ${row.juancho.toFixed(1).padStart(7)} · board ${row.firstSeed.toFixed(1).padStart(7)} · ` +
            `${(row.delta >= 0 ? '+' : '') + row.delta.toFixed(1)}`.padEnd(10) +
            `· unfilled ${row.unfilled} · ${compact}`,
        );
      }
    }
    const deltas = outcomes.map((row) => row.delta);
    const mean = deltas.reduce((sum, value) => sum + value, 0) / deltas.length;
    const wins = deltas.filter((value) => value > 0.05).length;
    const losses = deltas.filter((value) => value < -0.05).length;
    console.log(
      `[seats] mean ${mean >= 0 ? '+' : ''}${mean.toFixed(1)} · ` +
        `better ${wins} · matched ${outcomes.length - wins - losses} · worse ${losses} · ` +
        `worst ${Math.min(...deltas).toFixed(1)} · best ${Math.max(...deltas).toFixed(1)}`,
    );
    expect(outcomes.length).toBeGreaterThan(0);
  });

  it('is never materially worse than drafting the board, from any seat', () => {
    const failures = outcomes
      .filter((row) => row.delta < -5)
      .map((row) => `${row.draftId.slice(-6)} seat ${row.seat}: ${row.delta}`);
    expect(failures).toEqual([]);
  });

  it('never overrides First Seed when its own simulation prefers it', () => {
    const failures = outcomes
      .filter((row) => row.harmful > 0)
      .map((row) => `${row.draftId.slice(-6)} seat ${row.seat}: ${row.harmful} harmful`);
    expect(failures).toEqual([]);
  });

  it('never reaches far down the board without a reason, from any seat', () => {
    const failures = outcomes
      .filter((row) => row.unjustified > 0)
      .map((row) => `${row.draftId.slice(-6)} seat ${row.seat}: ${row.unjustified} unjustified`);
    expect(failures).toEqual([]);
  });

  it('always fields a legal starting lineup, from any seat', () => {
    const failures = outcomes
      .filter((row) => row.unfilled > 0)
      .map((row) => `${row.draftId.slice(-6)} seat ${row.seat}: ${row.unfilled} unfilled`);
    expect(failures).toEqual([]);
  });
});
