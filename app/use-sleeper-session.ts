'use client';

/**
 * The Sleeper half of the session: who you are, and which draft we are watching.
 *
 * Everything here was in the dashboard component and is unchanged in behaviour.
 * The one idea worth restating is that the ATTACHMENT is split in two: the
 * slow-moving half - the player map, and the league and rosters behind the
 * draft - is state, while the fast-moving half comes from the live sync loop.
 * The board is then DERIVED from both, which is what lets a pick arriving from
 * Sleeper re-derive the available pool in the same render.
 */
import { useCallback, useEffect, useState } from 'react';
import { buildCanonicalPlayerMap } from '@/packages/players/player-map';
import type { CanonicalPlayerMap } from '@/packages/players/types';
import { SleeperApiError, sleeperClient } from '@/packages/sleeper/client';
import { isMockDraft } from '@/packages/sleeper/attachment';
import { joinRostersWithOwners } from '@/packages/sleeper/normalization';
import type {
  LeagueRosterView,
  SleeperDraft,
  SleeperLeague,
  SleeperRoster,
  SleeperUser,
} from '@/packages/sleeper/types';
import type { LiveDraftSnapshot } from './use-live-draft-sync';

export interface LeagueWorkspace {
  league: SleeperLeague;
  rosters: SleeperRoster[];
  rosterViews: LeagueRosterView[];
  drafts: SleeperDraft[];
}

/** Everything about an attachment that does not change pick to pick. */
export interface AttachmentBundle {
  draftId: string;
  league: SleeperLeague | null;
  rosters: SleeperRoster[] | null;
  players: CanonicalPlayerMap;
  initial: LiveDraftSnapshot;
}

export type SessionBusy = 'connecting' | 'league' | 'draft' | null;

export function formatSleeperError(error: unknown): string {
  if (error instanceof SleeperApiError && error.status === 404) {
    return 'Sleeper could not find that username. Check the spelling and try again.';
  }
  if (error instanceof Error) return error.message;
  return 'Something went wrong while connecting to Sleeper.';
}

const DRAFT_ORDER = { drafting: 0, pre_draft: 1, paused: 2, complete: 3 } as const;
const DISCOVERY_ORDER = { drafting: 0, paused: 1, pre_draft: 2, complete: 3 } as const;

export function useSleeperSession() {
  const [user, setUser] = useState<SleeperUser | null>(null);
  const [season, setSeason] = useState<string | null>(null);
  const [leagues, setLeagues] = useState<SleeperLeague[]>([]);
  const [workspace, setWorkspace] = useState<LeagueWorkspace | null>(null);
  const [attachment, setAttachment] = useState<AttachmentBundle | null>(null);
  const [attachedDraftId, setAttachedDraftId] = useState<string | null>(null);
  const [busy, setBusy] = useState<SessionBusy>(null);
  const [error, setError] = useState<string | null>(null);
  const [attachError, setAttachError] = useState<string | null>(null);
  const [discovery, setDiscovery] = useState<{ userId: string; drafts: SleeperDraft[] } | null>(
    null,
  );

  const attachToDraft = useCallback(
    async (draftId: string, known?: LeagueWorkspace | null) => {
      setBusy('draft');
      setError(null);
      setAttachError(null);
      setAttachedDraftId(null);
      setAttachment(null);

      try {
        const [draft, picks, tradedPicks, rawPlayers] = await Promise.all([
          sleeperClient.getDraft(draftId),
          sleeperClient.getDraftPicks(draftId),
          sleeperClient.getDraftTradedPicks(draftId),
          sleeperClient.getActivePlayers(),
        ]);

        // Only a real league draft has a league to load. A mock has none.
        let league: SleeperLeague | null = null;
        let rosters: SleeperRoster[] | null = null;
        if (!isMockDraft(draft) && draft.league_id) {
          if (known?.league.league_id === draft.league_id) {
            league = known.league;
            rosters = known.rosters;
          } else {
            [league, rosters] = await Promise.all([
              sleeperClient.getLeague(draft.league_id),
              sleeperClient.getRosters(draft.league_id),
            ]);
          }
        }

        setAttachment({
          draftId: draft.draft_id,
          league,
          rosters,
          players: buildCanonicalPlayerMap(rawPlayers),
          initial: { draft, picks, tradedPicks, fetchedAt: Date.now() },
        });
        setAttachedDraftId(draft.draft_id);
      } catch (nextError) {
        setError(formatSleeperError(nextError));
      } finally {
        setBusy(null);
      }
    },
    [],
  );

  const loadLeague = useCallback(async (leagueId: string) => {
    setBusy('league');
    setError(null);
    setAttachedDraftId(null);
    setAttachment(null);

    try {
      const [league, rosters, owners, drafts] = await Promise.all([
        sleeperClient.getLeague(leagueId),
        sleeperClient.getRosters(leagueId),
        sleeperClient.getLeagueUsers(leagueId),
        sleeperClient.getLeagueDrafts(leagueId),
      ]);
      setWorkspace({
        league,
        rosters,
        rosterViews: joinRostersWithOwners(rosters, owners),
        drafts: [...drafts].sort((a, b) => DRAFT_ORDER[a.status] - DRAFT_ORDER[b.status]),
      });
    } catch (nextError) {
      setError(formatSleeperError(nextError));
    } finally {
      setBusy(null);
    }
  }, []);

  const connect = useCallback(async (rawUsername: string) => {
    const username = rawUsername.trim();
    if (!username) return;

    setBusy('connecting');
    setError(null);
    setUser(null);
    setLeagues([]);
    setWorkspace(null);
    setAttachedDraftId(null);
    setAttachment(null);

    try {
      const [nflState, sleeperUser] = await Promise.all([
        sleeperClient.getNflState(),
        sleeperClient.getUser(username),
      ]);
      const activeSeason = nflState.league_season || nflState.season;
      const userLeagues = await sleeperClient.getUserLeagues(sleeperUser.user_id, activeSeason);
      setSeason(activeSeason);
      setUser(sleeperUser);
      setLeagues([...userLeagues].sort((a, b) => a.name.localeCompare(b.name)));
    } catch (nextError) {
      setError(formatSleeperError(nextError));
    } finally {
      setBusy(null);
    }
  }, []);

  const detach = useCallback(() => {
    setAttachedDraftId(null);
    setAttachment(null);
    setAttachError(null);
  }, []);

  const reset = useCallback(() => {
    setUser(null);
    setSeason(null);
    setLeagues([]);
    setWorkspace(null);
    setAttachedDraftId(null);
    setAttachment(null);
    setError(null);
    setDiscovery(null);
  }, []);

  /*
   * Mock drafts have no league, so they never appear under /user/{id}/leagues.
   * This endpoint is the only public way to list them. Best-effort: pasting a
   * link always works.
   */
  useEffect(() => {
    if (!user || !season) return;
    const controller = new AbortController();
    let cancelled = false;
    const userId = user.user_id;

    void sleeperClient
      .getUserDrafts(userId, season, controller.signal)
      .then((drafts) => {
        if (cancelled) return;
        setDiscovery({
          userId,
          drafts: [...drafts].sort(
            (a, b) =>
              DISCOVERY_ORDER[a.status] - DISCOVERY_ORDER[b.status] ||
              (b.start_time ?? 0) - (a.start_time ?? 0),
          ),
        });
      })
      .catch(() => {
        if (!cancelled) setDiscovery({ userId, drafts: [] });
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [user, season]);

  return {
    user,
    season,
    leagues,
    workspace,
    attachment,
    attachedDraftId,
    busy,
    error,
    attachError,
    setAttachError,
    discoveredDrafts:
      discovery && user && discovery.userId === user.user_id ? discovery.drafts : [],
    discoveryBusy: Boolean(user) && (!discovery || discovery.userId !== user?.user_id),
    connect,
    loadLeague,
    attachToDraft,
    detach,
    reset,
  };
}
