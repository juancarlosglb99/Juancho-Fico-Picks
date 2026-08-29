/**
 * Resolving a draft id into everything needed to attach to it.
 *
 * The pasted id is the source of truth and nothing here may replace it. A draft
 * that belongs to a league gets that league loaded BEHIND it, which is a second
 * round trip - so a league attach is systematically slower than a mock one, and
 * two attaches started in either order finish in the other. That is why the
 * ordering guard lives here next to the fetching rather than in the component:
 * the two are the same rule, and separating them is what let a slow league
 * response overwrite a mock the user attached afterwards.
 *
 * No React, no DOM: the client is an argument.
 */
import { SleeperApiError } from './client';
import { isMockDraft } from './attachment';
import type {
  SleeperDraft,
  SleeperDraftPick,
  SleeperLeague,
  SleeperPlayersResponse,
  SleeperRoster,
  SleeperTradedPick,
} from './types';

/** The subset of `sleeperClient` an attach needs. */
export interface DraftAttachmentClient {
  getDraft(draftId: string): Promise<SleeperDraft>;
  getDraftPicks(draftId: string): Promise<SleeperDraftPick[]>;
  getDraftTradedPicks(draftId: string): Promise<SleeperTradedPick[]>;
  getActivePlayers(): Promise<SleeperPlayersResponse>;
  getLeague(leagueId: string): Promise<SleeperLeague>;
  getRosters(leagueId: string): Promise<SleeperRoster[]>;
}

/** A league already loaded, so attaching to one of its drafts skips a fetch. */
export interface KnownLeague {
  league: SleeperLeague;
  rosters: SleeperRoster[];
}

export interface ResolvedDraftAttachment {
  /** Always the draft Sleeper returned for the id we asked for. */
  draftId: string;
  draft: SleeperDraft;
  picks: SleeperDraftPick[];
  tradedPicks: SleeperTradedPick[];
  players: SleeperPlayersResponse;
  /** Null for a mock, which has no league to load. */
  league: SleeperLeague | null;
  rosters: SleeperRoster[] | null;
}

/**
 * Fetch one specific draft, and the league behind it when it has one.
 *
 * `/draft/<id>` and nothing else decides which draft this is. A league is only
 * ever loaded to describe that draft, never to choose a different one.
 */
export async function resolveDraftAttachment(
  client: DraftAttachmentClient,
  draftId: string,
  known?: KnownLeague | null,
): Promise<ResolvedDraftAttachment> {
  const [draft, picks, tradedPicks, players] = await Promise.all([
    client.getDraft(draftId),
    client.getDraftPicks(draftId),
    client.getDraftTradedPicks(draftId),
    client.getActivePlayers(),
  ]);

  let league: SleeperLeague | null = null;
  let rosters: SleeperRoster[] | null = null;
  if (!isMockDraft(draft) && draft.league_id) {
    if (known?.league.league_id === draft.league_id) {
      league = known.league;
      rosters = known.rosters;
    } else {
      [league, rosters] = await Promise.all([
        client.getLeague(draft.league_id),
        client.getRosters(draft.league_id),
      ]);
    }
  }

  return { draftId: draft.draft_id, draft, picks, tradedPicks, players, league, rosters };
}

/**
 * Only the newest attach may write its result.
 *
 * `begin` hands back the question "am I still the current attach?", which the
 * caller asks after every await. An attach that has been superseded - or
 * cancelled by detaching - answers false and writes nothing.
 */
export function createAttachSequence(): {
  begin: () => () => boolean;
  cancel: () => void;
} {
  let current = 0;
  return {
    begin() {
      const mine = (current += 1);
      return () => current === mine;
    },
    cancel() {
      current += 1;
    },
  };
}

/** What went wrong, said in terms of the draft the user asked for. */
export function formatAttachError(error: unknown): string {
  if (error instanceof SleeperApiError) {
    return error.status === 404
      ? 'Sleeper could not find that draft. Check the link or draft ID and try again.'
      : `Sleeper could not load that draft (${error.status}).`;
  }
  if (error instanceof Error) return error.message;
  return 'Something went wrong while attaching to that draft.';
}
