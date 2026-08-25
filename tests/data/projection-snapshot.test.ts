import { describe, expect, it } from 'vitest';
import {
  composeProjectionAndAdp,
  createCsvProjectionSnapshot,
  isProjectionSnapshot,
} from '../../packages/data/projections';
import type { AdpSnapshot } from '../../packages/data/types';
import { makePlayerPool, makeProjections } from '../engine/fixtures';

const players = makePlayerPool(2);

describe('projection snapshots and source composition', () => {
  it('normalizes a CSV import with provenance, coverage, and complete stat-line counts', () => {
    const mapped = makeProjections(players, 'redraft_1qb', 'full_ppr').slice(0, 2);
    mapped[0].stats = {
      passingYards: 4500,
      passingTouchdowns: 32,
      interceptions: 10,
      rushingYards: 300,
      rushingTouchdowns: 3,
      fumblesLost: 2,
    };
    const snapshot = createCsvProjectionSnapshot({
      mapping: {
        mapped,
        unmatched: [
          {
            sourceRow: 99,
            playerName: 'Missing Player',
            position: 'WR',
            projection: 200,
            adp: 40,
            rank: 40,
            reason: 'player-not-found',
          },
        ],
      },
      filename: 'projections.csv',
      season: '2026',
      now: new Date('2026-08-25T12:00:00Z'),
    });

    expect(snapshot.provenance.sourceLabel).toBe('CSV · projections.csv');
    expect(snapshot.scoringFormat).toBe('full_ppr');
    expect(snapshot.resolution).toMatchObject({ total: 3, matched: 2, unresolved: 1 });
    expect(snapshot.completeStatLines).toBe(1);
    expect(snapshot.records[0]).toMatchObject({
      projectionSource: 'CSV · projections.csv',
      adpSource: 'CSV · projections.csv',
      adpMatchLevel: 'approximate',
    });
    expect(isProjectionSnapshot(snapshot)).toBe(true);
  });

  it('uses matched automatic ADP while retaining CSV fallback for unresolved players', () => {
    const snapshot = createCsvProjectionSnapshot({
      mapping: { mapped: makeProjections(players).slice(0, 2), unmatched: [] },
      filename: 'projections.csv',
      season: '2026',
    });
    const automaticPlayer = snapshot.records[0];
    const adp: AdpSnapshot = {
      kind: 'adp',
      provenance: {
        sourceId: 'ffc',
        sourceLabel: 'Fantasy Football Calculator',
        season: '2026',
        fetchedAt: '2026-08-25T12:00:00.000Z',
        sourceUpdatedAt: '2026-08-25T00:00:00.000Z',
        sourceConfidence: 'high',
      },
      context: {
        leagueFormat: 'redraft_1qb',
        qbFormat: '1qb',
        scoringFormat: 'standard',
        teams: 12,
        sampleSize: 500,
      },
      records: [
        {
          playerId: automaticPlayer.playerId,
          playerName: automaticPlayer.playerName,
          position: automaticPlayer.position,
          team: null,
          adp: 7.5,
          rank: 8,
          sampleSize: 400,
          standardDeviation: 2,
          resolutionMethod: 'direct-external-id',
          resolutionConfidence: 1,
        },
      ],
      unresolved: [],
      resolution: {
        total: 1,
        matched: 1,
        directExternalId: 1,
        exactCanonical: 0,
        normalizedName: 0,
        ambiguous: 0,
        unresolved: 0,
      },
      compatibility: {
        level: 'exact',
        confidence: 'high',
        reasons: ['Exact format match.'],
      },
    };

    const composed = composeProjectionAndAdp(snapshot, adp);
    expect(composed[0]).toMatchObject({
      adp: 7.5,
      rank: 8,
      adpSource: 'Fantasy Football Calculator',
      adpTeams: 12,
      adpSampleSize: 400,
      adpMatchLevel: 'exact',
    });
    expect(composed[1].adp).toBe(snapshot.records[1].adp);
    expect(composed[1].adpSource).toBe('CSV · projections.csv');
    expect(composeProjectionAndAdp(snapshot, null)).toEqual(snapshot.records);
  });

  it('rejects a cached projection snapshot with a malformed mapped row', () => {
    const snapshot = createCsvProjectionSnapshot({
      mapping: { mapped: makeProjections(players).slice(0, 1), unmatched: [] },
      filename: 'projections.csv',
      season: '2026',
    });
    expect(
      isProjectionSnapshot({
        ...snapshot,
        records: [{ ...snapshot.records[0], projection: Number.NaN }],
      }),
    ).toBe(false);
  });
});
