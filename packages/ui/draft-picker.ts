/**
 * "Select a draft" - one list, instead of a league and then a draft.
 *
 * Sleeper's data model has leagues that contain drafts, and mock drafts that
 * belong to no league at all. The old flow exposed that shape directly: choose
 * a league, then choose a draft inside it - which is two decisions to reach one
 * thing, and it strands mocks in a separate list because they have no league to
 * be chosen from.
 *
 * A drafter is not thinking about leagues. They are thinking "the Escorpiones
 * draft is tonight". So the list is drafts, the league is resolved behind them,
 * and the awkward case - one league with several drafts worth showing - is
 * detected rather than assumed away.
 *
 * The data model underneath is untouched: this reads the same `/user/{id}/drafts`
 * response the app already fetches and joins it to the leagues already loaded.
 */
import type { SleeperDraft, SleeperLeague } from '../sleeper/types';
import { displayEnum } from './theme';

export type DraftChoiceKind = 'live' | 'upcoming' | 'mock' | 'complete';

export interface DraftChoice {
  draftId: string;
  leagueId: string | null;
  /** What a person calls it: the league's name, or the mock's. */
  title: string;
  /** "12 team · PPR · Pick 7" */
  subtitle: string;
  /** The badge above the card. */
  kindLabel: string;
  kind: DraftChoiceKind;
  cta: string;
  /**
   * True when this league has more than one draft worth showing.
   *
   * The only case that still deserves a second-level chooser, and the reason
   * this is computed rather than assumed: most leagues have exactly one.
   */
  leagueHasSiblings: boolean;
}

const KIND_ORDER: Record<DraftChoiceKind, number> = {
  live: 0,
  upcoming: 1,
  mock: 2,
  complete: 3,
};

const KIND_LABEL: Record<DraftChoiceKind, string> = {
  live: 'Live draft',
  upcoming: 'Upcoming draft',
  mock: 'Mock draft',
  complete: 'Completed draft',
};

const KIND_CTA: Record<DraftChoiceKind, string> = {
  live: 'Enter draft',
  upcoming: 'Enter draft',
  mock: 'Open mock',
  complete: 'Review draft',
};

function kindOf(draft: SleeperDraft): DraftChoiceKind {
  if (draft.status === 'complete') return 'complete';
  // A draft with no league is a mock: that is the only way Sleeper marks one.
  if (!draft.league_id) return 'mock';
  return draft.status === 'drafting' || draft.status === 'paused' ? 'live' : 'upcoming';
}

/** "12 team · PPR · Pick 7", skipping anything we genuinely do not know. */
export function describeDraft(draft: SleeperDraft, userId: string | null): string {
  const parts: string[] = [];
  const teams = draft.settings.teams;
  if (teams) parts.push(`${teams} team`);

  const scoring = draft.metadata.scoring_type;
  if (scoring) parts.push(displayEnum(scoring));

  const slot = userId ? draft.draft_order?.[userId] : undefined;
  if (typeof slot === 'number' && slot > 0) parts.push(`Pick ${slot}`);

  const type = draft.type;
  if (type && type !== 'snake') parts.push(displayEnum(type));

  return parts.join(' · ');
}

/**
 * One card per draft, newest and most urgent first.
 *
 * A live draft outranks an upcoming one, which outranks a mock, which outranks
 * something already finished - because that is the order somebody is likely to
 * want them, not because it is the order Sleeper returns.
 */
export function buildDraftChoices({
  drafts,
  leagues,
  userId,
}: {
  drafts: SleeperDraft[];
  /** Already loaded, and only used to put a name on a card. */
  leagues: SleeperLeague[];
  userId: string | null;
}): DraftChoice[] {
  const leagueName = new Map(leagues.map((league) => [league.league_id, league.name]));

  const perLeague = new Map<string, number>();
  for (const draft of drafts) {
    if (!draft.league_id) continue;
    perLeague.set(draft.league_id, (perLeague.get(draft.league_id) ?? 0) + 1);
  }

  return drafts
    .map((draft): DraftChoice => {
      const kind = kindOf(draft);
      const title =
        (draft.league_id ? leagueName.get(draft.league_id) : null) ??
        draft.metadata.name ??
        (kind === 'mock' ? 'Mock draft' : 'Draft');
      return {
        draftId: draft.draft_id,
        leagueId: draft.league_id,
        title,
        subtitle: describeDraft(draft, userId),
        kind,
        kindLabel: KIND_LABEL[kind],
        cta: KIND_CTA[kind],
        leagueHasSiblings: Boolean(draft.league_id && (perLeague.get(draft.league_id) ?? 0) > 1),
      };
    })
    .sort(
      (a, b) =>
        KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.title.localeCompare(b.title),
    );
}

/**
 * Is a league chooser still worth showing?
 *
 * Only when the flat list would hide something: a league whose drafts did not
 * come back from the drafts endpoint at all. Everything else is reachable in
 * one click, and offering both routes would put the old confusion back.
 */
export function needsLeagueFallback({
  choices,
  leagues,
}: {
  choices: DraftChoice[];
  leagues: SleeperLeague[];
}): boolean {
  if (leagues.length === 0) return false;
  const covered = new Set(choices.map((choice) => choice.leagueId).filter(Boolean));
  return leagues.some((league) => !covered.has(league.league_id));
}
