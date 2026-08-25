import { describe, expect, it } from 'vitest';
import {
  calculateReplacementDemand,
  generateDraftRecommendations,
} from '../../packages/engine/draft/recommendations';
import { DRAFT_SCORE_WEIGHTS } from '../../packages/engine/draft/types';
import type { MappedProjection } from '../../packages/projections/types';
import type { SleeperDraftPick } from '../../packages/sleeper/types';
import {
  makeContext,
  makeDraft,
  makeLeague,
  makePlayerPool,
  makeProjections,
  makeRosters,
} from './fixtures';

const players = makePlayerPool(64);

function scenario({
  teams = 12,
  leagueType = 0,
  rosterPositions,
  scoring,
  leagueSettings = {},
  draftType = 'snake',
  draftName = 'Redraft',
  projections,
  picks = [],
  rosters = makeRosters(teams),
}: {
  teams?: number;
  leagueType?: number;
  rosterPositions?: string[];
  scoring?: Record<string, number>;
  leagueSettings?: Record<string, number | null>;
  draftType?: string;
  draftName?: string;
  projections?: MappedProjection[];
  picks?: SleeperDraftPick[];
  rosters?: ReturnType<typeof makeRosters>;
} = {}) {
  const league = makeLeague({
    teams,
    type: leagueType,
    rosterPositions,
    scoring,
    settings: leagueSettings,
  });
  const draft = makeDraft({ teams, type: draftType, name: draftName });
  const { context, board } = makeContext({
    league,
    draft,
    picks,
    rosters,
    players,
  });
  const inputProjections =
    projections ??
    makeProjections(
      players,
      rosterPositions?.includes('SUPER_FLEX') ? 'redraft_superflex' : 'redraft_1qb',
    );
  return {
    context,
    board,
    result: generateDraftRecommendations({
      context,
      picks,
      rosters,
      board,
      players,
      projections: inputProjections,
    }),
  };
}

describe('redraft format behavior matrix', () => {
  it('A/B/D: increasing league size deepens replacement level and raises scarcity', () => {
    const ten = scenario({ teams: 10 });
    const twelve = scenario({ teams: 12 });
    const fourteen = scenario({ teams: 14 });
    const tenDemand = calculateReplacementDemand('RB', ten.context);
    const twelveDemand = calculateReplacementDemand('RB', twelve.context);
    const fourteenDemand = calculateReplacementDemand('RB', fourteen.context);
    expect(tenDemand).toBeLessThan(twelveDemand);
    expect(twelveDemand).toBeLessThan(fourteenDemand);

    const playerName = 'RB Player 1';
    const vorp = [ten, twelve, fourteen].map(
      (item) =>
        item.result.recommendations.find(
          (recommendation) => recommendation.player.name === playerName,
        )!.raw.vorp,
    );
    expect(vorp[0]).toBeLessThan(vorp[1]);
    expect(vorp[1]).toBeLessThan(vorp[2]);
    expect(ten.result.recommendations[0].nextPickConfidence).toBe('medium');
    expect(twelve.result.recommendations[0].nextPickConfidence).toBe('high');
    expect(fourteen.result.recommendations[0].nextPickConfidence).toBe('medium');
  });

  it('C: Superflex materially increases quarterback replacement demand and VORP', () => {
    const oneQb = scenario();
    const superflex = scenario({
      rosterPositions: [
        'QB',
        'RB',
        'RB',
        'WR',
        'WR',
        'TE',
        'FLEX',
        'SUPER_FLEX',
        'BN',
        'BN',
        'BN',
        'BN',
        'BN',
        'BN',
      ],
    });
    const oneQbDemand = calculateReplacementDemand('QB', oneQb.context);
    const superflexDemand = calculateReplacementDemand('QB', superflex.context);
    expect(superflexDemand).toBeGreaterThan(oneQbDemand * 1.5);

    const oneQbValue = oneQb.result.recommendations.find(
      (item) => item.player.name === 'QB Player 1',
    )!;
    const superflexValue = superflex.result.recommendations.find(
      (item) => item.player.name === 'QB Player 1',
    )!;
    expect(superflexValue.raw.vorp - oneQbValue.raw.vorp).toBeGreaterThan(50);
  });

  it('K/L: deep benches and starting rosters move replacement demand', () => {
    const shallow = scenario({
      rosterPositions: ['QB', 'RB', 'WR', 'TE', 'FLEX', 'BN', 'BN'],
    });
    const deep = scenario({
      rosterPositions: [
        'QB',
        'RB',
        'RB',
        'WR',
        'WR',
        'WR',
        'TE',
        'FLEX',
        'FLEX',
        ...Array.from({ length: 10 }, () => 'BN'),
      ],
    });
    expect(calculateReplacementDemand('WR', deep.context)).toBeGreaterThan(
      calculateReplacementDemand('WR', shallow.context),
    );
  });

  it('keeps elite best-player-available value above a filled roster need', () => {
    const allProjections = makeProjections(players);
    const elite = allProjections.find((item) => item.playerName === 'WR Player 1')!;
    elite.projection = 600;
    elite.rank = 1;
    elite.adp = 1;
    const ownedReceivers = players.players
      .filter((player) => player.position === 'WR' && player.name !== 'WR Player 1')
      .slice(0, 5)
      .map((player) => player.externalIds.sleeper!);
    const result = scenario({
      projections: allProjections,
      rosters: makeRosters(12, { 1: ownedReceivers }),
    }).result;
    expect(result.recommendations[0].player.name).toBe('WR Player 1');
  });

  it('normalizes all score components and applies the published weights', () => {
    const recommendation = scenario().result.recommendations[0];
    for (const component of Object.values(recommendation.components)) {
      expect(component).toBeGreaterThanOrEqual(0);
      expect(component).toBeLessThanOrEqual(100);
    }
    const weighted =
      recommendation.components.vorp * DRAFT_SCORE_WEIGHTS.vorp +
      recommendation.components.nextPickRisk * DRAFT_SCORE_WEIGHTS.nextPickRisk +
      recommendation.components.tierUrgency * DRAFT_SCORE_WEIGHTS.tierUrgency +
      recommendation.components.projection * DRAFT_SCORE_WEIGHTS.projection +
      recommendation.components.rosterFit * DRAFT_SCORE_WEIGHTS.rosterFit +
      recommendation.components.adpValue * DRAFT_SCORE_WEIGHTS.adpValue +
      recommendation.components.scarcity * DRAFT_SCORE_WEIGHTS.scarcity;
    expect(recommendation.score).toBeCloseTo(weighted, 1);
  });

  it('does not treat reception-format metadata as proof of six-point passing scoring', () => {
    const result = scenario({
      scoring: {
        rec: 0,
        pass_yd: 0.04,
        pass_td: 6,
        pass_int: -2,
        rush_yd: 0.1,
        rush_td: 6,
        rec_yd: 0.1,
        rec_td: 6,
      },
    }).result;
    expect(result.status).toBe('limited');
    expect(result.scoringCoverage).toBe('aggregate_unverified');
  });
});

describe('availability and unsupported-mode safeguards', () => {
  it('never recommends drafted players or prefilled keeper picks', () => {
    const drafted = players.players.find((player) => player.name === 'QB Player 1')!;
    const keeper = players.players.find((player) => player.name === 'RB Player 1')!;
    const picks: SleeperDraftPick[] = [drafted, keeper].map((player, index) => ({
      player_id: player.externalIds.sleeper!,
      picked_by: `user-${index + 1}`,
      roster_id: String(index + 1),
      round: 1,
      draft_slot: index + 1,
      pick_no: index + 1,
      metadata: { position: player.position },
      is_keeper: index === 1,
    }));
    const { result, board } = scenario({ picks });
    const names = result.recommendations.map((item) => item.player.name);
    expect(names).not.toContain(drafted.name);
    expect(names).not.toContain(keeper.name);
    expect(board.keeperSleeperIds.has(keeper.externalIds.sleeper!)).toBe(true);
  });

  it('H: dynasty startup does not silently use redraft projections', () => {
    const result = scenario({
      leagueType: 2,
      draftName: 'Dynasty Startup',
    }).result;
    expect(result.status).toBe('data_required');
    expect(result.recommendations).toEqual([]);
    expect(result.messages.join(' ')).toContain('Redraft projections are intentionally not used');
  });

  it('I: dynasty rookie drafts require dynasty values and never recommend veterans', () => {
    const result = scenario({
      leagueType: 2,
      draftName: 'Rookie Supplemental Draft',
    }).result;
    expect(result.context.draftContext.value).toBe('rookie_supplemental');
    expect(result.status).toBe('data_required');
    expect(result.recommendations).toHaveLength(0);
  });

  it('J: keeper leagues are labeled current-season-only when economics are unknown', () => {
    const result = scenario({
      leagueType: 1,
      leagueSettings: { max_keepers: 3 },
    }).result;
    expect(result.status).toBe('limited');
    expect(result.messages.join(' ')).toContain('current-season only');
    expect(result.recommendations[0].nextPickConfidence).toBe('medium');
  });

  it('neutralizes classic roster-fit assumptions in Best Ball', () => {
    const result = scenario({ leagueSettings: { best_ball: 1 } }).result;
    expect(result.status).toBe('limited');
    expect(result.recommendations.every((item) => item.components.rosterFit === 50)).toBe(
      true,
    );
    expect(result.recommendations[0].nextPickConfidence).toBe('low');
  });

  it('disables snake-specific recommendations in auctions', () => {
    const result = scenario({ draftType: 'auction' }).result;
    expect(result.status).toBe('unsupported');
    expect(result.nextUserPick).toBeNull();
    expect(result.recommendations).toEqual([]);
  });

  it('labels unknown-format ADP probabilities as low confidence and downweights them', () => {
    const projections = makeProjections(players, 'unknown');
    const result = scenario({ projections }).result;
    expect(result.recommendations[0].nextPickConfidence).toBe('low');
    expect(result.recommendations[0].components.nextPickRisk).toBeGreaterThan(25);
    expect(result.recommendations[0].components.nextPickRisk).toBeLessThan(75);
  });

  it('pulls both ADP value and next-pick risk toward neutral when source confidence is weak', () => {
    const exactProjections = makeProjections(players).map((projection) => ({
      ...projection,
      adpMatchLevel: 'exact' as const,
      adpSourceConfidence: 'high' as const,
      adpSource: 'Exact ADP',
      adpMatchReasons: ['Exact test format.'],
    }));
    const target = exactProjections.find(
      (projection) => projection.playerName === 'RB Player 1',
    )!;
    target.adp = 40;
    const weakProjections = exactProjections.map((projection) => ({
      ...projection,
      adpMatchLevel: 'weak' as const,
      adpSourceConfidence: 'low' as const,
      adpSource: 'Weak ADP',
      adpMatchReasons: ['Format mismatch.'],
    }));

    const exact = scenario({ projections: exactProjections }).result.recommendations.find(
      (item) => item.player.name === 'RB Player 1',
    )!;
    const weak = scenario({ projections: weakProjections }).result.recommendations.find(
      (item) => item.player.name === 'RB Player 1',
    )!;

    expect(Math.abs(weak.components.adpValue - 50)).toBeLessThan(
      Math.abs(exact.components.adpValue - 50),
    );
    expect(Math.abs(weak.components.nextPickRisk - 50)).toBeLessThan(
      Math.abs(exact.components.nextPickRisk - 50),
    );
    expect(weak.nextPickConfidence).toBe('low');
    expect(weak.nextPickExplanation).toMatchObject({
      adpSource: 'Weak ADP',
      adpMatchLevel: 'weak',
      adpMatchReasons: ['Format mismatch.'],
    });
    expect(weak.nextPickExplanation.interveningTeamsWithNeed).toBeGreaterThan(0);
  });
});
