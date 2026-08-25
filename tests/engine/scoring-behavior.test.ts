import { describe, expect, it } from 'vitest';
import { scoreProjectionForLeague } from '../../packages/engine/context/scoring';
import type { ProjectionRecord } from '../../packages/projections/types';
import {
  makeContext,
  makeDraft,
  makeLeague,
  makePlayerPool,
  makeRosters,
} from './fixtures';

const players = makePlayerPool(2);
const draft = makeDraft();
const rosters = makeRosters();

function scoring(scoringSettings: Record<string, number>) {
  return makeContext({
    league: makeLeague({ scoring: scoringSettings }),
    draft,
    rosters,
    players,
  }).context.scoring.value;
}

function record(overrides: Partial<ProjectionRecord>): ProjectionRecord {
  return {
    sourceRow: 2,
    playerName: 'Synthetic Player',
    position: 'WR',
    projection: 200,
    adp: 20,
    rank: 20,
    ...overrides,
  };
}

describe('league scoring applied to granular projections', () => {
  it('raises high-volume receiving value from standard to full PPR', () => {
    const receiver = record({
      stats: {
        rushingYards: 0,
        rushingTouchdowns: 0,
        receptions: 100,
        receivingYards: 1200,
        receivingTouchdowns: 8,
        fumblesLost: 0,
      },
    });
    const standard = scoreProjectionForLeague(receiver, scoring({ rec: 0, rec_yd: 0.1, rec_td: 6 }));
    const fullPpr = scoreProjectionForLeague(receiver, scoring({ rec: 1, rec_yd: 0.1, rec_td: 6 }));
    expect(fullPpr.points - standard.points).toBe(100);
    expect(fullPpr.adjustedForLeagueScoring).toBe(true);
  });

  it('places half-PPR reception value between standard and full PPR', () => {
    const receiver = record({
      stats: {
        rushingYards: 0,
        rushingTouchdowns: 0,
        receptions: 80,
        receivingYards: 1000,
        receivingTouchdowns: 6,
        fumblesLost: 0,
      },
    });
    const standard = scoreProjectionForLeague(
      receiver,
      scoring({ rec: 0, rec_yd: 0.1, rec_td: 6 }),
    );
    const halfPpr = scoreProjectionForLeague(
      receiver,
      scoring({ rec: 0.5, rec_yd: 0.1, rec_td: 6 }),
    );
    const fullPpr = scoreProjectionForLeague(
      receiver,
      scoring({ rec: 1, rec_yd: 0.1, rec_td: 6 }),
    );
    expect(halfPpr.points - standard.points).toBe(40);
    expect(fullPpr.points - halfPpr.points).toBe(40);
  });

  it('raises quarterback value when passing touchdowns move from four to six points', () => {
    const quarterback = record({
      position: 'QB',
      stats: {
        passingYards: 4500,
        passingTouchdowns: 35,
        interceptions: 10,
        rushingYards: 300,
        rushingTouchdowns: 3,
        fumblesLost: 2,
      },
    });
    const fourPoint = scoreProjectionForLeague(
      quarterback,
      scoring({ pass_yd: 0.04, pass_td: 4, pass_int: -2 }),
    );
    const sixPoint = scoreProjectionForLeague(
      quarterback,
      scoring({ pass_yd: 0.04, pass_td: 6, pass_int: -2 }),
    );
    expect(sixPoint.points - fourPoint.points).toBe(70);
  });

  it('applies TE premium without inflating an equivalent wide receiver', () => {
    const stats = {
      rushingYards: 0,
      rushingTouchdowns: 0,
      receptions: 90,
      receivingYards: 1000,
      receivingTouchdowns: 8,
      fumblesLost: 0,
    };
    const tightEnd = record({ position: 'TE', stats });
    const receiver = record({ position: 'WR', stats });
    const premium = scoring({
      rec: 0.5,
      bonus_rec_te: 0.5,
      rec_yd: 0.1,
      rec_td: 6,
    });
    const tePoints = scoreProjectionForLeague(tightEnd, premium).points;
    const wrPoints = scoreProjectionForLeague(receiver, premium).points;
    expect(tePoints - wrPoints).toBe(45);
  });

  it('applies custom position reception scoring directly from the stat line', () => {
    const runningBack = record({
      position: 'RB',
      stats: {
        rushingYards: 900,
        rushingTouchdowns: 7,
        receptions: 60,
        receivingYards: 450,
        receivingTouchdowns: 3,
        fumblesLost: 1,
      },
    });
    const base = scoring({
      rec: 0.5,
      rec_yd: 0.1,
      rec_td: 6,
      rush_yd: 0.1,
      rush_td: 6,
      fum_lost: -2,
    });
    const premium = scoring({
      rec: 0.5,
      bonus_rec_rb: 0.25,
      rec_yd: 0.1,
      rec_td: 6,
      rush_yd: 0.1,
      rush_td: 6,
      fum_lost: -2,
    });
    expect(
      scoreProjectionForLeague(runningBack, premium).points -
        scoreProjectionForLeague(runningBack, base).points,
    ).toBe(15);
  });

  it('does not call a partial stat line league-recalculated', () => {
    const partial = record({
      stats: { receptions: 100, receivingYards: 1200, receivingTouchdowns: 8 },
    });
    const result = scoreProjectionForLeague(
      partial,
      scoring({ rec: 1, rec_yd: 0.1, rec_td: 6 }),
    );
    expect(result.adjustedForLeagueScoring).toBe(false);
    expect(result.points).toBe(partial.projection);
  });

  it('surfaces scoring events that the projection columns cannot calculate', () => {
    const quarterback = record({
      position: 'QB',
      stats: {
        passingYards: 4500,
        passingTouchdowns: 35,
        interceptions: 10,
        rushingYards: 300,
        rushingTouchdowns: 3,
        fumblesLost: 2,
      },
    });
    const result = scoreProjectionForLeague(
      quarterback,
      scoring({
        pass_yd: 0.04,
        pass_td: 4,
        pass_int: -2,
        rush_yd: 0.1,
        rush_td: 6,
        pass_2pt: 2,
      }),
    );
    expect(result.adjustedForLeagueScoring).toBe(true);
    expect(result.limitations.join(' ')).toContain('pass_2pt');
  });

  it('keeps aggregate provider points unchanged and reports the limitation', () => {
    const aggregate = record({ projection: 247.5 });
    const result = scoreProjectionForLeague(aggregate, scoring({ rec: 1 }));
    expect(result.points).toBe(247.5);
    expect(result.adjustedForLeagueScoring).toBe(false);
    expect(result.limitations.join(' ')).toContain('aggregate fantasy points');
  });
});
