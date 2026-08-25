import { describe, expect, it, vi } from 'vitest';
import {
  AdpProviderResponseError,
  FantasyFootballCalculatorAdpProvider,
  isAdpSourceSnapshot,
  normalizeFantasyFootballCalculatorResponse,
} from '../../packages/adp/providers/fantasy-football-calculator';
import type { AdpProviderRequest } from '../../packages/data/types';

const request: AdpProviderRequest = {
  season: '2026',
  teams: 12,
  format: 'ppr',
};

function payload(count = 80) {
  return {
    status: 'Success',
    meta: {
      type: 'PPR',
      teams: 12,
      rounds: 15,
      total_drafts: 7726,
      start_date: '2026-08-18',
      end_date: '2026-08-25',
    },
    players: Array.from({ length: count }, (_, index) => ({
      player_id: index + 1,
      name: `Player ${index + 1}`,
      position: index % 2 === 0 ? 'WR' : 'RB',
      team: 'TST',
      adp: index + 1.25,
      times_drafted: 500 - index,
      stdev: 2.4,
    })),
  };
}

describe('Fantasy Football Calculator ADP provider', () => {
  it('normalizes records and preserves format, sample, freshness, and attribution metadata', () => {
    const snapshot = normalizeFantasyFootballCalculatorResponse({
      payload: payload(),
      request,
      fetchedAt: new Date('2026-08-25T12:00:00Z'),
    });

    expect(snapshot.provenance).toMatchObject({
      sourceId: 'fantasy-football-calculator',
      season: '2026',
      fetchedAt: '2026-08-25T12:00:00.000Z',
      sourceUpdatedAt: '2026-08-25T00:00:00.000Z',
      sourceConfidence: 'high',
      attributionLabel: 'Fantasy Football Calculator ADP',
    });
    expect(snapshot.context).toEqual({
      leagueFormat: 'redraft_1qb',
      qbFormat: '1qb',
      scoringFormat: 'full_ppr',
      teams: 12,
      sampleSize: 7726,
    });
    expect(snapshot.records).toHaveLength(80);
    expect(snapshot.records[0]).toMatchObject({
      providerPlayerId: '1',
      playerName: 'Player 1',
      position: 'WR',
      adp: 1.25,
      rank: 1,
      sampleSize: 500,
    });
  });

  it.each([
    ['malformed response', { status: 'Error' }],
    ['empty response', payload(0)],
    ['partial response', payload(79)],
    ['wrong league size', { ...payload(), meta: { ...payload().meta, teams: 10 } }],
  ])('rejects a %s before it can replace a cache', (_label, value) => {
    expect(() =>
      normalizeFantasyFootballCalculatorResponse({ payload: value, request }),
    ).toThrow(AdpProviderResponseError);
  });

  it('rejects a response with too many invalid player rows', () => {
    const value = payload(100);
    value.players.splice(
      0,
      6,
      ...Array.from({ length: 6 }, (_, index) => ({
        player_id: index + 1,
        name: '',
        position: 'WR',
        team: 'TST',
        adp: 0,
        times_drafted: 0,
        stdev: 0,
      })),
    );
    expect(() =>
      normalizeFantasyFootballCalculatorResponse({ payload: value, request }),
    ).toThrow('incomplete player dataset');
  });

  it('normalizes the provider’s PK position code to the canonical kicker position', () => {
    const value = payload();
    value.players[0].position = 'PK';
    const snapshot = normalizeFantasyFootballCalculatorResponse({
      payload: value,
      request,
    });
    expect(snapshot.records[0].position).toBe('K');
  });

  it('calls the documented format endpoint with league size and season', async () => {
    const fetcher = vi.fn(async () =>
      new Response(JSON.stringify(payload()), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const provider = new FantasyFootballCalculatorAdpProvider(
      fetcher as typeof fetch,
    );

    await provider.getSnapshot(request);

    const [url] = fetcher.mock.calls[0];
    expect(String(url)).toBe(
      'https://fantasyfootballcalculator.com/api/v1/adp/ppr?teams=12&year=2026',
    );
  });

  it('rejects structurally invalid cached records even when the array is large', () => {
    const snapshot = normalizeFantasyFootballCalculatorResponse({
      payload: payload(),
      request,
    });
    const corrupted = {
      ...snapshot,
      records: snapshot.records.map((record, index) =>
        index === 0 ? { ...record, adp: 0 } : record,
      ),
    };
    expect(isAdpSourceSnapshot(corrupted)).toBe(false);
  });
});
