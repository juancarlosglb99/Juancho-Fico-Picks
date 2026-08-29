import { describe, expect, it } from 'vitest';
import {
  barDomain,
  barPercent,
  cliffIndexes,
  linearScale,
  niceTicks,
  stackSegments,
} from '../../packages/ui/charts';

describe('chart geometry', () => {
  it('anchors a positive bar domain at zero so lengths stay comparable', () => {
    expect(barDomain([280, 300, 320])).toEqual([0, 320]);
  });

  it('lets a caller opt out when zero would flatten every bar', () => {
    expect(barDomain([280, 300, 320], { includeZero: false })).toEqual([280, 320]);
  });

  it('survives an empty or single-valued set without producing NaN', () => {
    expect(barDomain([])).toEqual([0, 1]);
    expect(barDomain([42])).toEqual([0, 42]);
    expect(barPercent(5, [0, 0])).toBe(0);
    expect(Number.isFinite(barPercent(Number.NaN, [0, 10]))).toBe(true);
  });

  it('clamps a bar inside its track', () => {
    expect(barPercent(50, [0, 100])).toBe(50);
    expect(barPercent(150, [0, 100])).toBe(100);
    expect(barPercent(-20, [0, 100])).toBe(0);
  });

  it('places values linearly along a range', () => {
    const scale = linearScale([0, 10], [0, 200]);
    expect(scale(0)).toBe(0);
    expect(scale(5)).toBe(100);
    expect(scale(10)).toBe(200);
    expect(linearScale([4, 4], [0, 100])(4)).toBe(0);
  });

  it('picks ticks a person would have chosen, without floating-point litter', () => {
    expect(niceTicks([0, 100], 4)).toEqual([0, 20, 40, 60, 80, 100]);
    expect(niceTicks([0, 100], 2)).toEqual([0, 50, 100]);
    expect(niceTicks([0, 1], 5)).toEqual([0, 0.2, 0.4, 0.6, 0.8, 1]);
    expect(niceTicks([0, 0])).toEqual([0]);
  });

  it('normalises a stacked bar so no sliver of background shows through', () => {
    const segments = stackSegments([
      { key: 'both', value: 31.2 },
      { key: 'one', value: 44.9 },
      { key: 'neither', value: 23.8 },
    ]);
    expect(segments.reduce((sum, part) => sum + part.percent, 0)).toBeCloseTo(100, 6);
    expect(segments[0].offset).toBe(0);
    expect(segments[1].offset).toBeCloseTo(segments[0].percent, 6);
    expect(segments[2].offset).toBeCloseTo(segments[0].percent + segments[1].percent, 6);
  });

  it('does not divide by zero when every segment is empty', () => {
    const segments = stackSegments([{ key: 'a', value: 0 }, { key: 'b', value: 0 }]);
    expect(segments.every((segment) => segment.percent === 0)).toBe(true);
  });

  it('marks a tier break between two rows, never through one', () => {
    expect(cliffIndexes([1, 1, 2, 2, 3])).toEqual([1, 3]);
    expect(cliffIndexes([1, 1, 1])).toEqual([]);
    expect(cliffIndexes([1, null, 2])).toEqual([]);
  });
});
