/**
 * "Select a draft", instead of a league and then a draft.
 *
 * The old flow exposed Sleeper's data model directly - leagues contain drafts,
 * mocks belong to no league - which is two decisions to reach one thing and
 * strands mocks in a list of their own. These hold the properties that make one
 * flat list correct rather than merely shorter.
 */
import { describe, expect, it } from 'vitest';
import { buildDraftChoices, describeDraft, needsLeagueFallback } from '../../packages/ui/draft-picker';
import type { SleeperDraft, SleeperLeague } from '../../packages/sleeper/types';

const USER = 'user-1';

function draft(overrides: Partial<SleeperDraft> = {}): SleeperDraft {
  return {
    draft_id: 'd1',
    league_id: 'L1',
    status: 'pre_draft',
    type: 'snake',
    season: '2026',
    start_time: null,
    last_picked: null,
    settings: { teams: 12, rounds: 15 },
    metadata: { scoring_type: 'ppr' },
    draft_order: { [USER]: 7 },
    slot_to_roster_id: null,
    ...overrides,
  };
}

function league(id: string, name: string): SleeperLeague {
  return { league_id: id, name } as SleeperLeague;
}

describe('what a draft card says', () => {
  it('reads like a person describing their league', () => {
    expect(describeDraft(draft(), USER)).toBe('12 team · PPR · Pick 7');
  });

  it('leaves out what it does not know rather than guessing', () => {
    const sparse = draft({ settings: {}, metadata: {}, draft_order: null });
    expect(describeDraft(sparse, USER)).toBe('');
  });

  it('omits the pick when the draft order does not include this user', () => {
    expect(describeDraft(draft({ draft_order: { someone: 3 } }), USER)).toBe('12 team · PPR');
  });
});

describe('one list of drafts', () => {
  const leagues = [league('L1', 'Escorpiones'), league('L2', 'Segunda')];

  it('names a league draft after the league, not after the draft id', () => {
    const [choice] = buildDraftChoices({ drafts: [draft()], leagues, userId: USER });
    expect(choice.title).toBe('Escorpiones');
    expect(choice.subtitle).toBe('12 team · PPR · Pick 7');
    expect(choice.leagueId).toBe('L1');
  });

  it('puts mocks in the SAME list, which is the whole point', () => {
    const choices = buildDraftChoices({
      drafts: [draft({ draft_id: 'm1', league_id: null, status: 'pre_draft' }), draft()],
      leagues,
      userId: USER,
    });
    expect(choices).toHaveLength(2);
    expect(choices.map((choice) => choice.kind).sort()).toEqual(['mock', 'upcoming']);
  });

  it('orders by what somebody is most likely to want', () => {
    const choices = buildDraftChoices({
      drafts: [
        draft({ draft_id: 'done', status: 'complete' }),
        draft({ draft_id: 'mock', league_id: null }),
        draft({ draft_id: 'live', status: 'drafting' }),
        draft({ draft_id: 'soon' }),
      ],
      leagues,
      userId: USER,
    });
    expect(choices.map((choice) => choice.draftId)).toEqual(['live', 'soon', 'mock', 'done']);
  });

  it('says what each card will do, in the words of the thing it is', () => {
    const choices = buildDraftChoices({
      drafts: [draft({ status: 'drafting' }), draft({ draft_id: 'm', league_id: null })],
      leagues,
      userId: USER,
    });
    expect(choices[0].cta).toBe('Enter draft');
    expect(choices[1].cta).toBe('Open mock');
  });

  it('flags the one case that still deserves a second choice', () => {
    /*
     * A league with two drafts is the only reason the old two-step flow ever
     * earned its place. It is detected rather than assumed, because most
     * leagues have exactly one.
     */
    const choices = buildDraftChoices({
      drafts: [draft({ draft_id: 'a' }), draft({ draft_id: 'b' })],
      leagues,
      userId: USER,
    });
    expect(choices.every((choice) => choice.leagueHasSiblings)).toBe(true);

    const single = buildDraftChoices({ drafts: [draft()], leagues, userId: USER });
    expect(single[0].leagueHasSiblings).toBe(false);
  });
});

describe('when the league route is still worth offering', () => {
  const leagues = [league('L1', 'Escorpiones'), league('L2', 'Segunda')];

  it('is offered when Sleeper did not return a draft for a league', () => {
    const choices = buildDraftChoices({ drafts: [draft()], leagues, userId: USER });
    // L2 has no draft in the flat list, so it would be unreachable without it.
    expect(needsLeagueFallback({ choices, leagues })).toBe(true);
  });

  it('is NOT offered when every league is already reachable', () => {
    const choices = buildDraftChoices({
      drafts: [draft(), draft({ draft_id: 'd2', league_id: 'L2' })],
      leagues,
      userId: USER,
    });
    expect(needsLeagueFallback({ choices, leagues })).toBe(false);
  });

  it('is not offered to somebody with no leagues at all', () => {
    expect(needsLeagueFallback({ choices: [], leagues: [] })).toBe(false);
  });
});
