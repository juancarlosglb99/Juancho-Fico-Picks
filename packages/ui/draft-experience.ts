import type { DraftRecommendationResult } from '../engine/draft/types';
import type { SleeperDraft } from '../sleeper/types';

export type DraftExperienceState =
  | 'pre_draft'
  | 'on_clock'
  | 'waiting'
  | 'complete'
  | 'data_required'
  | 'unsupported'
  | 'limited';

export function deriveDraftExperienceState({
  draft,
  recommendation,
  isUserOnClock,
}: {
  draft: SleeperDraft;
  recommendation: DraftRecommendationResult | null;
  isUserOnClock: boolean;
}): DraftExperienceState {
  if (draft.status === 'complete') return 'complete';
  if (recommendation?.status === 'data_required') return 'data_required';
  if (recommendation?.status === 'unsupported') return 'unsupported';
  if (draft.status === 'pre_draft') return 'pre_draft';
  if (recommendation?.status === 'limited') return 'limited';
  return isUserOnClock ? 'on_clock' : 'waiting';
}
