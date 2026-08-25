import { describe, expect, it } from 'vitest';
import { deriveDraftExperienceState } from '../../packages/ui/draft-experience';
import type { DraftRecommendationResult } from '../../packages/engine/draft/types';
import { makeContext, makeDraft, makeLeague, makePlayerPool, makeRosters } from '../engine/fixtures';

function recommendation(
  status: DraftRecommendationResult['status'],
): DraftRecommendationResult {
  const players = makePlayerPool(1);
  const draft = makeDraft();
  const { context } = makeContext({
    league: makeLeague(),
    draft,
    rosters: makeRosters(),
    players,
  });
  return {
    recommendations: [],
    status,
    messages: [],
    scoringCoverage: 'provider_precalculated',
    context,
    nextUserPick: 1,
    picksUntilNextUserPick: 0,
    userDraftSlot: 1,
    userRosterId: 1,
  };
}

describe('draft experience states', () => {
  it('covers pre-draft, on-clock, waiting, and complete states', () => {
    const draft = makeDraft();
    expect(
      deriveDraftExperienceState({
        draft: { ...draft, status: 'pre_draft' },
        recommendation: recommendation('ready'),
        isUserOnClock: false,
      }),
    ).toBe('pre_draft');
    expect(
      deriveDraftExperienceState({
        draft,
        recommendation: recommendation('ready'),
        isUserOnClock: true,
      }),
    ).toBe('on_clock');
    expect(
      deriveDraftExperienceState({
        draft,
        recommendation: recommendation('ready'),
        isUserOnClock: false,
      }),
    ).toBe('waiting');
    expect(
      deriveDraftExperienceState({
        draft: { ...draft, status: 'complete' },
        recommendation: recommendation('ready'),
        isUserOnClock: false,
      }),
    ).toBe('complete');
  });

  it('surfaces data-required, unsupported, and limited states before clock status', () => {
    const draft = makeDraft();
    expect(
      deriveDraftExperienceState({
        draft,
        recommendation: recommendation('data_required'),
        isUserOnClock: true,
      }),
    ).toBe('data_required');
    expect(
      deriveDraftExperienceState({
        draft,
        recommendation: recommendation('unsupported'),
        isUserOnClock: true,
      }),
    ).toBe('unsupported');
    expect(
      deriveDraftExperienceState({
        draft,
        recommendation: recommendation('limited'),
        isUserOnClock: true,
      }),
    ).toBe('limited');
  });
});
