/**
 * How long it takes a pick in the Sleeper room to become advice on screen.
 *
 * This is one of the two metrics the product is judged on, so it is measured
 * rather than assumed, and it is split into the parts that have different
 * causes and different fixes:
 *
 *   detection - the pick happened, and we have not looked yet. Bounded by the
 *               poll interval, plus the round trip to Sleeper. Improving this
 *               means polling more often or being told rather than asking.
 *   compute   - we have the picks and must rebuild the board, the league
 *               context and every recommendation. Ours entirely.
 *   render    - React commits the new tree.
 *
 * Reporting a single blended number hides which of those is the problem, so
 * each is recorded separately and the total is derived.
 */

export type LatencyStage = 'detection' | 'compute' | 'render';

export interface LatencySample {
  /** Overall pick number this measurement belongs to. */
  overallPick: number;
  /** Epoch ms Sleeper says the pick was made, when it tells us. */
  pickedAt: number | null;
  /** Epoch ms our fetch completed. */
  fetchedAt: number;
  detectionMs: number | null;
  computeMs: number;
  renderMs: number | null;
  /** detection + compute + render, with unknown parts omitted. */
  totalMs: number | null;
}

export interface LatencySummary {
  samples: number;
  detection: StageSummary;
  compute: StageSummary;
  total: StageSummary;
  /** Share of samples that met the one-second budget end to end. */
  withinBudget: number | null;
  budgetMs: number;
}

export interface StageSummary {
  count: number;
  meanMs: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
  maxMs: number | null;
}

/** The product target: a pick should become advice inside a second. */
export const LATENCY_BUDGET_MS = 1_000;

function summarize(values: number[]): StageSummary {
  const usable = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (usable.length === 0) {
    return { count: 0, meanMs: null, p50Ms: null, p95Ms: null, maxMs: null };
  }
  const at = (fraction: number) =>
    usable[Math.min(usable.length - 1, Math.floor((usable.length - 1) * fraction))];
  const round1 = (value: number) => Math.round(value * 10) / 10;
  return {
    count: usable.length,
    meanMs: round1(usable.reduce((sum, value) => sum + value, 0) / usable.length),
    p50Ms: round1(at(0.5)),
    p95Ms: round1(at(0.95)),
    maxMs: round1(usable[usable.length - 1]),
  };
}

/**
 * Collects samples for one draft.
 *
 * Deliberately bounded: a long draft is a few hundred picks and we only ever
 * need recent behaviour, so old samples are dropped rather than accumulated.
 */
export class LatencyRecorder {
  private samples: LatencySample[] = [];

  constructor(private readonly limit = 250) {}

  record(sample: LatencySample): void {
    this.samples.push(sample);
    if (this.samples.length > this.limit) {
      this.samples.splice(0, this.samples.length - this.limit);
    }
  }

  all(): readonly LatencySample[] {
    return this.samples;
  }

  latest(): LatencySample | null {
    return this.samples[this.samples.length - 1] ?? null;
  }

  clear(): void {
    this.samples = [];
  }

  summary(budgetMs = LATENCY_BUDGET_MS): LatencySummary {
    const totals = this.samples
      .map((sample) => sample.totalMs)
      .filter((value): value is number => value !== null);
    return {
      samples: this.samples.length,
      detection: summarize(
        this.samples
          .map((sample) => sample.detectionMs)
          .filter((value): value is number => value !== null),
      ),
      compute: summarize(this.samples.map((sample) => sample.computeMs)),
      total: summarize(totals),
      withinBudget:
        totals.length === 0
          ? null
          : Math.round(
              (totals.filter((value) => value <= budgetMs).length / totals.length) * 1000,
            ) / 10,
      budgetMs,
    };
  }
}

/**
 * Builds a sample from the raw timestamps a sync produces.
 *
 * `pickedAt` comes from Sleeper's `last_picked`, which is the only honest way
 * to know how stale our board was: it is the moment the room actually moved,
 * not the moment we noticed.
 */
export function buildLatencySample({
  overallPick,
  pickedAt,
  fetchedAt,
  computeMs,
  renderMs = null,
}: {
  overallPick: number;
  pickedAt: number | null;
  fetchedAt: number;
  computeMs: number;
  renderMs?: number | null;
}): LatencySample {
  // A clock skew between Sleeper and this machine can produce a negative gap.
  // Treat that as unknown rather than reporting an impossible latency.
  const rawDetection = pickedAt === null ? null : fetchedAt - pickedAt;
  const detectionMs = rawDetection === null || rawDetection < 0 ? null : rawDetection;
  const totalMs =
    detectionMs === null ? null : detectionMs + computeMs + (renderMs ?? 0);
  return {
    overallPick,
    pickedAt,
    fetchedAt,
    detectionMs,
    computeMs: Math.round(computeMs * 10) / 10,
    renderMs,
    totalMs: totalMs === null ? null : Math.round(totalMs * 10) / 10,
  };
}

/** Times a synchronous computation, returning both the value and the cost. */
export function measure<T>(fn: () => T): { value: T; ms: number } {
  const started = now();
  const value = fn();
  return { value, ms: now() - started };
}

function now(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}
