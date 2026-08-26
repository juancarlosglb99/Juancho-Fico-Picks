import type {
  SleeperDraft,
  SleeperDraftPick,
  SleeperLeague,
  SleeperLeagueUser,
  SleeperNflState,
  SleeperPlayersResponse,
  SleeperRoster,
  SleeperTradedPick,
  SleeperUser,
} from './types';

const BASE_URL = 'https://api.sleeper.app/v1';

export class SleeperApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly path: string,
  ) {
    super(message);
    this.name = 'SleeperApiError';
  }
}

async function request<T>(
  path: string,
  signal?: AbortSignal,
  cache: RequestCache = 'no-store',
): Promise<T> {
  const response = await fetch(`${BASE_URL}${path}`, {
    signal,
    cache,
    headers: { Accept: 'application/json' },
  });

  if (!response.ok) {
    throw new SleeperApiError(
      response.status === 404
        ? 'Sleeper could not find that resource.'
        : `Sleeper request failed (${response.status}).`,
      response.status,
      path,
    );
  }

  return (await response.json()) as T;
}

let activePlayersPromise: Promise<SleeperPlayersResponse> | null = null;

export const sleeperClient = {
  getNflState(signal?: AbortSignal) {
    return request<SleeperNflState>('/state/nfl', signal, 'force-cache');
  },

  getUser(usernameOrId: string, signal?: AbortSignal) {
    return request<SleeperUser>(
      `/user/${encodeURIComponent(usernameOrId.trim())}`,
      signal,
    );
  },

  getUserLeagues(userId: string, season: string, signal?: AbortSignal) {
    return request<SleeperLeague[]>(
      `/user/${encodeURIComponent(userId)}/leagues/nfl/${encodeURIComponent(season)}`,
      signal,
    );
  },

  getLeague(leagueId: string, signal?: AbortSignal) {
    return request<SleeperLeague>(
      `/league/${encodeURIComponent(leagueId)}`,
      signal,
    );
  },

  getRosters(leagueId: string, signal?: AbortSignal) {
    return request<SleeperRoster[]>(
      `/league/${encodeURIComponent(leagueId)}/rosters`,
      signal,
    );
  },

  getLeagueUsers(leagueId: string, signal?: AbortSignal) {
    return request<SleeperLeagueUser[]>(
      `/league/${encodeURIComponent(leagueId)}/users`,
      signal,
    );
  },

  getLeagueDrafts(leagueId: string, signal?: AbortSignal) {
    return request<SleeperDraft[]>(
      `/league/${encodeURIComponent(leagueId)}/drafts`,
      signal,
    );
  },

  /**
   * Every draft a user has taken part in this season, INCLUDING mock drafts.
   *
   * Mock drafts have a null `league_id`, so they never show up under
   * `/user/{id}/leagues`. This is the only public endpoint that surfaces them,
   * which makes it the basis of mock discovery.
   */
  getUserDrafts(userId: string, season: string, signal?: AbortSignal) {
    return request<SleeperDraft[]>(
      `/user/${encodeURIComponent(userId)}/drafts/nfl/${encodeURIComponent(season)}`,
      signal,
    );
  },

  getDraft(draftId: string, signal?: AbortSignal) {
    return request<SleeperDraft>(
      `/draft/${encodeURIComponent(draftId)}`,
      signal,
    );
  },

  getDraftPicks(draftId: string, signal?: AbortSignal) {
    return request<SleeperDraftPick[]>(
      `/draft/${encodeURIComponent(draftId)}/picks`,
      signal,
    );
  },

  getDraftTradedPicks(draftId: string, signal?: AbortSignal) {
    return request<SleeperTradedPick[]>(
      `/draft/${encodeURIComponent(draftId)}/traded_picks`,
      signal,
    );
  },

  getActivePlayers(signal?: AbortSignal) {
    if (!activePlayersPromise) {
      activePlayersPromise = request<SleeperPlayersResponse>(
        '/players/nfl?active=true',
        signal,
        'force-cache',
      ).catch((error) => {
        activePlayersPromise = null;
        throw error;
      });
    }

    return activePlayersPromise;
  },
};
