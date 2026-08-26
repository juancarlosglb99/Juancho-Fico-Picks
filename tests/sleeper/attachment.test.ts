import { describe, expect, it } from 'vitest';
import {
  buildDraftAttachment,
  describeDraftAttachment,
  isMockDraft,
  receptionPointsForScoringType,
  synthesizeLeagueForDraft,
  synthesizeRostersForDraft,
} from '../../packages/sleeper/attachment';
import { normalizeLeagueContext } from '../../packages/engine/context/normalize';
import { deriveDraftBoardState } from '../../packages/engine/draft/state';
import { buildCanonicalPlayerMap } from '../../packages/players/player-map';
import { makeDraft, makeLeague, makeRosters } from '../engine/fixtures';

const mockDraft = () => makeDraft({ leagueId: null, metadata: { scoring_type: 'ppr' } });

describe('isMockDraft', () => {
  it('is true only when there is no league behind the draft', () => {
    expect(isMockDraft(mockDraft())).toBe(true);
    expect(isMockDraft(makeDraft())).toBe(false);
  });
});

describe('receptionPointsForScoringType', () => {
  it('maps Sleeper scoring types to reception points', () => {
    expect(receptionPointsForScoringType('ppr')).toBe(1);
    expect(receptionPointsForScoringType('half_ppr')).toBe(0.5);
    expect(receptionPointsForScoringType('std')).toBe(0);
    expect(receptionPointsForScoringType(undefined)).toBe(0);
  });

  it('treats half-PPR as half even though the string contains "ppr"', () => {
    expect(receptionPointsForScoringType('half_ppr')).toBe(0.5);
  });
});

describe('synthesizeLeagueForDraft', () => {
  it('produces a redraft, classic-lineup league keyed to the draft', () => {
    const league = synthesizeLeagueForDraft(mockDraft());
    expect(league.draft_id).toBe('draft-1');
    expect(league.league_id).toBe('mock:draft-1');
    expect(league.settings.type).toBe(0);
    expect(league.settings.best_ball).toBe(0);
    expect(league.total_rosters).toBe(12);
  });

  it('carries the draft room scoring type into scoring settings', () => {
    expect(synthesizeLeagueForDraft(mockDraft()).scoring_settings?.rec).toBe(1);
    const half = makeDraft({ leagueId: null, metadata: { scoring_type: 'half_ppr' } });
    expect(synthesizeLeagueForDraft(half).scoring_settings?.rec).toBe(0.5);
  });

  it('leaves roster_positions empty so the engine reads the draft settings itself', () => {
    // Fabricating roster_positions would make an inference look like league data.
    expect(synthesizeLeagueForDraft(mockDraft()).roster_positions).toEqual([]);
  });

  it('honours a dynasty or keeper mock template', () => {
    const dynasty = makeDraft({ leagueId: null, metadata: { league_type: 'dynasty' } });
    expect(synthesizeLeagueForDraft(dynasty).settings.type).toBe(2);
  });
});

describe('synthesizeRostersForDraft', () => {
  it('creates one roster per draft slot, owned via draft_order', () => {
    const rosters = synthesizeRostersForDraft(mockDraft());
    expect(rosters).toHaveLength(12);
    expect(rosters[0]).toMatchObject({ roster_id: 1, owner_id: 'user-1' });
    expect(rosters[11]).toMatchObject({ roster_id: 12, owner_id: 'user-12' });
  });

  it('leaves ownerless slots null when the order is not published yet', () => {
    const draft = makeDraft({ leagueId: null, draftOrder: null });
    const rosters = synthesizeRostersForDraft(draft);
    expect(rosters).toHaveLength(12);
    expect(rosters.every((roster) => roster.owner_id === null)).toBe(true);
  });

  it('respects slot_to_roster_id rather than assuming slot === roster id', () => {
    const draft = mockDraft();
    draft.slot_to_roster_id = { '1': 7, '2': 3 };
    const rosters = synthesizeRostersForDraft(draft);
    expect(rosters[0].roster_id).toBe(7);
    expect(rosters[1].roster_id).toBe(3);
  });
});

describe('buildDraftAttachment', () => {
  it('passes a real league straight through untouched', () => {
    const league = makeLeague();
    const rosters = makeRosters();
    const attachment = buildDraftAttachment({ draft: makeDraft(), league, rosters });

    expect(attachment.source).toBe('league');
    expect(attachment.synthesized).toBe(false);
    expect(attachment.league).toBe(league);
    expect(attachment.rosters).toBe(rosters);
    expect(attachment.inferredNotes).toEqual([]);
  });

  it('synthesizes everything a mock draft is missing', () => {
    const attachment = buildDraftAttachment({ draft: mockDraft() });
    expect(attachment.source).toBe('mock');
    expect(attachment.synthesized).toBe(true);
    expect(attachment.rosters).toHaveLength(12);
    expect(attachment.inferredNotes.length).toBeGreaterThan(0);
  });

  it('says so when the draft room never reported a scoring type', () => {
    const attachment = buildDraftAttachment({
      draft: makeDraft({ leagueId: null }),
    });
    expect(attachment.inferredNotes.join(' ')).toMatch(/standard \(non-PPR\)/i);
  });

  it('says so when the draft order is not published yet', () => {
    const attachment = buildDraftAttachment({
      draft: makeDraft({ leagueId: null, draftOrder: null }),
    });
    expect(attachment.inferredNotes.join(' ')).toMatch(/draft order/i);
  });

  it('ignores a stale league object when the draft is really a mock', () => {
    const attachment = buildDraftAttachment({
      draft: mockDraft(),
      league: makeLeague(),
    });
    expect(attachment.source).toBe('mock');
  });
});

describe('describeDraftAttachment', () => {
  it('describes a mock in one line', () => {
    expect(describeDraftAttachment(mockDraft(), 'mock')).toBe(
      'Mock draft · 12 team PPR snake',
    );
  });

  it('flags superflex and third-round reversal', () => {
    const draft = makeDraft({
      leagueId: null,
      settings: { slots_super_flex: 1, reversal_round: 3 },
      metadata: { scoring_type: 'half_ppr' },
    });
    expect(describeDraftAttachment(draft, 'mock')).toBe(
      'Mock draft · 12 team Half-PPR Superflex 3RR',
    );
  });
});

describe('a synthesized mock travels the real engine path', () => {
  it('normalizes into a usable LeagueContext', () => {
    const draft = makeDraft({
      leagueId: null,
      status: 'drafting',
      metadata: { scoring_type: 'ppr' },
      settings: { slots_super_flex: 1 },
    });
    const attachment = buildDraftAttachment({ draft });
    const players = buildCanonicalPlayerMap({});
    const board = deriveDraftBoardState(draft, [], attachment.rosters, players);

    const context = normalizeLeagueContext({
      league: attachment.league,
      draft,
      drafts: [draft],
      picks: [],
      tradedPicks: [],
      rosters: attachment.rosters,
      board,
      userId: 'user-4',
    });

    // Roster shape came from draft.settings, and the engine labels it as such.
    expect(context.roster.value.QB).toBe(1);
    expect(context.roster.value.SUPER_FLEX).toBe(1);
    expect(context.roster.source).toBe('draft.settings');

    // The user's seat is resolved from draft_order, exactly as in a real league.
    expect(context.draftState.value.userDraftSlot).toBe(4);
    expect(context.leagueType.value).toBe('redraft');
    expect(context.draftType.value).toBe('snake');
  });
});
