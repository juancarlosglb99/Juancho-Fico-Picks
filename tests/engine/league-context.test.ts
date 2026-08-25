import { describe, expect, it } from 'vitest';
import {
  makeContext,
  makeDraft,
  makeLeague,
  makePlayerPool,
  makeRosters,
} from './fixtures';

const players = makePlayerPool(4);

describe('LeagueContext format detection', () => {
  it.each([
    [0, 'redraft'],
    [1, 'keeper'],
    [2, 'dynasty'],
    [3, 'unknown'],
  ] as const)('maps defensive Sleeper league type %s to %s', (type, expected) => {
    const league = makeLeague({ type });
    const draft = makeDraft();
    const { context } = makeContext({
      league,
      draft,
      rosters: makeRosters(),
      players,
    });
    expect(context.leagueType.value).toBe(expected);
    expect(context.leagueType.source).toBe('league.settings.type');
  });

  it('allows an explicit override when Sleeper is ambiguous', () => {
    const league = makeLeague({ type: 3 });
    const draft = makeDraft();
    const { context } = makeContext({
      league,
      draft,
      rosters: makeRosters(),
      players,
      overrides: { leagueType: 'redraft' },
    });
    expect(context.leagueType).toEqual({
      value: 'redraft',
      source: 'manual override',
      confidence: 'high',
    });
  });

  it('separates dynasty startup and rookie draft context', () => {
    const league = makeLeague({ type: 2 });
    const rosters = makeRosters();
    const startup = makeContext({
      league,
      draft: makeDraft({ name: '2026 Dynasty Startup' }),
      rosters,
      players,
    }).context;
    const rookie = makeContext({
      league,
      draft: makeDraft({ rounds: 4, name: '2026 Rookie Supplemental' }),
      rosters,
      players,
    }).context;
    expect(startup.draftContext.value).toBe('startup');
    expect(rookie.draftContext.value).toBe('rookie_supplemental');
  });

  it('detects 3RR and Best Ball independently', () => {
    const league = makeLeague({ settings: { best_ball: 1 } });
    const draft = makeDraft({ settings: { reversal_round: 3 } });
    const { context } = makeContext({
      league,
      draft,
      rosters: makeRosters(),
      players,
    });
    expect(context.draftType.value).toBe('3rr');
    expect(context.lineupType.value).toBe('best_ball');
  });
});

describe('LeagueContext roster and scoring normalization', () => {
  it('normalizes Superflex, flex aliases, IDP, bench, taxi and IR', () => {
    const league = makeLeague({
      rosterPositions: [
        'QB',
        'RB',
        'WR',
        'TE',
        'WRRB_FLEX',
        'SUPER_FLEX',
        'DL',
        'LB',
        'DB',
        'IDP_FLEX',
        'BN',
        'BN',
      ],
      settings: { taxi_slots: 3, reserve_slots: 2 },
    });
    const { context } = makeContext({
      league,
      draft: makeDraft(),
      rosters: makeRosters(),
      players,
    });
    expect(context.roster.value).toMatchObject({
      QB: 1,
      FLEX: 1,
      SUPER_FLEX: 1,
      bench: 2,
      taxi: 3,
      IR: 2,
      idp: { DL: 1, LB: 1, DB: 1, IDP_FLEX: 1 },
    });
  });

  it.each([
    [0, 'standard'],
    [0.5, 'half_ppr'],
    [1, 'full_ppr'],
  ] as const)('normalizes %s receptions as %s', (rec, profile) => {
    const league = makeLeague({ scoring: { rec, pass_td: 4 } });
    const { context } = makeContext({
      league,
      draft: makeDraft(),
      rosters: makeRosters(),
      players,
    });
    expect(context.scoring.value.profile).toBe(profile);
  });

  it('detects custom receptions, TE premium and six-point passing touchdowns', () => {
    const league = makeLeague({
      scoring: {
        rec: 0.5,
        bonus_rec_rb: 0.25,
        bonus_rec_te: 1,
        pass_td: 6,
      },
    });
    const { context } = makeContext({
      league,
      draft: makeDraft(),
      rosters: makeRosters(),
      players,
    });
    expect(context.scoring.value.profile).toBe('custom');
    expect(context.scoring.value.reception.byPosition).toEqual({
      RB: 0.75,
      WR: 0.5,
      TE: 1.5,
    });
    expect(context.scoring.value.tePremium).toBe(1);
    expect(context.scoring.value.passing.touchdowns).toBe(6);
  });

  it('distinguishes keeper detection from fully known keeper economics', () => {
    const league = makeLeague({ type: 1, settings: { max_keepers: 3 } });
    const { context } = makeContext({
      league,
      draft: makeDraft(),
      rosters: makeRosters(),
      players,
    });
    expect(context.keeperSettings.value).toMatchObject({
      detected: true,
      rulesFullyKnown: false,
      numberOfKeepers: 3,
      roundPenalty: null,
    });
    expect(context.warnings.join(' ')).toContain('keeper costs');
  });
});

describe('LeagueContext draft state', () => {
  it.each([
    { label: 'early', slot: 1, picksMade: 0, nextPick: 24, intervening: 22 },
    { label: 'middle', slot: 6, picksMade: 5, nextPick: 19, intervening: 12 },
    { label: 'late turn', slot: 12, picksMade: 11, nextPick: 13, intervening: 0 },
  ])(
    'models an on-clock user in the $label slot and finds the following snake turn',
    ({ slot, picksMade, nextPick, intervening }) => {
      const picks = Array.from({ length: picksMade }, (_, index) => ({
        player_id: `drafted-${index + 1}`,
        picked_by: `user-${index + 1}`,
        roster_id: String(index + 1),
        round: 1,
        draft_slot: index + 1,
        pick_no: index + 1,
        metadata: {},
      }));
      const { context } = makeContext({
        league: makeLeague(),
        draft: makeDraft(),
        picks,
        rosters: makeRosters(),
        players,
        userId: `user-${slot}`,
      });

      expect(context.draftState.value.currentSelection?.ownerRosterId).toBe(slot);
      expect(context.draftState.value.isUserOnClock).toBe(true);
      expect(context.draftState.value.nextUserPick).toBe(nextPick);
      expect(context.draftState.value.picksBeforeNextSelection).toBe(intervening);
      expect(context.draftState.value.interveningSelections).toHaveLength(intervening);
    },
  );

  it('tracks keeper picks and uses traded-pick ownership for the next selection', () => {
    const league = makeLeague({ teams: 4 });
    const draft = makeDraft({ teams: 4, rounds: 10 });
    const picks = [1, 2, 3, 4].map((pickNo) => ({
      player_id: String(pickNo),
      picked_by: `user-${pickNo}`,
      roster_id: String(pickNo),
      round: 1,
      draft_slot: pickNo,
      pick_no: pickNo,
      metadata: { position: pickNo === 1 ? 'QB' : 'RB' },
      is_keeper: pickNo === 2,
    }));
    const tradedPicks = [
      {
        season: '2026',
        round: 2,
        roster_id: 3,
        previous_owner_id: 3,
        owner_id: 1,
      },
    ];
    const { context } = makeContext({
      league,
      draft,
      picks,
      tradedPicks,
      rosters: makeRosters(4),
      players,
    });
    expect(context.draftState.value.keeperPlayerIds).toEqual(['2']);
    expect(context.draftState.value.nextUserPick).toBe(6);
    expect(context.draftState.value.picksBeforeNextSelection).toBe(1);
    expect(context.draftState.value.interveningSelections).toHaveLength(1);
  });
});
