import { describe, expect, it } from 'vitest';
import {
  LATENCY_BUDGET_MS,
  LatencyRecorder,
  buildLatencySample,
  isNewlyObservedPick,
  measure,
} from '../../packages/engine/perf/latency';

describe('buildLatencySample', () => {
  it('splits the delay into noticing and thinking', () => {
    const sample = buildLatencySample({
      overallPick: 12,
      pickedAt: 1_000,
      fetchedAt: 1_600,
      computeMs: 8,
    });
    expect(sample.detectionMs).toBe(600);
    expect(sample.computeMs).toBe(8);
    expect(sample.totalMs).toBe(608);
  });

  it('reports an unknown pick time rather than guessing', () => {
    const sample = buildLatencySample({
      overallPick: 1,
      pickedAt: null,
      fetchedAt: 1_600,
      computeMs: 5,
    });
    expect(sample.detectionMs).toBeNull();
    expect(sample.totalMs).toBeNull();
  });

  it('discards an impossible measurement instead of reporting a negative one', () => {
    // Sleeper's clock and this machine's clock are not the same clock.
    const sample = buildLatencySample({
      overallPick: 4,
      pickedAt: 2_000,
      fetchedAt: 1_500,
      computeMs: 5,
    });
    expect(sample.detectionMs).toBeNull();
    expect(sample.totalMs).toBeNull();
  });

  it('includes render time when the caller measured it', () => {
    const sample = buildLatencySample({
      overallPick: 4,
      pickedAt: 1_000,
      fetchedAt: 1_400,
      computeMs: 10,
      renderMs: 30,
    });
    expect(sample.totalMs).toBe(440);
  });
});

describe('LatencyRecorder', () => {
  const sample = (detection: number, compute = 10) =>
    buildLatencySample({
      overallPick: 1,
      pickedAt: 0,
      fetchedAt: detection,
      computeMs: compute,
    });

  it('summarizes nothing without samples', () => {
    const summary = new LatencyRecorder().summary();
    expect(summary.samples).toBe(0);
    expect(summary.total.p50Ms).toBeNull();
    expect(summary.withinBudget).toBeNull();
  });

  it('reports median, p95 and worst', () => {
    const recorder = new LatencyRecorder();
    for (const detection of [100, 200, 300, 400, 5_000]) recorder.record(sample(detection));
    const summary = recorder.summary();
    expect(summary.samples).toBe(5);
    expect(summary.total.p50Ms).toBe(310);
    expect(summary.total.maxMs).toBe(5_010);
  });

  it('reports the share that met the budget', () => {
    const recorder = new LatencyRecorder();
    for (const detection of [100, 200, 300, 5_000]) recorder.record(sample(detection));
    expect(recorder.summary(LATENCY_BUDGET_MS).withinBudget).toBe(75);
  });

  it('keeps only recent samples so a long draft cannot grow without bound', () => {
    const recorder = new LatencyRecorder(3);
    for (const detection of [100, 200, 300, 400]) recorder.record(sample(detection));
    expect(recorder.all()).toHaveLength(3);
    expect(recorder.latest()?.detectionMs).toBe(400);
  });

  it('ignores samples with no pick timestamp when judging the budget', () => {
    const recorder = new LatencyRecorder();
    recorder.record(sample(100));
    recorder.record(
      buildLatencySample({ overallPick: 2, pickedAt: null, fetchedAt: 50, computeMs: 5 }),
    );
    const summary = recorder.summary();
    expect(summary.samples).toBe(2);
    expect(summary.total.count).toBe(1);
    expect(summary.withinBudget).toBe(100);
  });
});

describe('isNewlyObservedPick', () => {
  it('does not time the board we arrived to', () => {
    // Sleeper reports the last pick's timestamp whenever asked. Attaching to a
    // draft that has been dormant for a month would otherwise report a month of
    // latency, which is true and useless.
    expect(isNewlyObservedPick(null, { draftId: 'a', picksMade: 28 })).toBe(false);
  });

  it('times a pick that arrived while we were watching', () => {
    expect(
      isNewlyObservedPick({ draftId: 'a', picksMade: 28 }, { draftId: 'a', picksMade: 29 }),
    ).toBe(true);
  });

  it('ignores a poll where nothing moved', () => {
    expect(
      isNewlyObservedPick({ draftId: 'a', picksMade: 28 }, { draftId: 'a', picksMade: 28 }),
    ).toBe(false);
  });

  it('never carries a measurement across drafts', () => {
    expect(
      isNewlyObservedPick({ draftId: 'a', picksMade: 4 }, { draftId: 'b', picksMade: 40 }),
    ).toBe(false);
  });
});

describe('measure', () => {
  it('returns the value and a non-negative cost', () => {
    const { value, ms } = measure(() => 6 * 7);
    expect(value).toBe(42);
    expect(ms).toBeGreaterThanOrEqual(0);
  });
});
