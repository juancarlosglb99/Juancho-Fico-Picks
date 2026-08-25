import { describe, expect, it } from 'vitest';
import { buildCanonicalPlayerMap } from '../../packages/players/player-map';
import { mapProjectionRecords } from '../../packages/projections/mapping';
import { parseProjectionCsv } from '../../packages/projections/providers/csv';
import { ProjectionCsvError } from '../../packages/projections/types';

const playerMap = buildCanonicalPlayerMap({
  '100': {
    player_id: '100',
    full_name: 'Nico Collins',
    position: 'WR',
    team: 'HOU',
    status: 'Active',
  },
  '200': {
    player_id: '200',
    full_name: 'Brian Robinson Jr.',
    position: 'RB',
    team: 'WAS',
    status: 'Active',
  },
});

describe('projection CSV provider', () => {
  it('parses required columns, aliases and quoted player names', () => {
    const records = parseProjectionCsv(
      'player,projected_points,adp,overall_rank,pos,sleeper_id\n"Collins, Nico",245.7,25.4,24,WR,100',
    );

    expect(records).toEqual([
      {
        sourceRow: 2,
        playerName: 'Collins, Nico',
        sleeperId: '100',
        position: 'WR',
        projection: 245.7,
        adp: 25.4,
        rank: 24,
      },
    ]);
  });

  it('rejects a CSV that is missing a required field', () => {
    expect(() =>
      parseProjectionCsv('player,projection,adp,position\nNico Collins,240,25,WR'),
    ).toThrow(ProjectionCsvError);
  });

  it('parses format metadata and granular stats when supplied', () => {
    const [record] = parseProjectionCsv(
      'player,projection,adp,rank,position,adp_format,projection_scoring,rush_yd,rush_td,rec,rec_yd,rec_td,fum_lost\nNico Collins,245.7,25.4,24,WR,redraft_1qb,full_ppr,0,0,82,1210,8,1',
    );
    expect(record).toMatchObject({
      adpFormat: 'redraft_1qb',
      projectionScoring: 'full_ppr',
      stats: {
        rushingYards: 0,
        rushingTouchdowns: 0,
        receptions: 82,
        receivingYards: 1210,
        receivingTouchdowns: 8,
        fumblesLost: 1,
      },
    });
  });
});

describe('projection player mapping', () => {
  it('prefers an exact Sleeper ID match', () => {
    const [record] = parseProjectionCsv(
      'player,projection,adp,rank,position,sleeper_id\nWrong Name,240,25,24,WR,100',
    );
    const result = mapProjectionRecords([record], playerMap);

    expect(result.mapped[0]).toMatchObject({
      playerId: 'jfp:100',
      matchMethod: 'sleeper-id',
      matchConfidence: 1,
    });
    expect(result.unmatched).toHaveLength(0);
  });

  it('normalizes suffixes for name-and-position matching', () => {
    const [record] = parseProjectionCsv(
      'player,projection,adp,rank,position\nBrian Robinson,210,70,65,RB',
    );
    const result = mapProjectionRecords([record], playerMap);

    expect(result.mapped[0]).toMatchObject({
      playerId: 'jfp:200',
      matchMethod: 'name-position',
    });
  });

  it('keeps unknown players in a review list', () => {
    const [record] = parseProjectionCsv(
      'player,projection,adp,rank,position\nMade Up Player,200,80,75,RB',
    );
    const result = mapProjectionRecords([record], playerMap);

    expect(result.mapped).toHaveLength(0);
    expect(result.unmatched[0]).toMatchObject({
      playerName: 'Made Up Player',
      reason: 'player-not-found',
    });
  });
});
