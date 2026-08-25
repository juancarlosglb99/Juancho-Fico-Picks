export function clamp(value: number, min = 0, max = 100): number {
  return Math.min(max, Math.max(min, value));
}

export function round(value: number, digits = 1): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[middle - 1] + sorted[middle]) / 2;
  }
  return sorted[middle];
}

export function percentileScores(values: number[]): number[] {
  if (values.length <= 1) return values.map(() => 100);
  const sorted = [...values].sort((a, b) => a - b);
  return values.map((value) => {
    const below = sorted.filter((candidate) => candidate < value).length;
    const equal = sorted.filter((candidate) => candidate === value).length;
    const percentile = (below + Math.max(0, equal - 1) / 2) / (sorted.length - 1);
    return round(clamp(percentile * 100), 1);
  });
}

// Abramowitz and Stegun approximation, sufficient for draft-position modeling.
export function normalCdf(value: number): number {
  const sign = value < 0 ? -1 : 1;
  const x = Math.abs(value) / Math.sqrt(2);
  const t = 1 / (1 + 0.3275911 * x);
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const erf =
    sign *
    (1 -
      (((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t) *
        Math.exp(-x * x));
  return 0.5 * (1 + erf);
}
