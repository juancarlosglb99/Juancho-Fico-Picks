import { describe, expect, it } from 'vitest';
import {
  mapAdpSnapshot,
  planAutomaticAdp,
} from '../../packages/adp/automatic';
import type { AdpSourceSnapshot, RawAdpRecord } from '../../packages/data/types';
import { buildCanonicalPlayerMap } from '../../packages/players/player-map';
import { makeContext, makeDraft, makeLeague, makeRosters } from '../engine/fixtures';

function context({
  teams = 12,
  leagueType = 0,
  rosterPositions,
  scoring,
}: {
  teams?: number;
  leagueType?: number;
  rosterPositions?: string[];
  scoring?: Record<string, number>;
} = {}) {
  const players = buildCanonicalPlayerMap({
    '100': {
      player_id: '100',
      full_name: 'Brian Robinson Jr.',
      position: 'RB',
      team: 'WAS',
    },
  });
  return makeContext({
    league: makeLeague({ teams, type: leagueType, rosterPositions, scoring }),
    draft: makeDraft({ teams }),
    rosters: makeRosters(teams),
    players,
  }).context;
}

function source(
  records: RawAdpRecord[],
  overrides: Partial<AdpSourceSnapshot> = {},
): AdpSourceSnapshot {
  return {
    kind: 'adp-source',
    provenance: {
      sourceId: 'test-adp',
      sourceLabel: 'Test ADP',
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
      sampleSize: 1000,
    },
    records,
    ...overrides,
  };
}

function raw(
  playerName: string,
  position: RawAdpRecord['position'],
  sleeperId?: string,
): RawAdpRecord {
  return {
    playerName,
    position,
    sleeperId,
    team: null,
    adp: 12,
    rank: 12,
    sampleSize: 100,
    standardDeviation: 2,
  };
}

describe('automatic ADP planning', () => {
  it.each([10, 12])('selects %s-team PPR ADP for a matching 1QB redraft', (teams) => {
    const plan = planAutomaticAdp(
      context({
        teams,
        scoring: {
          rec: 1,
          pass_yd: 0.04,
          pass_td: 4,
          pass_int: -2,
          rush_yd: 0.1,
          rush_td: 6,
          rec_yd: 0.1,
          rec_td: 6,
        },
      }),
      '2026',
    );
    expect(plan?.request).toEqual({ season: '2026', teams, format: 'ppr' });
  });

  it('selects exact redraft formats and the closest supported league size', () => {
    const plan = planAutomaticAdp(context({ teams: 11 }), '2026');
    expect(plan?.request).toEqual({ season: '2026', teams: 10, format: 'standard' });
    expect(plan?.notes.join(' ')).toContain('closest supported size');
  });

  it('uses 2QB data for Superflex and labels its reception-scoring limitation', () => {
    const plan = planAutomaticAdp(
      context({
        rosterPositions: ['QB', 'RB', 'WR', 'TE', 'SUPER_FLEX', 'BN'],
      }),
      '2026',
    );
    expect(plan?.request.format).toBe('2qb');
    expect(plan?.expectedLeagueFormat).toBe('redraft_superflex');
    expect(plan?.notes.join(' ')).toContain('does not declare reception scoring');
  });

  it('chooses the nearest reception format for custom scoring', () => {
    const plan = planAutomaticAdp(
      context({
        scoring: {
          rec: 0.6,
          bonus_rec_te: 0.4,
          pass_yd: 0.04,
          pass_td: 4,
          pass_int: -2,
          rush_yd: 0.1,
          rush_td: 6,
          rec_yd: 0.1,
          rec_td: 6,
        },
      }),
      '2026',
    );
    expect(plan?.request.format).toBe('half-ppr');
    expect(plan?.notes.join(' ')).toContain('nearest reception format');
  });

  it('does not auto-apply redraft ADP to dynasty or auctions', () => {
    expect(planAutomaticAdp(context({ leagueType: 2 }), '2026')).toBeNull();
    const auctionContext = context();
    auctionContext.draftType.value = 'auction';
    expect(planAutomaticAdp(auctionContext, '2026')).toBeNull();
  });
});

describe('canonical ADP resolution and compatibility', () => {
  const playerMap = buildCanonicalPlayerMap({
    '100': {
      player_id: '100',
      full_name: 'Brian Robinson Jr.',
      position: 'RB',
      team: 'WAS',
    },
    '200': {
      player_id: '200',
      full_name: 'Chris Smith',
      position: 'WR',
      team: 'AAA',
    },
    '201': {
      player_id: '201',
      full_name: 'Chris Smith',
      position: 'WR',
      team: 'BBB',
    },
    '300': {
      player_id: '300',
      full_name: 'Unique Player',
      position: 'TE',
      team: 'CCC',
    },
    SEA: {
      player_id: 'SEA',
      first_name: 'Seattle',
      last_name: 'Seahawks',
      position: 'DEF',
      team: 'SEA',
    },
  });

  it('tracks direct, exact, unique-name, ambiguous, and unresolved outcomes', () => {
    const snapshot = mapAdpSnapshot(
      source([
        raw('Wrong Name', 'RB', '100'),
        raw('Brian Robinson', 'RB'),
        raw('Unique Player', 'WR'),
        { ...raw('Seattle Defense', 'DEF'), team: 'SEA' },
        raw('Chris Smith', 'WR'),
        raw('Missing Player', 'QB'),
      ]),
      playerMap,
      context(),
      new Date('2026-08-25T12:00:00Z'),
    );

    expect(snapshot.resolution).toEqual({
      total: 6,
      matched: 4,
      directExternalId: 1,
      exactCanonical: 2,
      normalizedName: 1,
      ambiguous: 1,
      unresolved: 1,
    });
    expect(snapshot.unresolved.map((record) => record.reason)).toEqual([
      'ambiguous-name',
      'player-not-found',
    ]);
    expect(snapshot.records.map((record) => record.resolutionConfidence)).toEqual([
      1,
      0.95,
      0.8,
      0.95,
    ]);
    expect(snapshot.records[3].resolutionMethod).toBe('canonical-team-defense');
  });

  it('labels an exact fresh format match with high confidence', () => {
    const snapshot = mapAdpSnapshot(
      source([raw('Brian Robinson', 'RB')]),
      playerMap,
      context(),
      new Date('2026-08-25T12:00:00Z'),
    );
    expect(snapshot.compatibility).toEqual({
      level: 'exact',
      confidence: 'high',
      reasons: ['League size, quarterback format, and reception scoring match the source.'],
    });
  });

  it('makes closest-size and custom-scoring matches approximate', () => {
    const closestSize = mapAdpSnapshot(
      source([raw('Brian Robinson', 'RB')]),
      playerMap,
      context({ teams: 11 }),
      new Date('2026-08-25T12:00:00Z'),
    );
    expect(closestSize.compatibility.level).toBe('approximate');
    expect(closestSize.compatibility.confidence).toBe('medium');
    expect(closestSize.compatibility.reasons.join(' ')).toContain('12-team ADP');
  });

  it('marks quarterback-format, reception-format, and stale-data mismatches weak', () => {
    const staleSource = source([raw('Brian Robinson', 'RB')], {
      provenance: {
        ...source([]).provenance,
        sourceUpdatedAt: '2026-08-01T00:00:00.000Z',
      },
    });
    const superflex = context({
      rosterPositions: ['QB', 'RB', 'WR', 'TE', 'SUPER_FLEX', 'BN'],
      scoring: {
        rec: 1,
        pass_yd: 0.04,
        pass_td: 4,
        pass_int: -2,
        rush_yd: 0.1,
        rush_td: 6,
        rec_yd: 0.1,
        rec_td: 6,
      },
    });
    const snapshot = mapAdpSnapshot(
      staleSource,
      playerMap,
      superflex,
      new Date('2026-08-25T12:00:00Z'),
    );
    expect(snapshot.compatibility.level).toBe('weak');
    expect(snapshot.compatibility.confidence).toBe('low');
    expect(snapshot.compatibility.reasons.join(' ')).toContain('quarterback demand');
    expect(snapshot.compatibility.reasons.join(' ')).toContain('does not match full ppr');
    expect(snapshot.compatibility.reasons.join(' ')).toContain('more than seven days old');
  });
});
