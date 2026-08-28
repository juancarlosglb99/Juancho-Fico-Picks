/**
 * Chart geometry, without a chart library.
 *
 * Every visualisation in this product is one of four shapes - a row of bars, a
 * single proportion, a stacked hundred-percent bar, and a stepped timeline -
 * drawn as inline SVG. A charting dependency would be several hundred kilobytes
 * shipped to a phone on a draft clock to draw a rectangle, and it would bring
 * its own opinions about theming to a product that already has one.
 *
 * What a library genuinely provides is the fiddly arithmetic: sensible axis
 * ticks, a domain that includes zero when it should, labels that do not
 * collide. That part is here, and it is testable without a browser, which the
 * components themselves are not.
 */

export interface Scale {
  (value: number): number;
  domain: [number, number];
  range: [number, number];
}

export function linearScale(
  domain: [number, number],
  range: [number, number],
): Scale {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  const span = d1 - d0;
  const scale = ((value: number) => {
    if (span === 0) return r0;
    const t = (value - d0) / span;
    return r0 + t * (r1 - r0);
  }) as Scale;
  scale.domain = domain;
  scale.range = range;
  return scale;
}

/**
 * A domain a person would have chosen.
 *
 * Bars are compared by length, so a bar chart whose axis starts at 280 makes a
 * three per cent difference look like a threefold one. Values that are all
 * positive therefore get a domain anchored at zero unless the caller says
 * otherwise - the exception being a tightly clustered set where zero would
 * flatten every bar into the same length and hide the comparison entirely.
 */
export function barDomain(
  values: number[],
  { includeZero = true }: { includeZero?: boolean } = {},
): [number, number] {
  const finite = values.filter((value) => Number.isFinite(value));
  if (finite.length === 0) return [0, 1];
  const min = Math.min(...finite);
  const max = Math.max(...finite);
  if (min === max) return includeZero && min >= 0 ? [0, max || 1] : [min - 1, max + 1];
  if (includeZero && min >= 0) return [0, max];
  return [min, max];
}

/** Evenly spaced ticks on a 1/2/5 progression, which is what reads as tidy. */
export function niceTicks(
  domain: [number, number],
  count = 4,
): number[] {
  const [min, max] = domain;
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return [min];
  const rawStep = (max - min) / Math.max(1, count);
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const normalized = rawStep / magnitude;
  /*
   * Round to the NEAREST of 1, 2, 5, 10 rather than up to the next one. Always
   * rounding up turns a request for four ticks on a 0-100 axis into two, which
   * is a noticeably coarser axis than anyone asked for. The thresholds are the
   * geometric midpoints between the choices.
   */
  const step =
    (normalized >= Math.sqrt(50)
      ? 10
      : normalized >= Math.sqrt(10)
        ? 5
        : normalized >= Math.sqrt(2)
          ? 2
          : 1) * magnitude;

  const ticks: number[] = [];
  const start = Math.ceil(min / step) * step;
  for (let value = start; value <= max + step / 1000; value += step) {
    // Floating point leaves 0.30000000000000004 lying about in tick labels.
    ticks.push(Math.round(value * 1e6) / 1e6);
  }
  return ticks;
}

/** Bar length as a percentage of the track, clamped so nothing escapes it. */
export function barPercent(value: number, domain: [number, number]): number {
  const [min, max] = domain;
  if (!Number.isFinite(value) || max === min) return 0;
  const ratio = (value - min) / (max - min);
  return Math.max(0, Math.min(100, ratio * 100));
}

export interface StackSegment {
  key: string;
  value: number;
  /** Percentage of the whole, already normalised. */
  percent: number;
  /** Percentage offset from the left edge. */
  offset: number;
}

/**
 * A hundred-percent stacked bar.
 *
 * Used for the joint-availability chart, where the three outcomes are mutually
 * exclusive and exhaustive by construction. Normalising rather than assuming
 * they sum to a hundred keeps a rounding residue from leaving a sliver of
 * background showing.
 */
export function stackSegments(parts: { key: string; value: number }[]): StackSegment[] {
  const total = parts.reduce((sum, part) => sum + Math.max(0, part.value), 0);
  if (total <= 0) {
    return parts.map((part) => ({ key: part.key, value: part.value, percent: 0, offset: 0 }));
  }
  let offset = 0;
  return parts.map((part) => {
    const percent = (Math.max(0, part.value) / total) * 100;
    const segment = { key: part.key, value: part.value, percent, offset };
    offset += percent;
    return segment;
  });
}

/**
 * Where a tier boundary falls in a list of players ordered by projection.
 *
 * Returns the index AFTER which the drop occurs, so a cliff line can be drawn
 * between two rows rather than through one.
 */
export function cliffIndexes(tiers: (number | null)[]): number[] {
  const cliffs: number[] = [];
  for (let index = 1; index < tiers.length; index += 1) {
    const previous = tiers[index - 1];
    const current = tiers[index];
    if (previous !== null && current !== null && current !== previous) {
      cliffs.push(index - 1);
    }
  }
  return cliffs;
}
