import { describe, expect, it } from 'vitest';
import { FantasyFootballCalculatorAdpProvider } from '../../packages/adp/providers/fantasy-football-calculator';

const provider = new FantasyFootballCalculatorAdpProvider();

describe('live Fantasy Football Calculator ADP', () => {
  it.each([
    { format: 'ppr' as const, qbFormat: '1qb' as const },
    { format: '2qb' as const, qbFormat: 'superflex' as const },
  ])('loads a production 2026 $format snapshot', async ({ format, qbFormat }) => {
    const snapshot = await provider.getSnapshot({
      format,
      teams: 12,
      season: '2026',
    });

    expect(snapshot.records.length).toBeGreaterThanOrEqual(80);
    expect(snapshot.context.teams).toBe(12);
    expect(snapshot.context.qbFormat).toBe(qbFormat);
    expect(snapshot.context.sampleSize).toBeGreaterThan(0);
    expect(snapshot.provenance.sourceUpdatedAt).toMatch(/^2026-/);
    expect(snapshot.records.every((record) => record.adp > 0)).toBe(true);
  });
});
