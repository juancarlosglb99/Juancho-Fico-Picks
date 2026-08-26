import { describe, expect, it, vi } from 'vitest';
import {
  FirstSeedDraftRoomRankingProvider,
  FirstSeedProjectionProvider,
} from '../../packages/first-seed/providers';
import { mapFirstSeedDraftRoomRankingSnapshot } from '../../packages/first-seed/mapping';
import { buildCanonicalPlayerMap } from '../../packages/players/player-map';
import { makeContext, makeDraft, makeLeague, makeRosters } from '../engine/fixtures';

function projectionCsv(count = 105): string {
  return [
    ',std,half,ppr,Player,Pos,Team,BYE,ESPN Std,ESPN PPR,Sleeper Std,Sleeper Half,Sleeper PPR,Proj Std,Proj Half,Proj PPR,Yahoo',
    ...Array.from({ length: count }, (_, index) =>
      `,${index + 1},${index + 1},${index + 1},Player ${index + 1},WR,TST,9,,,,,,${300 - index},${310 - index},${320 - index},`,
    ),
  ].join('\n');
}

function roomCsv(count = 90): string {
  return [
    ',Name,Team,BYE,Pos,ADP,FantasyPros,Sleeper ADP,SleepvFP,Landmine,Round,Pick',
    ...Array.from({ length: count }, (_, index) =>
      `,Player ${index + 1},TST,9,WR,${index + 1.5},${index + 2},${index + 1},${index % 2 ? -2 : 3},${index % 3},1,${index + 1}`,
    ),
  ].join('\n');
}

function fetcherFor({ projections = projectionCsv(), rankings = roomCsv() } = {}) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    const sheet = url.searchParams.get('sheet');
    const body = sheet === 'Combined'
      ? projections
      : sheet === 'Introduction'
        ? 'JuiceSheets\nUpdated 8/13/2026'
        : sheet === 'Main'
          ? 'Abusing Draft Rankings\nUpdated 8/20/2026'
          : rankings;
    return new Response(body, { status: 200, headers: { 'content-type': 'text/csv' } });
  });
}

describe('First Seed structured providers', () => {
  it('selects the requested aggregate scoring column and preserves attribution', async () => {
    const snapshot = await new FirstSeedProjectionProvider(
      fetcherFor() as unknown as typeof fetch,
    ).getSnapshot({
      season: '2026',
      scoringFormat: 'half_ppr',
      fetchedAt: new Date('2026-08-26T12:00:00Z'),
    });

    expect(snapshot.records).toHaveLength(105);
    expect(snapshot.records[0]).toMatchObject({
      playerName: 'Player 1',
      position: 'WR',
      team: 'TST',
      projection: 310,
      projectionScoring: 'half_ppr',
    });
    expect(snapshot.provenance).toMatchObject({
      sourceUpdatedAt: '2026-08-13T00:00:00.000Z',
      attributionLabel: 'First Seed Sports',
    });
  });

  it('keeps room rank, upstream ADP, expert rank, and First Seed delta distinct', async () => {
    const snapshot = await new FirstSeedDraftRoomRankingProvider(
      fetcherFor() as unknown as typeof fetch,
    ).getSnapshot({
      season: '2026',
      platform: 'sleeper',
      scoringFormat: 'full_ppr',
      qbFormat: '1qb',
      fetchedAt: new Date('2026-08-26T12:00:00Z'),
    });

    expect(snapshot.context.sheet).toBe('Sleeper PPR');
    expect(snapshot.records[0]).toMatchObject({
      rank: 1,
      upstreamMarketAdp: 1.5,
      upstreamExpertRank: 2,
      firstSeedValueDelta: 3,
      firstSeedLandmineScore: 0,
    });
    expect(snapshot.provenance.sourceUpdatedAt).toBe('2026-08-20T00:00:00.000Z');
  });

  it('rejects truncated sheets so last-known-good cache can remain authoritative', async () => {
    const provider = new FirstSeedProjectionProvider(
      fetcherFor({ projections: projectionCsv(8) }) as unknown as typeof fetch,
    );
    await expect(provider.getSnapshot({ season: '2026', scoringFormat: 'standard' }))
      .rejects.toThrow('incomplete projection dataset');
  });

  it('resolves defenses by team and leaves duplicate names ambiguous', async () => {
    const rankings = roomCsv()
      .replace('Player 1,TST,9,WR', 'Buffalo Bills,BUF,9,DST')
      .replace('Player 2,TST,9,WR', 'Chris Smith,TST,9,WR');
    const source = await new FirstSeedDraftRoomRankingProvider(
      fetcherFor({ rankings }) as unknown as typeof fetch,
    ).getSnapshot({
      season: '2026',
      platform: 'sleeper',
      scoringFormat: 'full_ppr',
      qbFormat: '1qb',
    });
    const players = buildCanonicalPlayerMap({
      BUF: { player_id: 'BUF', full_name: 'Buffalo Bills', position: 'DEF', team: 'BUF' },
      one: { player_id: 'one', full_name: 'Chris Smith', position: 'WR', team: 'AAA' },
      two: { player_id: 'two', full_name: 'Chris Smith', position: 'WR', team: 'BBB' },
    });
    const league = makeLeague({ teams: 2 });
    const draft = makeDraft({ teams: 2 });
    const { context } = makeContext({ league, draft, rosters: makeRosters(2), players });
    const mapped = mapFirstSeedDraftRoomRankingSnapshot(source, players, context);

    expect(mapped.records.find((record) => record.team === 'BUF')).toMatchObject({
      playerId: 'jfp:BUF',
      resolutionMethod: 'canonical-team-defense',
    });
    expect(mapped.unresolved.find((record) => record.playerName === 'Chris Smith')?.reason)
      .toBe('ambiguous-name');
  });
});
