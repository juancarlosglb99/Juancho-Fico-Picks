'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  automaticAdpCacheKey,
  fetchAutomaticAdp,
  mapAdpSnapshot,
  planAutomaticAdp,
  projectionCacheKey,
} from '@/packages/adp/automatic';
import { isAdpSourceSnapshot } from '@/packages/adp/providers/fantasy-football-calculator';
import {
  loadWithLastGood,
  readLastGood,
  writeLastGood,
} from '@/packages/data/cache';
import {
  dataFreshness,
  formatDataAge,
  sourceAgeMs,
} from '@/packages/data/freshness';
import {
  composeProjectionAndAdp,
  createCsvProjectionSnapshot,
  isProjectionSnapshot,
} from '@/packages/data/projections';
import type {
  AdpSnapshot,
  CacheDisposition,
  DraftRoomRankingSnapshot,
  ProjectionSnapshot,
} from '@/packages/data/types';
import { normalizeLeagueContext } from '@/packages/engine/context/normalize';
import type {
  DraftContext,
  LeagueContext,
  LeagueContextOverrides,
  LeagueType,
  LineupType,
} from '@/packages/engine/context/types';
import type { NormalizedDraftType } from '@/packages/engine/draft/next-pick-probability';
import { deriveDraftBoardState } from '@/packages/engine/draft/state';
import {
  getRosterPositionCounts,
  getStarterTargets,
} from '@/packages/engine/draft/roster-fit';
import { generateDraftRecommendations } from '@/packages/engine/draft/recommendations';
import type {
  DraftBoardState,
  DraftRecommendation,
  DraftRecommendationResult,
} from '@/packages/engine/draft/types';
import {
  runMonteCarloCandidateComparison,
  simulateMockDraft,
} from '@/packages/engine/mock/simulation';
import {
  MONTE_CARLO_MODEL_VERSION,
  OPPONENT_MODEL_VERSION,
  type MockDraftResult,
  type MonteCarloComparison,
} from '@/packages/engine/mock/types';
import {
  fetchFirstSeedProjections,
  fetchFirstSeedRoomRankings,
  firstSeedProjectionCacheKey,
  firstSeedRoomRankingCacheKey,
  planAutomaticFirstSeed,
} from '@/packages/first-seed/automatic';
import {
  isDraftRoomRankingSourceSnapshot,
  isProjectionSourceSnapshot,
  mapFirstSeedDraftRoomRankingSnapshot,
  mapFirstSeedProjectionSnapshot,
} from '@/packages/first-seed/mapping';
import { FIRST_SEED_REFRESH_INTERVAL_MS } from '@/packages/first-seed/providers';
import { buildCanonicalPlayerMap } from '@/packages/players/player-map';
import type { CanonicalPlayerMap } from '@/packages/players/types';
import { CsvProjectionProvider } from '@/packages/projections/providers/csv';
import { mapProjectionRecords } from '@/packages/projections/mapping';
import type { ProjectionMappingResult } from '@/packages/projections/types';
import { sleeperClient, SleeperApiError } from '@/packages/sleeper/client';
import {
  formatRosterPositions,
  joinRostersWithOwners,
} from '@/packages/sleeper/normalization';
import type {
  LeagueRosterView,
  SleeperDraft,
  SleeperDraftPick,
  SleeperLeague,
  SleeperRoster,
  SleeperTradedPick,
  SleeperUser,
} from '@/packages/sleeper/types';
import { deriveDraftExperienceState } from '@/packages/ui/draft-experience';

interface LeagueWorkspace {
  league: SleeperLeague;
  rosters: SleeperRoster[];
  rosterViews: LeagueRosterView[];
  drafts: SleeperDraft[];
}

interface DraftWorkspace {
  draft: SleeperDraft;
  picks: SleeperDraftPick[];
  tradedPicks: SleeperTradedPick[];
  players: CanonicalPlayerMap;
  board: DraftBoardState;
  syncedAt: Date;
}

type BusyState = 'connecting' | 'league' | 'draft' | 'projections' | null;
type DraftExperienceMode = 'live' | 'mock';
type ProjectionMode = 'automatic' | 'custom' | null;

function formatError(error: unknown): string {
  if (error instanceof SleeperApiError && error.status === 404) {
    return 'Sleeper could not find that username. Check the spelling and try again.';
  }
  if (error instanceof Error) return error.message;
  return 'Something went wrong while connecting to Sleeper.';
}

function draftLabel(draft: SleeperDraft): string {
  const name = draft.metadata.name?.trim();
  if (name) return name;
  const type = draft.type.charAt(0).toUpperCase() + draft.type.slice(1);
  return `${draft.season} ${type} draft`;
}

function draftStatusLabel(status: SleeperDraft['status']): string {
  if (status === 'pre_draft') return 'Upcoming';
  if (status === 'drafting') return 'Live';
  if (status === 'complete') return 'Complete';
  return 'Paused';
}

function LoadingMark() {
  return (
    <span
      aria-hidden="true"
      className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-current border-r-transparent"
    />
  );
}

function Brand() {
  return (
    <div className="flex items-center gap-3">
      <span className="grid h-10 w-10 place-items-center rounded-xl bg-[#b9ff38] text-sm font-black tracking-[-0.08em] text-[#071019]">
        JF
      </span>
      <div>
        <p className="text-sm font-extrabold uppercase tracking-[0.12em]">
          Juancho-Fico
        </p>
        <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-[#7d8d98]">
          Picks
        </p>
      </div>
    </div>
  );
}

export function Dashboard() {
  const [username, setUsername] = useState('');
  const [user, setUser] = useState<SleeperUser | null>(null);
  const [season, setSeason] = useState<string | null>(null);
  const [leagues, setLeagues] = useState<SleeperLeague[]>([]);
  const [leagueWorkspace, setLeagueWorkspace] =
    useState<LeagueWorkspace | null>(null);
  const [draftWorkspace, setDraftWorkspace] =
    useState<DraftWorkspace | null>(null);
  const [projectionSnapshot, setProjectionSnapshot] =
    useState<ProjectionSnapshot | null>(null);
  const [projectionMode, setProjectionMode] = useState<ProjectionMode>(null);
  const [projectionDisposition, setProjectionDisposition] =
    useState<CacheDisposition | null>(null);
  const [projectionRefreshError, setProjectionRefreshError] = useState<string | null>(null);
  const [projectionBusy, setProjectionBusy] = useState(false);
  const [projectionRefreshNonce, setProjectionRefreshNonce] = useState(0);
  const [lastForcedProjectionNonce, setLastForcedProjectionNonce] = useState(0);
  const [roomRankingSnapshot, setRoomRankingSnapshot] =
    useState<DraftRoomRankingSnapshot | null>(null);
  const [roomDisposition, setRoomDisposition] = useState<CacheDisposition | null>(null);
  const [roomRefreshError, setRoomRefreshError] = useState<string | null>(null);
  const [roomBusy, setRoomBusy] = useState(false);
  const [roomRefreshNonce, setRoomRefreshNonce] = useState(0);
  const [lastForcedRoomNonce, setLastForcedRoomNonce] = useState(0);
  const [adpSnapshot, setAdpSnapshot] = useState<AdpSnapshot | null>(null);
  const [adpDisposition, setAdpDisposition] =
    useState<CacheDisposition | null>(null);
  const [adpRefreshError, setAdpRefreshError] = useState<string | null>(null);
  const [adpBusy, setAdpBusy] = useState(false);
  const [adpRefreshNonce, setAdpRefreshNonce] = useState(0);
  const [lastForcedAdpNonce, setLastForcedAdpNonce] = useState(0);
  const [busy, setBusy] = useState<BusyState>(null);
  const [error, setError] = useState<string | null>(null);
  const [contextOverrides, setContextOverrides] =
    useState<LeagueContextOverrides>({});
  const [draftExperienceMode, setDraftExperienceMode] =
    useState<DraftExperienceMode>('live');
  const [mockResult, setMockResult] = useState<MockDraftResult | null>(null);
  const [mockComparison, setMockComparison] =
    useState<MonteCarloComparison | null>(null);
  const [mockBusy, setMockBusy] = useState(false);

  const loadDraft = useCallback(
    async (draftId: string, workspace: LeagueWorkspace) => {
      setBusy('draft');
      setError(null);
      setProjectionSnapshot(null);
      setProjectionMode(null);
      setProjectionDisposition(null);
      setProjectionRefreshError(null);
      setRoomRankingSnapshot(null);
      setRoomDisposition(null);
      setRoomRefreshError(null);
      setAdpSnapshot(null);
      setAdpRefreshError(null);
      setContextOverrides({});

      try {
        const [draft, picks, tradedPicks, rawPlayers] = await Promise.all([
          sleeperClient.getDraft(draftId),
          sleeperClient.getDraftPicks(draftId),
          sleeperClient.getDraftTradedPicks(draftId),
          sleeperClient.getActivePlayers(),
        ]);
        const players = buildCanonicalPlayerMap(rawPlayers);
        const board = deriveDraftBoardState(
          draft,
          picks,
          workspace.rosters,
          players,
        );
        const cachedProjections = readLastGood({
          storage: window.localStorage,
          key: projectionCacheKey(draft.season),
          validate: isProjectionSnapshot,
        });
        if (cachedProjections) {
          const records = cachedProjections.value.records.filter((record) =>
            players.byId.has(record.playerId),
          );
          if (records.length > 0) {
            setProjectionMode('custom');
            setProjectionSnapshot({
              ...cachedProjections.value,
              records,
              resolution: {
                ...cachedProjections.value.resolution,
                matched: records.length,
              },
            });
          }
        }
        setDraftWorkspace({
          draft,
          picks,
          tradedPicks,
          players,
          board,
          syncedAt: new Date(),
        });
      } catch (nextError) {
        setError(formatError(nextError));
      } finally {
        setBusy(null);
      }
    },
    [],
  );

  const loadLeague = useCallback(
    async (leagueId: string) => {
      setBusy('league');
      setError(null);
      setDraftWorkspace(null);
      setProjectionSnapshot(null);
      setProjectionMode(null);
      setRoomRankingSnapshot(null);
      setAdpSnapshot(null);
      setContextOverrides({});

      try {
        const [league, rosters, owners, drafts] = await Promise.all([
          sleeperClient.getLeague(leagueId),
          sleeperClient.getRosters(leagueId),
          sleeperClient.getLeagueUsers(leagueId),
          sleeperClient.getLeagueDrafts(leagueId),
        ]);
        const workspace: LeagueWorkspace = {
          league,
          rosters,
          rosterViews: joinRostersWithOwners(rosters, owners),
          drafts: [...drafts].sort((a, b) => {
            const order = { drafting: 0, pre_draft: 1, paused: 2, complete: 3 };
            return order[a.status] - order[b.status];
          }),
        };
        setLeagueWorkspace(workspace);

        const preferredDraft =
          workspace.drafts.find((draft) => draft.draft_id === league.draft_id) ??
          workspace.drafts[0];
        if (preferredDraft) await loadDraft(preferredDraft.draft_id, workspace);
      } catch (nextError) {
        setError(formatError(nextError));
      } finally {
        setBusy(null);
      }
    },
    [loadDraft],
  );

  async function connectSleeper(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const cleanUsername = username.trim();
    if (!cleanUsername) return;

    setBusy('connecting');
    setError(null);
    setUser(null);
    setLeagues([]);
    setLeagueWorkspace(null);
    setDraftWorkspace(null);

    try {
      const [nflState, sleeperUser] = await Promise.all([
        sleeperClient.getNflState(),
        sleeperClient.getUser(cleanUsername),
      ]);
      const activeSeason = nflState.league_season || nflState.season;
      const currentLeagues = await sleeperClient.getUserLeagues(
        sleeperUser.user_id,
        activeSeason,
      );
      const sortedLeagues = [...currentLeagues].sort((a, b) =>
        a.name.localeCompare(b.name),
      );
      setSeason(activeSeason);
      setUser(sleeperUser);
      setLeagues(sortedLeagues);
      if (sortedLeagues[0]) await loadLeague(sortedLeagues[0].league_id);
    } catch (nextError) {
      setError(formatError(nextError));
    } finally {
      setBusy(null);
    }
  }

  const refreshPicks = useCallback(async () => {
    if (!draftWorkspace || !leagueWorkspace) return;
    try {
      const [draft, picks, tradedPicks] = await Promise.all([
        sleeperClient.getDraft(draftWorkspace.draft.draft_id),
        sleeperClient.getDraftPicks(draftWorkspace.draft.draft_id),
        sleeperClient.getDraftTradedPicks(draftWorkspace.draft.draft_id),
      ]);
      setDraftWorkspace((current) => {
        if (!current) return current;
        return {
          ...current,
          draft,
          picks,
          tradedPicks,
          board: deriveDraftBoardState(
            draft,
            picks,
            leagueWorkspace.rosters,
            current.players,
          ),
          syncedAt: new Date(),
        };
      });
    } catch (nextError) {
      setError(formatError(nextError));
    }
  }, [draftWorkspace, leagueWorkspace]);

  useEffect(() => {
    if (draftWorkspace?.draft.status !== 'drafting') return;
    const interval = window.setInterval(() => void refreshPicks(), 5000);
    return () => window.clearInterval(interval);
  }, [draftWorkspace?.draft.status, refreshPicks]);

  async function importProjections(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file || !draftWorkspace) return;
    setBusy('projections');
    setError(null);
    try {
      const provider = new CsvProjectionProvider(await file.text());
      const records = await provider.getRecords();
      const mapping = mapProjectionRecords(records, draftWorkspace.players);
      const snapshot = createCsvProjectionSnapshot({
        mapping,
        filename: file.name,
        season: draftWorkspace.draft.season,
      });
      setProjectionMode('custom');
      setProjectionDisposition(null);
      setProjectionRefreshError(null);
      setProjectionSnapshot(snapshot);
      writeLastGood({
        storage: window.localStorage,
        key: projectionCacheKey(draftWorkspace.draft.season),
        value: snapshot,
        savedAt: new Date(),
      });
    } catch (nextError) {
      setError(formatError(nextError));
    } finally {
      setBusy(null);
      event.target.value = '';
    }
  }

  const projectedAvailable = useMemo(() => {
    if (!draftWorkspace || !projectionSnapshot) return [];
    const availableIds = new Set(
      draftWorkspace.board.availablePlayers.map((player) => player.id),
    );
    return composeProjectionAndAdp(projectionSnapshot, adpSnapshot)
      .filter((projection) => availableIds.has(projection.playerId))
      .sort((a, b) => (a.rank ?? Number.POSITIVE_INFINITY) - (b.rank ?? Number.POSITIVE_INFINITY))
      .slice(0, 12)
      .map((projection) => ({
        projection,
        player: draftWorkspace.players.byId.get(projection.playerId),
      }));
  }, [draftWorkspace, projectionSnapshot, adpSnapshot]);

  const leagueContext = useMemo(() => {
    if (!draftWorkspace || !leagueWorkspace || !user) return null;
    return normalizeLeagueContext({
      league: leagueWorkspace.league,
      draft: draftWorkspace.draft,
      drafts: leagueWorkspace.drafts,
      picks: draftWorkspace.picks,
      tradedPicks: draftWorkspace.tradedPicks,
      rosters: leagueWorkspace.rosters,
      board: draftWorkspace.board,
      userId: user.user_id,
      overrides: contextOverrides,
    });
  }, [draftWorkspace, leagueWorkspace, user, contextOverrides]);

  const automaticAdpPlan = useMemo(() => {
    if (!leagueContext || !season) return null;
    return planAutomaticAdp(leagueContext, season);
  }, [leagueContext, season]);

  const automaticFirstSeedPlan = useMemo(
    () => (leagueContext ? planAutomaticFirstSeed(leagueContext) : null),
    [leagueContext],
  );
  const usesCustomProjections = projectionMode === 'custom';

  useEffect(() => {
    if (!automaticAdpPlan || !draftWorkspace || !leagueContext) {
      let cancelled = false;
      void Promise.resolve().then(() => {
        if (cancelled) return;
        setAdpSnapshot(null);
        setAdpDisposition(null);
        setAdpBusy(false);
      });
      return () => {
        cancelled = true;
      };
    }
    const controller = new AbortController();
    let cancelled = false;
    void Promise.resolve().then(() => {
      if (cancelled) return;
      setAdpBusy(true);
      setAdpRefreshError(null);
    });
    void loadWithLastGood({
      storage: window.localStorage,
      key: automaticAdpCacheKey(automaticAdpPlan.request),
      validate: isAdpSourceSnapshot,
      fetchFresh: () =>
        fetchAutomaticAdp(automaticAdpPlan.request, controller.signal),
      refreshIntervalMs: 12 * 60 * 60 * 1000,
      forceRefresh: adpRefreshNonce > lastForcedAdpNonce,
    })
      .then((result) => {
        if (cancelled) return;
        setAdpSnapshot(
          mapAdpSnapshot(result.value, draftWorkspace.players, leagueContext),
        );
        setAdpDisposition(result.disposition);
        setAdpRefreshError(result.refreshError);
      })
      .catch((nextError) => {
        if (cancelled || controller.signal.aborted) return;
        setAdpSnapshot(null);
        setAdpDisposition(null);
        setAdpRefreshError(formatError(nextError));
      })
      .finally(() => {
        if (!cancelled) {
          setAdpBusy(false);
          setLastForcedAdpNonce(adpRefreshNonce);
        }
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [
    automaticAdpPlan,
    draftWorkspace,
    leagueContext,
    adpRefreshNonce,
    lastForcedAdpNonce,
  ]);

  useEffect(() => {
    if (
      usesCustomProjections ||
      !automaticFirstSeedPlan ||
      !draftWorkspace
    ) {
      let cancelled = false;
      void Promise.resolve().then(() => {
        if (!cancelled) setProjectionBusy(false);
      });
      return () => {
        cancelled = true;
      };
    }
    const controller = new AbortController();
    let cancelled = false;
    void Promise.resolve().then(() => {
      if (cancelled) return;
      setProjectionBusy(true);
      setProjectionRefreshError(null);
    });
    void loadWithLastGood({
      storage: window.localStorage,
      key: firstSeedProjectionCacheKey(
        draftWorkspace.draft.season,
        automaticFirstSeedPlan.projectionFormat,
      ),
      validate: isProjectionSourceSnapshot,
      fetchFresh: () =>
        fetchFirstSeedProjections({
          season: draftWorkspace.draft.season,
          scoringFormat: automaticFirstSeedPlan.projectionFormat,
          signal: controller.signal,
        }),
      refreshIntervalMs: FIRST_SEED_REFRESH_INTERVAL_MS,
      forceRefresh: projectionRefreshNonce > lastForcedProjectionNonce,
    })
      .then((result) => {
        if (cancelled) return;
        setProjectionSnapshot(
          mapFirstSeedProjectionSnapshot(result.value, draftWorkspace.players),
        );
        setProjectionMode('automatic');
        setProjectionDisposition(result.disposition);
        setProjectionRefreshError(result.refreshError);
      })
      .catch((nextError) => {
        if (cancelled || controller.signal.aborted) return;
        setProjectionSnapshot(null);
        setProjectionMode(null);
        setProjectionDisposition(null);
        setProjectionRefreshError(formatError(nextError));
      })
      .finally(() => {
        if (!cancelled) {
          setProjectionBusy(false);
          setLastForcedProjectionNonce(projectionRefreshNonce);
        }
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [
    automaticFirstSeedPlan,
    draftWorkspace,
    usesCustomProjections,
    projectionRefreshNonce,
    lastForcedProjectionNonce,
  ]);

  useEffect(() => {
    if (!automaticFirstSeedPlan || !draftWorkspace || !leagueContext) {
      let cancelled = false;
      void Promise.resolve().then(() => {
        if (cancelled) return;
        setRoomRankingSnapshot(null);
        setRoomDisposition(null);
        setRoomBusy(false);
      });
      return () => {
        cancelled = true;
      };
    }
    const controller = new AbortController();
    let cancelled = false;
    void Promise.resolve().then(() => {
      if (cancelled) return;
      setRoomBusy(true);
      setRoomRefreshError(null);
    });
    void loadWithLastGood({
      storage: window.localStorage,
      key: firstSeedRoomRankingCacheKey(
        draftWorkspace.draft.season,
        automaticFirstSeedPlan.roomFormat,
        automaticFirstSeedPlan.qbFormat,
      ),
      validate: isDraftRoomRankingSourceSnapshot,
      fetchFresh: () =>
        fetchFirstSeedRoomRankings({
          season: draftWorkspace.draft.season,
          scoringFormat: automaticFirstSeedPlan.roomFormat,
          qbFormat: automaticFirstSeedPlan.qbFormat,
          signal: controller.signal,
        }),
      refreshIntervalMs: FIRST_SEED_REFRESH_INTERVAL_MS,
      forceRefresh: roomRefreshNonce > lastForcedRoomNonce,
    })
      .then((result) => {
        if (cancelled) return;
        setRoomRankingSnapshot(
          mapFirstSeedDraftRoomRankingSnapshot(
            result.value,
            draftWorkspace.players,
            leagueContext,
          ),
        );
        setRoomDisposition(result.disposition);
        setRoomRefreshError(result.refreshError);
      })
      .catch((nextError) => {
        if (cancelled || controller.signal.aborted) return;
        setRoomRankingSnapshot(null);
        setRoomDisposition(null);
        setRoomRefreshError(formatError(nextError));
      })
      .finally(() => {
        if (!cancelled) {
          setRoomBusy(false);
          setLastForcedRoomNonce(roomRefreshNonce);
        }
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [
    automaticFirstSeedPlan,
    draftWorkspace,
    leagueContext,
    roomRefreshNonce,
    lastForcedRoomNonce,
  ]);

  const projectionMapping = useMemo<ProjectionMappingResult | null>(() => {
    if (!projectionSnapshot) return null;
    return {
      mapped: projectionSnapshot.records,
      unmatched: projectionSnapshot.unmatched,
    };
  }, [projectionSnapshot]);

  const draftRecommendations = useMemo(() => {
    if (
      !draftWorkspace ||
      !leagueWorkspace ||
      !projectionSnapshot ||
      !leagueContext ||
      draftWorkspace.draft.status === 'complete'
    ) {
      return null;
    }
    return generateDraftRecommendations({
      context: leagueContext,
      picks: draftWorkspace.picks,
      rosters: leagueWorkspace.rosters,
      board: draftWorkspace.board,
      players: draftWorkspace.players,
      projections: composeProjectionAndAdp(projectionSnapshot, adpSnapshot),
      roomRankings: roomRankingSnapshot,
    });
  }, [
    draftWorkspace,
    leagueWorkspace,
    projectionSnapshot,
    leagueContext,
    adpSnapshot,
    roomRankingSnapshot,
  ]);

  useEffect(() => {
    let cancelled = false;
    void Promise.resolve().then(() => {
      if (cancelled) return;
      setMockResult(null);
      setMockComparison(null);
    });
    return () => {
      cancelled = true;
    };
  }, [draftWorkspace?.board.currentOverallPick, projectionSnapshot, adpSnapshot, roomRankingSnapshot]);

  async function runMockDraft() {
    if (
      !draftWorkspace ||
      !leagueWorkspace ||
      !leagueContext ||
      !projectionSnapshot ||
      !draftRecommendations
    ) return;
    const candidateIds = draftRecommendations.recommendations
      .slice(0, 3)
      .map((recommendation) => recommendation.player.id);
    if (candidateIds.length === 0) return;
    setMockBusy(true);
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    try {
      const simulationInput = {
        context: leagueContext,
        draft: draftWorkspace.draft,
        board: draftWorkspace.board,
        picks: draftWorkspace.picks,
        rosters: leagueWorkspace.rosters,
        players: draftWorkspace.players,
        projections: composeProjectionAndAdp(projectionSnapshot, adpSnapshot),
        roomRankings: roomRankingSnapshot,
      };
      setMockResult(simulateMockDraft(simulationInput, { seed: Date.now() & 0x7fffffff }));
      setMockComparison(
        runMonteCarloCandidateComparison(simulationInput, candidateIds, {
          simulations: 60,
        }),
      );
    } catch (nextError) {
      setError(formatError(nextError));
    } finally {
      setMockBusy(false);
    }
  }

  function restoreAutomaticProjections() {
    if (!draftWorkspace) return;
    window.localStorage.removeItem(projectionCacheKey(draftWorkspace.draft.season));
    setProjectionSnapshot(null);
    setProjectionMode(null);
    setProjectionRefreshNonce((current) => current + 1);
  }

  function reset() {
    setUser(null);
    setSeason(null);
    setLeagues([]);
    setLeagueWorkspace(null);
    setDraftWorkspace(null);
    setProjectionSnapshot(null);
    setProjectionMode(null);
    setProjectionDisposition(null);
    setProjectionRefreshError(null);
    setRoomRankingSnapshot(null);
    setRoomDisposition(null);
    setRoomRefreshError(null);
    setAdpSnapshot(null);
    setAdpDisposition(null);
    setAdpRefreshError(null);
    setContextOverrides({});
    setDraftExperienceMode('live');
    setMockResult(null);
    setMockComparison(null);
    setError(null);
    setUsername('');
  }

  return (
    <main className="min-h-screen bg-[#071019] text-[#f7f8f2]">
      <header className="sticky top-0 z-20 border-b border-[#1c2b35] bg-[#071019]/95 backdrop-blur">
        <div className="mx-auto flex w-full max-w-7xl items-center justify-between px-5 py-4 sm:px-8 lg:px-12">
          <Brand />
          {user ? (
            <button
              onClick={reset}
              className="rounded-full border border-[#2a3c49] bg-[#0c1822] px-4 py-2 text-xs font-bold text-[#a8b4bc] transition hover:border-[#52646f] hover:text-white"
            >
              Change account
            </button>
          ) : (
            <span className="rounded-full border border-[#20313d] bg-[#0c1822] px-3 py-1.5 text-xs font-semibold text-[#a8b4bc]">
              Sleeper · Format aware
            </span>
          )}
        </div>
      </header>

      {!user ? (
        <Landing
          username={username}
          setUsername={setUsername}
          connectSleeper={connectSleeper}
          busy={busy === 'connecting'}
          error={error}
        />
      ) : (
        <section className="mx-auto w-full max-w-7xl px-5 pb-20 pt-8 sm:px-8 lg:px-12">
          <div className="flex flex-col justify-between gap-5 border-b border-[#20313d] pb-8 md:flex-row md:items-end">
            <div>
              <p className="text-xs font-black uppercase tracking-[0.18em] text-[#b9ff38]">
                Sleeper connected
              </p>
              <h1 className="mt-2 text-3xl font-black tracking-[-0.04em] sm:text-4xl">
                {user.display_name || user.username}
              </h1>
              <p className="mt-2 text-sm text-[#7f919c]">
                {leagues.length} {leagues.length === 1 ? 'league' : 'leagues'} ·{' '}
                {season} season
              </p>
            </div>
            {leagues.length > 0 && (
              <label className="grid gap-2 text-xs font-bold uppercase tracking-[0.12em] text-[#71838e]">
                League
                <select
                  value={leagueWorkspace?.league.league_id ?? ''}
                  onChange={(event) => void loadLeague(event.target.value)}
                  disabled={busy !== null}
                  className="h-12 min-w-64 rounded-xl border border-[#2a3c49] bg-[#0c1822] px-4 text-sm font-bold normal-case tracking-normal text-white outline-none focus:border-[#b9ff38]"
                >
                  {leagues.map((league) => (
                    <option key={league.league_id} value={league.league_id}>
                      {league.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>

          {error && <ErrorBanner message={error} />}

          {leagues.length === 0 ? (
            <EmptyState
              title={`No ${season} leagues found`}
              body="This Sleeper account exists, but it does not have an NFL league for the active season."
            />
          ) : busy === 'league' && !leagueWorkspace ? (
            <LoadingPanel label="Loading league settings and rosters…" />
          ) : leagueWorkspace ? (
            <div className="mt-8 space-y-6">
              <LeagueOverview
                workspace={leagueWorkspace}
                context={leagueContext}
                overrides={contextOverrides}
                onOverridesChange={setContextOverrides}
              />
              {draftWorkspace && leagueContext && (
                <>
                  <DraftStatusStrip
                    draftWorkspace={draftWorkspace}
                    context={leagueContext}
                  />
                  <DraftModeToggle
                    mode={draftExperienceMode}
                    onChange={setDraftExperienceMode}
                  />
                  {draftWorkspace.draft.status === 'complete' ? (
                    <DraftCompleteState draftWorkspace={draftWorkspace} />
                  ) : draftExperienceMode === 'mock' && draftRecommendations ? (
                    <MockDraftPanel
                      result={draftRecommendations}
                      comparison={mockComparison}
                      mockResult={mockResult}
                      busy={mockBusy}
                      onRun={() => void runMockDraft()}
                    />
                  ) : draftRecommendations ? (
                    <RecommendationPanel result={draftRecommendations} />
                  ) : (
                    <RecommendationDataEmptyState
                      adp={adpSnapshot}
                      adpBusy={adpBusy}
                      automaticAdpAvailable={automaticAdpPlan !== null}
                      context={leagueContext}
                      onImport={importProjections}
                      projectionBusy={projectionBusy || busy === 'projections'}
                      projectionError={projectionRefreshError}
                    />
                  )}
                  <DataQualityPanel
                    projections={projectionSnapshot}
                    projectionMode={projectionMode}
                    projectionDisposition={projectionDisposition}
                    projectionRefreshError={projectionRefreshError}
                    projectionBusy={projectionBusy || busy === 'projections'}
                    adp={adpSnapshot}
                    adpDisposition={adpDisposition}
                    adpRefreshError={adpRefreshError}
                    adpBusy={adpBusy}
                    automaticAdpAvailable={automaticAdpPlan !== null}
                    roomRankings={roomRankingSnapshot}
                    roomDisposition={roomDisposition}
                    roomRefreshError={roomRefreshError}
                    roomBusy={roomBusy}
                    onRetryAdp={() => setAdpRefreshNonce((current) => current + 1)}
                    onRetryFirstSeed={() => {
                      setProjectionRefreshNonce((current) => current + 1);
                      setRoomRefreshNonce((current) => current + 1);
                    }}
                    onImport={importProjections}
                    onRestoreAutomatic={restoreAutomaticProjections}
                  />
                </>
              )}

              <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(320px,0.38fr)]">
                <div className="space-y-6">
                <DraftPanel
                  workspace={leagueWorkspace}
                  draftWorkspace={draftWorkspace}
                  busy={busy}
                  onSelectDraft={(draftId) =>
                    void loadDraft(draftId, leagueWorkspace)
                  }
                  onRefresh={() => void refreshPicks()}
                />
                {draftWorkspace && (
                  <ProjectionPanel
                    mapping={projectionMapping}
                    filename={projectionSnapshot?.filename ?? null}
                    busy={projectionBusy || busy === 'projections'}
                    onImport={importProjections}
                    onRestoreAutomatic={restoreAutomaticProjections}
                    projectionMode={projectionMode}
                    available={projectedAvailable}
                  />
                )}
                </div>
                {draftWorkspace && leagueContext && (
                  <DraftContextPanel
                    workspace={leagueWorkspace}
                    draftWorkspace={draftWorkspace}
                    context={leagueContext}
                    userId={user.user_id}
                  />
                )}
              </div>
            </div>
          ) : null}
        </section>
      )}
    </main>
  );
}

function Landing({
  username,
  setUsername,
  connectSleeper,
  busy,
  error,
}: {
  username: string;
  setUsername: (value: string) => void;
  connectSleeper: (event: React.FormEvent<HTMLFormElement>) => void;
  busy: boolean;
  error: string | null;
}) {
  return (
    <section className="mx-auto grid w-full max-w-7xl gap-12 px-5 pb-16 pt-10 sm:px-8 lg:grid-cols-[minmax(0,1.05fr)_minmax(420px,0.95fr)] lg:px-12 lg:pb-24 lg:pt-20">
      <div className="flex max-w-2xl flex-col justify-center">
        <p className="mb-5 flex items-center gap-2 text-xs font-extrabold uppercase tracking-[0.2em] text-[#b9ff38]">
          <span className="h-1.5 w-1.5 rounded-full bg-[#b9ff38] shadow-[0_0_18px_#b9ff38]" />
          Sleeper draft intelligence
        </p>
        <h1 className="max-w-3xl text-5xl font-black leading-[0.98] tracking-[-0.055em] sm:text-6xl lg:text-7xl">
          Know who to draft
          <span className="block text-[#83939d]">and who can wait.</span>
        </h1>
        <p className="mt-7 max-w-xl text-base leading-7 text-[#aab7bf] sm:text-lg">
          Connect your Sleeper league to load its scoring, rosters, drafts, and
          picks. Weekly First Seed projections, Sleeper draft-room rankings, and
          current market ADP load automatically—no CSV required.
        </p>

        <form
          onSubmit={connectSleeper}
          className="mt-9 flex max-w-xl flex-col gap-3 sm:flex-row"
        >
          <label className="sr-only" htmlFor="sleeper-username">
            Sleeper username
          </label>
          <input
            id="sleeper-username"
            name="username"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            placeholder="Enter Sleeper username"
            autoComplete="off"
            disabled={busy}
            className="h-14 flex-1 rounded-xl border border-[#2a3c49] bg-[#0c1822] px-5 text-base font-semibold text-white outline-none placeholder:text-[#60727d] focus:border-[#b9ff38] focus:ring-4 focus:ring-[#b9ff38]/10 disabled:opacity-60"
          />
          <button
            type="submit"
            disabled={busy || !username.trim()}
            className="flex h-14 items-center justify-center gap-2 rounded-xl bg-[#b9ff38] px-6 text-sm font-black uppercase tracking-[0.08em] text-[#071019] transition hover:bg-[#cbff6e] focus:outline-none focus:ring-4 focus:ring-[#b9ff38]/20 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy && <LoadingMark />}
            {busy ? 'Connecting' : 'Connect league'}
          </button>
        </form>
        <p className="mt-3 text-xs text-[#657680]">
          Read-only connection. No Sleeper password or token required.
        </p>
        {error && <ErrorBanner message={error} />}
      </div>

      <RecommendationPreview />
    </section>
  );
}

function RecommendationPreview() {
  return (
    <div className="relative mx-auto w-full max-w-xl lg:mx-0">
      <div className="absolute -inset-6 rounded-[2.25rem] bg-[#b9ff38]/5 blur-3xl" />
      <div className="relative overflow-hidden rounded-[1.75rem] border border-[#263845] bg-[#0c1822] shadow-[0_35px_90px_rgba(0,0,0,0.35)]">
        <div className="flex items-center justify-between border-b border-[#20313d] px-5 py-4 sm:px-6">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.14em] text-[#71838e]">
              Round 4 · Pick 7
            </p>
            <p className="mt-1 text-sm font-bold">Fico&apos;s League</p>
          </div>
          <span className="flex items-center gap-2 rounded-full bg-[#13232c] px-3 py-1.5 text-xs font-bold text-[#b9ff38]">
            <span className="h-1.5 w-1.5 rounded-full bg-[#b9ff38]" /> Preview
          </span>
        </div>
        <div className="p-5 sm:p-6">
          <p className="text-[11px] font-black uppercase tracking-[0.18em] text-[#ff7a59]">
            Draft now
          </p>
          <div className="mt-4 flex items-start justify-between gap-5">
            <div>
              <p className="text-3xl font-black tracking-[-0.04em]">
                Drake London
              </p>
              <p className="mt-1 text-sm font-bold text-[#8fa0aa]">WR · ATL</p>
            </div>
            <div className="text-right">
              <p className="text-4xl font-black tracking-[-0.06em] text-[#b9ff38]">
                92
              </p>
              <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-[#71838e]">
                Draft score
              </p>
            </div>
          </div>
          <div className="mt-6 rounded-xl border border-[#2e3f4a] bg-[#071019] p-4">
            <div className="flex items-center justify-between gap-4">
              <p className="text-sm font-bold">Available next pick</p>
              <p className="text-lg font-black text-[#ff7a59]">14%</p>
            </div>
            <div className="mt-3 h-2 overflow-hidden rounded-full bg-[#263844]">
              <div className="h-full w-[14%] rounded-full bg-[#ff7a59]" />
            </div>
          </div>
          <ul className="mt-5 space-y-3 text-sm text-[#c0cad0]">
            <li><span className="mr-3 text-[#b9ff38]">+6.2</span>projected points over replacement</li>
            <li><span className="mr-3 text-[#b9ff38]">Tier 2</span>final elite WR tier is closing</li>
            <li><span className="mr-3 text-[#b9ff38]">Fit</span>balances your RB-heavy opening</li>
          </ul>
        </div>
      </div>
    </div>
  );
}

function ErrorBanner({ message }: { message: string }) {
  return (
    <div
      role="alert"
      className="mt-5 rounded-xl border border-[#713c35] bg-[#2a1717] px-4 py-3 text-sm font-semibold text-[#ffb4a7]"
    >
      {message}
    </div>
  );
}

function LoadingPanel({ label }: { label: string }) {
  return (
    <div className="mt-8 flex items-center gap-3 rounded-2xl border border-[#263845] bg-[#0c1822] p-6 text-sm font-bold text-[#a8b4bc]">
      <LoadingMark /> {label}
    </div>
  );
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="mt-8 rounded-2xl border border-dashed border-[#344a57] bg-[#0c1822] p-8">
      <h2 className="text-xl font-black">{title}</h2>
      <p className="mt-2 max-w-xl text-sm leading-6 text-[#83949e]">{body}</p>
    </div>
  );
}

function displayEnum(value: string): string {
  return value.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function scoringSummary(context: LeagueContext | null): string {
  if (!context) return 'Loading';
  const scoring = context.scoring.value;
  const premium = scoring.tePremium > 0 ? ` · TE +${scoring.tePremium}` : '';
  return `${displayEnum(scoring.profile)} · ${scoring.passing.touchdowns}pt pass TD${premium}`;
}

function LeagueOverview({
  workspace,
  context,
  overrides,
  onOverridesChange,
}: {
  workspace: LeagueWorkspace;
  context: LeagueContext | null;
  overrides: LeagueContextOverrides;
  onOverridesChange: (value: LeagueContextOverrides) => void;
}) {
  const { league } = workspace;
  const quarterbackFormat = context
    ? context.roster.value.SUPER_FLEX > 0 || context.roster.value.QB >= 2
      ? 'Superflex / 2QB'
      : '1QB'
    : 'Loading';
  return (
    <section className="rounded-2xl border border-[#263845] bg-[#0c1822] p-5">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
        <div>
          <h2 className="text-2xl font-black tracking-[-0.03em]">
            {league.name}
          </h2>
          <p className="mt-2 text-sm font-semibold text-[#8fa0aa]">
            {context
              ? `${context.teams.value}-team · ${displayEnum(context.leagueType.value)} · ${displayEnum(context.scoring.value.profile)} · ${quarterbackFormat}`
              : 'Normalizing league settings…'}
          </p>
        </div>
        <span className="w-fit rounded-full bg-[#172832] px-3 py-1.5 text-xs font-bold capitalize text-[#b9ff38]">
          {league.status.replace('_', ' ')}
        </span>
      </div>
      {context && (
        <>
          {context.warnings.length > 0 && (
            <div className="mt-4 rounded-xl border border-[#5a4630] bg-[#251d12] p-4">
              <p className="text-[10px] font-black uppercase tracking-[0.14em] text-[#f0c777]">
                Needs attention
              </p>
              <ul className="mt-2 space-y-1 text-xs leading-5 text-[#c7ad7c]">
                {context.warnings.map((warning) => (
                  <li key={warning}>· {warning}</li>
                ))}
              </ul>
            </div>
          )}

          <details className="mt-4 rounded-xl border border-[#263845] bg-[#071019] p-4">
            <summary className="cursor-pointer text-xs font-black uppercase tracking-[0.13em] text-[#8fa0aa]">
              Review league settings
            </summary>
            <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Metric label="Teams" value={String(league.total_rosters)} />
              <Metric
                label="Format"
                value={`${displayEnum(context.leagueType.value)} · ${displayEnum(context.draftType.value)}`}
              />
              <Metric label="Scoring" value={scoringSummary(context)} />
              <Metric
                label="Starting lineup"
                value={formatRosterPositions(league.roster_positions) || 'Custom'}
              />
            </div>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <label className="grid gap-2 text-[10px] font-black uppercase tracking-[0.12em] text-[#71838e]">
                League type
                <select
                  value={overrides.leagueType ?? 'auto'}
                  onChange={(event) => {
                    const selected = event.target.value;
                    onOverridesChange({
                      ...overrides,
                      leagueType:
                        selected === 'auto' ? undefined : (selected as LeagueType),
                    });
                  }}
                  className="h-10 rounded-lg border border-[#2a3c49] bg-[#0c1822] px-3 text-xs font-bold normal-case tracking-normal text-white outline-none focus:border-[#b9ff38]"
                >
                  <option value="auto">Auto · {displayEnum(context.leagueType.value)}</option>
                  <option value="redraft">Redraft</option>
                  <option value="keeper">Keeper</option>
                  <option value="dynasty">Dynasty</option>
                </select>
              </label>
              <label className="grid gap-2 text-[10px] font-black uppercase tracking-[0.12em] text-[#71838e]">
                Draft context
                <select
                  value={overrides.draftContext ?? 'auto'}
                  onChange={(event) => {
                    const selected = event.target.value;
                    onOverridesChange({
                      ...overrides,
                      draftContext:
                        selected === 'auto'
                          ? undefined
                          : (selected as DraftContext),
                    });
                  }}
                  className="h-10 rounded-lg border border-[#2a3c49] bg-[#0c1822] px-3 text-xs font-bold normal-case tracking-normal text-white outline-none focus:border-[#b9ff38]"
                >
                  <option value="auto">Auto · {displayEnum(context.draftContext.value)}</option>
                  <option value="startup">Dynasty startup</option>
                  <option value="rookie_supplemental">Rookie / supplemental</option>
                  <option value="veteran_all_player">Veteran / all-player</option>
                </select>
              </label>
              <label className="grid gap-2 text-[10px] font-black uppercase tracking-[0.12em] text-[#71838e]">
                Draft order
                <select
                  value={overrides.draftType ?? 'auto'}
                  onChange={(event) => {
                    const selected = event.target.value;
                    onOverridesChange({
                      ...overrides,
                      draftType:
                        selected === 'auto'
                          ? undefined
                          : (selected as NormalizedDraftType),
                    });
                  }}
                  className="h-10 rounded-lg border border-[#2a3c49] bg-[#0c1822] px-3 text-xs font-bold normal-case tracking-normal text-white outline-none focus:border-[#b9ff38]"
                >
                  <option value="auto">Auto · {displayEnum(context.draftType.value)}</option>
                  <option value="snake">Snake</option>
                  <option value="linear">Linear</option>
                  <option value="3rr">Third-round reversal</option>
                  <option value="auction">Auction</option>
                </select>
              </label>
              <label className="grid gap-2 text-[10px] font-black uppercase tracking-[0.12em] text-[#71838e]">
                Lineup type
                <select
                  value={overrides.lineupType ?? 'auto'}
                  onChange={(event) => {
                    const selected = event.target.value;
                    onOverridesChange({
                      ...overrides,
                      lineupType:
                        selected === 'auto' ? undefined : (selected as LineupType),
                    });
                  }}
                  className="h-10 rounded-lg border border-[#2a3c49] bg-[#0c1822] px-3 text-xs font-bold normal-case tracking-normal text-white outline-none focus:border-[#b9ff38]"
                >
                  <option value="auto">Auto · {displayEnum(context.lineupType.value)}</option>
                  <option value="classic">Classic</option>
                  <option value="best_ball">Best Ball</option>
                </select>
              </label>
            </div>
            <div className="mt-4 grid gap-2 text-xs text-[#71838e] sm:grid-cols-2">
              <ContextSource label="League" item={context.leagueType} />
              <ContextSource label="Draft context" item={context.draftContext} />
              <ContextSource label="Draft order" item={context.draftType} />
              <ContextSource label="Lineup" item={context.lineupType} />
              <ContextSource label="Roster" item={context.roster} />
              <ContextSource label="Scoring" item={context.scoring} />
            </div>
          </details>
        </>
      )}
    </section>
  );
}

function DraftStatusStrip({
  draftWorkspace,
  context,
}: {
  draftWorkspace: DraftWorkspace;
  context: LeagueContext;
}) {
  const experience = deriveDraftExperienceState({
    draft: draftWorkspace.draft,
    recommendation: null,
    isUserOnClock: context.draftState.value.isUserOnClock,
  });
  const statusLabel =
    experience === 'on_clock'
      ? 'You are on the clock'
      : draftWorkspace.draft.status === 'pre_draft'
        ? 'Draft upcoming'
        : draftWorkspace.draft.status === 'complete'
          ? 'Draft complete'
          : 'Live draft';
  return (
    <section className="flex flex-col justify-between gap-4 rounded-2xl border border-[#263845] bg-[#071019] p-5 sm:flex-row sm:items-center">
      <div>
        <p className="text-[10px] font-black uppercase tracking-[0.17em] text-[#71838e]">
          {draftWorkspace.draft.status === 'complete'
            ? `${draftWorkspace.board.picksMade} selections made`
            : `Round ${draftWorkspace.board.currentRound} · Pick ${draftWorkspace.board.pickInRound}`}
        </p>
        <p className="mt-1 text-xl font-black tracking-[-0.03em]">{statusLabel}</p>
      </div>
      <div className="flex flex-wrap items-center gap-3 text-xs font-bold">
        {context.draftState.value.nextUserPick !== null && (
          <span className="rounded-full border border-[#2a3c49] px-3 py-2 text-[#b8c3c9]">
            Next selection · Pick {context.draftState.value.nextUserPick}
          </span>
        )}
        <span className="flex items-center gap-2 rounded-full bg-[#13232c] px-3 py-2 text-[#b9ff38]">
          <span className="h-1.5 w-1.5 rounded-full bg-[#b9ff38]" />
          Synced {draftWorkspace.syncedAt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
        </span>
      </div>
    </section>
  );
}

function compactTimestamp(timestamp: string | null | undefined): string {
  if (!timestamp) return 'update time unavailable';
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return 'update time unavailable';
  return date.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
}

function DraftModeToggle({
  mode,
  onChange,
}: {
  mode: DraftExperienceMode;
  onChange: (mode: DraftExperienceMode) => void;
}) {
  return (
    <div className="flex w-fit rounded-xl border border-[#263845] bg-[#0c1822] p-1">
      {(['live', 'mock'] as const).map((candidate) => (
        <button
          key={candidate}
          type="button"
          onClick={() => onChange(candidate)}
          className={`rounded-lg px-4 py-2 text-xs font-black uppercase tracking-[0.12em] ${
            mode === candidate
              ? 'bg-[#b9ff38] text-[#071019]'
              : 'text-[#8fa0aa] hover:text-white'
          }`}
        >
          {candidate === 'live' ? 'Live Draft' : 'Mock Draft'}
        </button>
      ))}
    </div>
  );
}

function MockDraftPanel({
  result,
  comparison,
  mockResult,
  busy,
  onRun,
}: {
  result: DraftRecommendationResult;
  comparison: MonteCarloComparison | null;
  mockResult: MockDraftResult | null;
  busy: boolean;
  onRun: () => void;
}) {
  const names = new Map(
    result.recommendations.map((recommendation) => [
      recommendation.player.id,
      recommendation.player.name,
    ]),
  );
  return (
    <section className="rounded-2xl border border-[#354853] bg-[#071019] p-5 sm:p-6">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
        <div>
          <p className="text-[10px] font-black uppercase tracking-[0.17em] text-[#b9ff38]">
            Market-behavior simulation
          </p>
          <h2 className="mt-2 text-3xl font-black tracking-[-0.04em]">Test the next decision.</h2>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-[#82939d]">
            Opponents follow a mix of Sleeper room order, current ADP, roster needs,
            scarcity, positional runs, and controlled randomness. They never see
            Juancho&apos;s projection rank.
          </p>
        </div>
        <button
          type="button"
          onClick={onRun}
          disabled={busy}
          className="flex h-11 items-center justify-center gap-2 rounded-xl bg-[#b9ff38] px-4 text-xs font-black uppercase tracking-[0.08em] text-[#071019] disabled:opacity-50"
        >
          {busy && <LoadingMark />}
          {busy ? 'Simulating' : comparison ? 'Run again' : 'Run 60 simulations'}
        </button>
      </div>

      {comparison ? (
        <div className="mt-6 grid gap-3 lg:grid-cols-3">
          {comparison.candidates.map((candidate, index) => (
            <div key={candidate.playerId} className="rounded-xl border border-[#263845] bg-[#0c1822] p-4">
              <p className="text-[10px] font-black uppercase tracking-[0.13em] text-[#71838e]">
                {index === 0 ? 'Best simulated roster' : `Candidate ${index + 1}`}
              </p>
              <p className="mt-2 truncate text-lg font-black">
                {names.get(candidate.playerId) ?? candidate.playerId}
              </p>
              <dl className="mt-4 space-y-2 text-xs">
                <div className="flex justify-between gap-3">
                  <dt className="text-[#71838e]">Avg. roster score</dt>
                  <dd className="font-black text-[#b9ff38]">{candidate.averageRosterScore.toFixed(1)}</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-[#71838e]">25th–75th percentile</dt>
                  <dd className="font-bold">{candidate.rosterScoreP25.toFixed(1)}–{candidate.rosterScoreP75.toFixed(1)}</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-[#71838e]">Still there next pick</dt>
                  <dd className="font-bold">
                    {candidate.availableNextPickProbability === null
                      ? 'Unavailable'
                      : `${candidate.availableNextPickProbability.toFixed(1)}%`}
                  </dd>
                </div>
              </dl>
            </div>
          ))}
        </div>
      ) : (
        <div className="mt-6 rounded-xl border border-dashed border-[#344a57] p-6 text-sm text-[#82939d]">
          Run a mock to compare the top three live recommendations across complete draft continuations.
        </div>
      )}

      <p className="mt-4 text-[10px] font-bold uppercase tracking-[0.11em] text-[#60727d]">
        Models {OPPONENT_MODEL_VERSION} · {MONTE_CARLO_MODEL_VERSION}
        {mockResult ? ` · latest continuation score ${mockResult.rosterScore.toFixed(1)}` : ''}
      </p>
    </section>
  );
}

function DataQualityPanel({
  projections,
  projectionMode,
  projectionDisposition,
  projectionRefreshError,
  projectionBusy,
  adp,
  adpDisposition,
  adpRefreshError,
  adpBusy,
  automaticAdpAvailable,
  roomRankings,
  roomDisposition,
  roomRefreshError,
  roomBusy,
  onRetryAdp,
  onRetryFirstSeed,
  onImport,
  onRestoreAutomatic,
}: {
  projections: ProjectionSnapshot | null;
  projectionMode: ProjectionMode;
  projectionDisposition: CacheDisposition | null;
  projectionRefreshError: string | null;
  projectionBusy: boolean;
  adp: AdpSnapshot | null;
  adpDisposition: CacheDisposition | null;
  adpRefreshError: string | null;
  adpBusy: boolean;
  automaticAdpAvailable: boolean;
  roomRankings: DraftRoomRankingSnapshot | null;
  roomDisposition: CacheDisposition | null;
  roomRefreshError: string | null;
  roomBusy: boolean;
  onRetryAdp: () => void;
  onRetryFirstSeed: () => void;
  onImport: (event: React.ChangeEvent<HTMLInputElement>) => void;
  onRestoreAutomatic: () => void;
}) {
  const projectionFreshness = projections
    ? dataFreshness(projections.provenance)
    : null;
  const adpFreshness = adp ? dataFreshness(adp.provenance) : null;
  const roomFreshness = roomRankings ? dataFreshness(roomRankings.provenance) : null;
  const ready = Boolean(projections && adp && roomRankings);
  return (
    <section className="rounded-2xl border border-[#263845] bg-[#0c1822] p-4 sm:p-5">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
        <div>
          <p className="text-[10px] font-black uppercase tracking-[0.16em] text-[#b9ff38]">
            {ready ? 'Data Ready ✓' : 'Data readiness'}
          </p>
          <div className="mt-2 flex flex-col gap-1 text-xs text-[#9aa9b1] sm:flex-row sm:flex-wrap sm:gap-x-5">
            <p>
              <span className="font-bold text-[#d9e0e3]">Projections:</span>{' '}
              {projections
                ? `${projections.provenance.sourceLabel} · ${projections.resolution.matched}/${projections.resolution.total} matched`
                : 'Not loaded'}
            </p>
            <p>
              <span className="font-bold text-[#d9e0e3]">Sleeper room:</span>{' '}
              {roomRankings
                ? `${roomRankings.resolution.matched}/${roomRankings.resolution.total} matched · ${displayEnum(roomRankings.compatibility.level)}`
                : roomBusy
                  ? 'Refreshing First Seed source…'
                  : 'Not loaded'}
            </p>
            <p>
              <span className="font-bold text-[#d9e0e3]">ADP:</span>{' '}
              {adp
                ? `${adp.provenance.sourceLabel} · ${adp.context.teams}-team · ${displayEnum(adp.compatibility.level)} match`
                : adpBusy
                  ? 'Refreshing automatic source…'
                  : projections
                    ? 'CSV fallback'
                    : 'Waiting for league data'}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {automaticAdpAvailable && (
            <button
              type="button"
              onClick={onRetryAdp}
              disabled={adpBusy}
              className="rounded-lg border border-[#2a3c49] px-3 py-2 text-xs font-bold text-[#c2ccd1] hover:border-[#52646f] disabled:opacity-50"
            >
              {adpBusy ? 'Refreshing ADP' : 'Refresh ADP'}
            </button>
          )}
          <button
            type="button"
            onClick={onRetryFirstSeed}
            disabled={projectionBusy || roomBusy || projectionMode === 'custom'}
            className="rounded-lg border border-[#2a3c49] px-3 py-2 text-xs font-bold text-[#c2ccd1] hover:border-[#52646f] disabled:opacity-50"
          >
            {projectionBusy || roomBusy ? 'Refreshing First Seed' : 'Refresh First Seed'}
          </button>
          {projectionMode === 'custom' && (
            <button
              type="button"
              onClick={onRestoreAutomatic}
              className="rounded-lg border border-[#2a3c49] px-3 py-2 text-xs font-bold text-[#c2ccd1] hover:border-[#52646f]"
            >
              Restore automatic
            </button>
          )}
          <label className="cursor-pointer rounded-lg bg-[#b9ff38] px-3 py-2 text-xs font-black text-[#071019] hover:bg-[#cbff6e]">
            {projectionBusy ? 'Loading…' : projectionMode === 'custom' ? 'Replace override' : 'Custom override'}
            <input
              type="file"
              accept=".csv,text/csv"
              className="sr-only"
              onChange={onImport}
              disabled={projectionBusy}
            />
          </label>
        </div>
      </div>

      {(projectionFreshness === 'stale' || adpFreshness === 'stale' || roomFreshness === 'stale' || projectionRefreshError || roomRefreshError || adpRefreshError) && (
        <div className="mt-4 rounded-lg border border-[#5a4630] bg-[#251d12] px-3 py-2 text-xs text-[#d6b679]">
          {projectionFreshness === 'stale' && projections && (
            <p>Projection data was updated {formatDataAge(sourceAgeMs(projections.provenance))}. Refresh the source before drafting.</p>
          )}
          {adpFreshness === 'stale' && adp && (
            <p>ADP was updated {formatDataAge(sourceAgeMs(adp.provenance))}, so availability confidence is reduced.</p>
          )}
          {adpRefreshError && (
            <p>
              ADP refresh failed. {adpDisposition === 'fallback_cache' && adp
                ? `Using the last valid snapshot from ${compactTimestamp(adp.provenance.sourceUpdatedAt ?? adp.provenance.fetchedAt)}.`
                : 'No last-known-good ADP snapshot was available.'}
            </p>
          )}
          {projectionRefreshError && (
            <p>Projection refresh failed. {projectionDisposition === 'fallback_cache' && projections ? 'Using the last valid First Seed projection snapshot.' : projectionRefreshError}</p>
          )}
          {roomRefreshError && (
            <p>Room-ranking refresh failed. {roomDisposition === 'fallback_cache' && roomRankings ? 'Using the last valid First Seed room snapshot.' : roomRefreshError}</p>
          )}
          {roomFreshness === 'stale' && roomRankings && (
            <p>Sleeper room order was updated {formatDataAge(sourceAgeMs(roomRankings.provenance))}, so opponent confidence is reduced.</p>
          )}
        </div>
      )}

      <details className="mt-3 text-xs text-[#71838e]">
        <summary className="cursor-pointer font-bold text-[#8fa0aa]">Source details</summary>
        <div className="mt-3 grid gap-3 lg:grid-cols-3">
          <div className="rounded-lg bg-[#071019] p-3">
            <p className="font-black text-[#c6d0d5]">Projections</p>
            {projections ? (
              <div className="mt-2 space-y-1">
                <p>Loaded: {compactTimestamp(projections.provenance.fetchedAt)}</p>
                <p>Mode: {projectionMode === 'custom' ? 'Custom CSV override' : 'Automatic weekly source'}</p>
                <p>Scoring: {displayEnum(projections.scoringFormat)}</p>
                <p>Complete stat lines: {projections.completeStatLines}/{projections.records.length}</p>
                <p>Unresolved or ambiguous: {projections.resolution.ambiguous + projections.resolution.unresolved}</p>
              </div>
            ) : (
              <p className="mt-2">No valid projection snapshot is loaded yet.</p>
            )}
          </div>
          <div className="rounded-lg bg-[#071019] p-3">
            <p className="font-black text-[#c6d0d5]">ADP</p>
            {adp ? (
              <div className="mt-2 space-y-1">
                <p>Updated: {compactTimestamp(adp.provenance.sourceUpdatedAt ?? adp.provenance.fetchedAt)}</p>
                <p>Format: {displayEnum(adp.context.leagueFormat)} · {displayEnum(adp.context.scoringFormat)}</p>
                <p>Sample: {adp.context.sampleSize?.toLocaleString() ?? 'Unavailable'} drafts</p>
                <p>Matched: {adp.resolution.matched}/{adp.resolution.total}</p>
                <p>Confidence: {displayEnum(adp.compatibility.confidence)}</p>
                <p>{adp.compatibility.reasons.join(' ')}</p>
                {adp.provenance.attributionUrl && (
                  <a
                    className="font-bold text-[#b9ff38] underline underline-offset-2"
                    href={adp.provenance.attributionUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {adp.provenance.attributionLabel}
                  </a>
                )}
              </div>
            ) : (
              <p className="mt-2">Automatic market ADP is unavailable.</p>
            )}
          </div>
          <div className="rounded-lg bg-[#071019] p-3">
            <p className="font-black text-[#c6d0d5]">Sleeper draft-room rank</p>
            {roomRankings ? (
              <div className="mt-2 space-y-1">
                <p>Updated: {compactTimestamp(roomRankings.provenance.sourceUpdatedAt ?? roomRankings.provenance.fetchedAt)}</p>
                <p>Sheet: {roomRankings.context.sheet}</p>
                <p>Matched: {roomRankings.resolution.matched}/{roomRankings.resolution.total}</p>
                <p>Confidence: {displayEnum(roomRankings.compatibility.confidence)}</p>
                <p>{roomRankings.compatibility.reasons.join(' ')}</p>
                <a
                  className="font-bold text-[#b9ff38] underline underline-offset-2"
                  href={roomRankings.provenance.attributionUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  Data by First Seed Sports
                </a>
              </div>
            ) : (
              <p className="mt-2">Automatic room order is unavailable.</p>
            )}
          </div>
        </div>
        <p className="mt-3 text-[10px] font-bold uppercase tracking-[0.11em] text-[#60727d]">
          Juancho model {OPPONENT_MODEL_VERSION} · projections, market ADP, and platform room rank remain separate inputs
        </p>
      </details>
    </section>
  );
}

function RecommendationDataEmptyState({
  adp,
  adpBusy,
  automaticAdpAvailable,
  context,
  onImport,
  projectionBusy,
  projectionError,
}: {
  adp: AdpSnapshot | null;
  adpBusy: boolean;
  automaticAdpAvailable: boolean;
  context: LeagueContext;
  onImport: (event: React.ChangeEvent<HTMLInputElement>) => void;
  projectionBusy: boolean;
  projectionError: string | null;
}) {
  const dynasty = context.leagueType.value === 'dynasty';
  const auction = context.draftType.value === 'auction';
  const unresolved = context.leagueType.value === 'unknown';
  if (dynasty || auction || unresolved) {
    const title = dynasty
      ? 'Dynasty recommendations need a licensed dynasty value source.'
      : auction
        ? 'Snake-style recommendations are unavailable for auctions.'
        : 'Confirm the league type before recommendations can run.';
    const body = dynasty
      ? 'Redraft ADP and projections are intentionally not used as dynasty or rookie values.'
      : auction
        ? 'Budget, nomination, and inflation modeling are outside the current draft engine.'
        : 'Open Review league settings and choose the correct league type; the engine will not guess.';
    return (
      <section className="rounded-2xl border border-[#5a4630] bg-[#251d12] p-7 sm:p-9">
        <p className="text-[10px] font-black uppercase tracking-[0.17em] text-[#f0c777]">
          Recommendation unavailable
        </p>
        <h2 className="mt-3 text-3xl font-black tracking-[-0.04em]">{title}</h2>
        <p className="mt-3 max-w-2xl text-sm leading-6 text-[#c7ad7c]">{body}</p>
      </section>
    );
  }
  return (
    <section className="rounded-2xl border border-dashed border-[#41535e] bg-[#0c1822] p-7 sm:p-9">
      <p className="text-[10px] font-black uppercase tracking-[0.17em] text-[#b9ff38]">Recommendation readiness</p>
      <h2 className="mt-3 text-3xl font-black tracking-[-0.04em]">
        {projectionBusy ? 'Loading weekly draft intelligence…' : 'Automatic projections are not ready yet.'}
      </h2>
      <p className="mt-3 max-w-2xl text-sm leading-6 text-[#8fa0aa]">
        {projectionError
          ? `${projectionError} You can retry from Data readiness or use a custom CSV override.`
          : projectionBusy
            ? 'First Seed projections and draft-room ranks are loading automatically. No upload is required.'
            : adpBusy
              ? 'Market ADP is still loading independently.'
              : adp
                ? `Current ${adp.context.teams}-team ADP is ready; the weekly projection source is still resolving.`
                : automaticAdpAvailable
                  ? 'Automatic sources will retry independently.'
                  : 'This format does not currently have a compatible automatic source.'}
      </p>
      <div className="mt-6 flex flex-wrap gap-3">
        <label className="cursor-pointer rounded-xl bg-[#b9ff38] px-5 py-3 text-xs font-black uppercase tracking-[0.08em] text-[#071019] hover:bg-[#cbff6e]">
          {projectionBusy ? 'Loading…' : 'Use custom CSV override'}
          <input type="file" accept=".csv,text/csv" className="sr-only" onChange={onImport} disabled={projectionBusy} />
        </label>
        <a
          href="/projection-template.csv"
          download
          className="rounded-xl border border-[#2a3c49] px-5 py-3 text-xs font-black uppercase tracking-[0.08em] text-[#c2ccd1] hover:border-[#52646f]"
        >
          Download template
        </a>
      </div>
    </section>
  );
}

function DraftCompleteState({ draftWorkspace }: { draftWorkspace: DraftWorkspace }) {
  return (
    <section className="rounded-2xl border border-[#263845] bg-[#0c1822] p-7">
      <p className="text-[10px] font-black uppercase tracking-[0.17em] text-[#b9ff38]">Draft complete</p>
      <h2 className="mt-3 text-3xl font-black tracking-[-0.04em]">All {draftWorkspace.board.picksMade} selections are final.</h2>
      <p className="mt-3 text-sm text-[#8fa0aa]">Draft-now advice is disabled. Your roster and selection history remain available below for review.</p>
    </section>
  );
}

function DraftContextPanel({
  workspace,
  draftWorkspace,
  context,
  userId,
}: {
  workspace: LeagueWorkspace;
  draftWorkspace: DraftWorkspace;
  context: LeagueContext;
  userId: string;
}) {
  const userRosterId = context.draftState.value.userRosterId;
  const userCounts = userRosterId === null
    ? {}
    : getRosterPositionCounts(
        userRosterId,
        draftWorkspace.picks,
        workspace.rosters,
        draftWorkspace.players,
      );
  const targets = getStarterTargets(context.roster.value);
  const ownerByRoster = new Map(
    workspace.rosterViews.map((view) => [view.roster.roster_id, view]),
  );
  const intervening = context.draftState.value.interveningSelections.slice(0, 8);
  const rosterPlayerIds = new Set<string>();
  for (const pick of draftWorkspace.picks) {
    if (Number(pick.roster_id) === userRosterId) rosterPlayerIds.add(pick.player_id);
  }
  const storedRoster = workspace.rosters.find((roster) => roster.roster_id === userRosterId);
  for (const playerId of storedRoster?.players ?? []) rosterPlayerIds.add(playerId);
  const myPlayers = [...rosterPlayerIds]
    .map((playerId) => draftWorkspace.players.bySleeperId.get(playerId))
    .filter(Boolean);

  return (
    <aside className="h-fit rounded-2xl border border-[#263845] bg-[#0c1822] p-5 xl:sticky xl:top-24">
      <p className="text-[10px] font-black uppercase tracking-[0.16em] text-[#71838e]">My roster</p>
      <div className="mt-3 flex flex-wrap gap-2">
        {(['QB', 'RB', 'WR', 'TE'] as const).map((position) => (
          <span key={position} className="rounded-lg bg-[#13232c] px-2.5 py-2 text-xs font-bold">
            {position} {userCounts[position] ?? 0}/{targets[position]}
          </span>
        ))}
      </div>
      {myPlayers.length > 0 ? (
        <div className="mt-4 space-y-2">
          {myPlayers.slice(0, 10).map((player) => (
            <div key={player!.id} className="flex justify-between gap-3 rounded-lg bg-[#071019] px-3 py-2 text-xs">
              <span className="truncate font-bold">{player!.name}</span>
              <span className="text-[#71838e]">{player!.position}</span>
            </div>
          ))}
        </div>
      ) : (
        <p className="mt-4 text-xs leading-5 text-[#71838e]">Your roster is empty. This space will fill with your selections instead of listing every empty team.</p>
      )}

      <div className="mt-6 border-t border-[#20313d] pt-5">
        <p className="text-[10px] font-black uppercase tracking-[0.16em] text-[#71838e]">Before your next pick</p>
        {intervening.length > 0 ? (
          <div className="mt-3 space-y-2">
            {intervening.map((selection) => {
              const view = selection.ownerRosterId === null
                ? null
                : ownerByRoster.get(selection.ownerRosterId) ?? null;
              const counts = selection.ownerRosterId === null
                ? {}
                : getRosterPositionCounts(
                    selection.ownerRosterId,
                    draftWorkspace.picks,
                    workspace.rosters,
                    draftWorkspace.players,
                  );
              const needs = (['QB', 'RB', 'WR', 'TE'] as const)
                .filter((position) => (counts[position] ?? 0) < targets[position])
                .slice(0, 3);
              return (
                <div key={selection.overallPick} className="rounded-lg bg-[#13232c] p-3">
                  <div className="flex items-center justify-between gap-3 text-xs">
                    <span className="truncate font-bold">{view?.teamName ?? `Roster ${selection.ownerRosterId ?? 'unknown'}`}</span>
                    <span className="text-[#71838e]">Pick {selection.overallPick}</span>
                  </div>
                  <p className="mt-1 text-[11px] text-[#8fa0aa]">
                    {needs.length > 0 ? `Needs ${needs.join(' · ')}` : 'Starter needs currently filled'}
                  </p>
                </div>
              );
            })}
          </div>
        ) : (
          <p className="mt-3 text-xs leading-5 text-[#71838e]">No intervening snake selections are available for this draft state.</p>
        )}
      </div>

      <details className="mt-5 border-t border-[#20313d] pt-4 text-xs">
        <summary className="cursor-pointer font-bold text-[#8fa0aa]">All league rosters</summary>
        <div className="mt-3 space-y-2">
          {workspace.rosterViews.map((view) => (
            <div key={view.roster.roster_id} className="flex justify-between gap-3 text-[#71838e]">
              <span className={view.roster.owner_id === userId ? 'font-bold text-[#b9ff38]' : ''}>{view.teamName}</span>
              <span>{view.roster.players?.length ?? 0} players</span>
            </div>
          ))}
        </div>
      </details>
    </aside>
  );
}

function ContextSource({
  label,
  item,
}: {
  label: string;
  item: { source: string; confidence: string };
}) {
  return (
    <div className="rounded-lg bg-[#0c1822] p-3">
      <p className="font-bold text-[#b8c3c9]">
        {label} · {displayEnum(item.confidence)} confidence
      </p>
      <p className="mt-1 text-[11px] leading-4">{item.source}</p>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-[#071019] p-4">
      <p className="text-[10px] font-black uppercase tracking-[0.15em] text-[#60727d]">
        {label}
      </p>
      <p className="mt-2 text-sm font-bold text-[#e2e8eb]">{value}</p>
    </div>
  );
}

function DraftPanel({
  workspace,
  draftWorkspace,
  busy,
  onSelectDraft,
  onRefresh,
}: {
  workspace: LeagueWorkspace;
  draftWorkspace: DraftWorkspace | null;
  busy: BusyState;
  onSelectDraft: (draftId: string) => void;
  onRefresh: () => void;
}) {
  if (workspace.drafts.length === 0) {
    return (
      <EmptyState
        title="No draft attached to this league"
        body="Sleeper returned the league and rosters successfully, but it does not currently expose a draft for this league."
      />
    );
  }

  return (
    <section className="rounded-2xl border border-[#263845] bg-[#0c1822] p-5 sm:p-6">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <p className="text-xs font-black uppercase tracking-[0.16em] text-[#71838e]">
            Draft synchronization
          </p>
          <h2 className="mt-2 text-2xl font-black tracking-[-0.03em]">
            Picks and availability
          </h2>
        </div>
        <select
          value={draftWorkspace?.draft.draft_id ?? ''}
          onChange={(event) => onSelectDraft(event.target.value)}
          disabled={busy !== null}
          className="h-11 rounded-xl border border-[#2a3c49] bg-[#071019] px-4 text-sm font-bold text-white outline-none focus:border-[#b9ff38]"
        >
          {workspace.drafts.map((draft) => (
            <option key={draft.draft_id} value={draft.draft_id}>
              {draftLabel(draft)}
            </option>
          ))}
        </select>
      </div>

      {busy === 'draft' && !draftWorkspace ? (
        <div className="mt-6 flex items-center gap-3 text-sm font-bold text-[#8b9aa3]">
          <LoadingMark /> Loading picks and active player map…
        </div>
      ) : draftWorkspace ? (
        <>
          <div className="mt-6 grid gap-3 sm:grid-cols-4">
            <Metric
              label="Status"
              value={draftStatusLabel(draftWorkspace.draft.status)}
            />
            <Metric label="Picks made" value={String(draftWorkspace.board.picksMade)} />
            <Metric
              label="On the clock"
              value={
                draftWorkspace.draft.status === 'complete'
                  ? 'Draft complete'
                  : `Round ${draftWorkspace.board.currentRound} · Pick ${draftWorkspace.board.pickInRound}`
              }
            />
            <Metric
              label="Available players"
              value={draftWorkspace.board.availablePlayers.length.toLocaleString()}
            />
          </div>

          <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-[#20313d] pt-5">
            <p className="text-xs text-[#657680]">
              {draftWorkspace.draft.status === 'drafting'
                ? 'Live refresh every 5 seconds'
                : 'Snapshot'}{' '}
              · synced {draftWorkspace.syncedAt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })}
            </p>
            <button
              onClick={onRefresh}
              className="rounded-lg border border-[#2a3c49] px-3 py-2 text-xs font-bold text-[#c2ccd1] hover:border-[#52646f]"
            >
              Refresh picks
            </button>
          </div>

          {draftWorkspace.picks.length > 0 && (
            <div className="mt-5">
              <p className="mb-3 text-[10px] font-black uppercase tracking-[0.16em] text-[#60727d]">
                Latest selections
              </p>
              <div className="flex gap-3 overflow-x-auto pb-2">
                {[...draftWorkspace.picks]
                  .sort((a, b) => b.pick_no - a.pick_no)
                  .slice(0, 8)
                  .map((pick) => (
                    <div
                      key={`${pick.pick_no}-${pick.player_id}`}
                      className="min-w-40 rounded-xl bg-[#13232c] p-3"
                    >
                      <p className="text-[10px] font-black uppercase tracking-[0.12em] text-[#60727d]">
                        Pick {pick.pick_no}
                      </p>
                      <p className="mt-1 truncate text-sm font-bold">
                        {[pick.metadata.first_name, pick.metadata.last_name]
                          .filter(Boolean)
                          .join(' ') || pick.player_id}
                      </p>
                      <p className="mt-1 text-xs text-[#8a9ba5]">
                        {pick.metadata.position || '—'} · {pick.metadata.team || 'FA'}
                      </p>
                    </div>
                  ))}
              </div>
            </div>
          )}
        </>
      ) : null}
    </section>
  );
}

function ProjectionPanel({
  mapping,
  filename,
  busy,
  onImport,
  onRestoreAutomatic,
  projectionMode,
  available,
}: {
  mapping: ProjectionMappingResult | null;
  filename: string | null;
  busy: boolean;
  onImport: (event: React.ChangeEvent<HTMLInputElement>) => void;
  onRestoreAutomatic: () => void;
  projectionMode: ProjectionMode;
  available: Array<{
    projection: ProjectionMappingResult['mapped'][number];
    player: CanonicalPlayerMap['players'][number] | undefined;
  }>;
}) {
  return (
    <section className="rounded-2xl border border-[#263845] bg-[#0c1822] p-5 sm:p-6">
      <div className="flex flex-col justify-between gap-5 sm:flex-row sm:items-start">
        <div>
          <p className="text-xs font-black uppercase tracking-[0.16em] text-[#71838e]">
            Advanced data source · optional override
          </p>
          <h2 className="mt-2 text-2xl font-black tracking-[-0.03em]">
            Projection mapping
          </h2>
          <p className="mt-2 max-w-xl text-sm leading-6 text-[#82939d]">
            Automatic weekly First Seed projections require no upload. For a
            custom override, the only required columns are player, position, and
            projection. Add sleeper_id for exact matching; rank, adp, scoring
            metadata, and stat lines are optional.{' '}
            <a
              href="/projection-template.csv"
              download
              className="font-bold text-[#b9ff38] underline decoration-[#b9ff38]/35 underline-offset-4"
            >
              Download template
            </a>
            .
          </p>
          <p className="mt-2 max-w-xl text-xs leading-5 text-[#60727d]">
            Aggregate fantasy points remain usable, but custom-scoring support is
            labeled limited unless the source format is declared or a complete
            stat line is included.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {projectionMode === 'custom' && (
            <button
              type="button"
              onClick={onRestoreAutomatic}
              className="h-11 rounded-xl border border-[#2a3c49] px-4 text-xs font-black uppercase tracking-[0.08em] text-[#c2ccd1]"
            >
              Restore automatic
            </button>
          )}
          <label className="flex h-11 cursor-pointer items-center justify-center gap-2 rounded-xl bg-[#b9ff38] px-4 text-xs font-black uppercase tracking-[0.08em] text-[#071019] hover:bg-[#cbff6e]">
            {busy && <LoadingMark />}
            {busy ? 'Loading' : projectionMode === 'custom' ? 'Replace CSV' : 'Use custom CSV'}
            <input
              type="file"
              accept=".csv,text/csv"
              className="sr-only"
              onChange={onImport}
              disabled={busy}
            />
          </label>
        </div>
      </div>

      {mapping && (
        <>
          <div className="mt-6 grid gap-3 sm:grid-cols-3">
            <Metric label="File" value={filename || 'CSV import'} />
            <Metric label="Mapped" value={mapping.mapped.length.toLocaleString()} />
            <Metric
              label="Needs review"
              value={mapping.unmatched.length.toLocaleString()}
            />
          </div>

          {mapping.unmatched.length > 0 && (
            <details className="mt-4 rounded-xl border border-[#5a4630] bg-[#251d12] p-4 text-sm">
              <summary className="cursor-pointer font-bold text-[#f0c777]">
                Review {mapping.unmatched.length} unmatched rows
              </summary>
              <ul className="mt-3 space-y-1 text-xs text-[#c7ad7c]">
                {mapping.unmatched.slice(0, 12).map((row) => (
                  <li key={`${row.sourceRow}-${row.playerName}`}>
                    Row {row.sourceRow}: {row.playerName} ({row.reason.replaceAll('-', ' ')})
                  </li>
                ))}
              </ul>
            </details>
          )}

          <div className="mt-6 overflow-hidden rounded-xl border border-[#20313d]">
            <div className="grid grid-cols-[minmax(0,1fr)_70px_78px_64px] bg-[#13232c] px-4 py-3 text-[10px] font-black uppercase tracking-[0.14em] text-[#71838e]">
              <span>Best available</span>
              <span className="text-right">Proj.</span>
              <span className="text-right">ADP</span>
              <span className="text-right">Rank</span>
            </div>
            {available.length > 0 ? (
              available.map(({ player, projection }) => (
                <div
                  key={projection.playerId}
                  className="grid grid-cols-[minmax(0,1fr)_70px_78px_64px] items-center border-t border-[#20313d] px-4 py-3 text-sm"
                >
                  <div className="min-w-0">
                    <p className="truncate font-bold">{player?.name || projection.playerName}</p>
                    <p className="text-xs text-[#71838e]">
                      {player?.position || projection.position} · {player?.team || 'FA'}
                    </p>
                  </div>
                  <span className="text-right font-black text-[#b9ff38]">
                    {projection.projection.toFixed(1)}
                  </span>
                  <span className="text-right text-[#a2b0b8]">
                    {projection.adp?.toFixed(1) ?? '—'}
                  </span>
                  <span className="text-right font-bold">{projection.rank}</span>
                </div>
              ))
            ) : (
              <p className="border-t border-[#20313d] px-4 py-6 text-sm text-[#71838e]">
                No mapped projection rows match the currently available player pool.
              </p>
            )}
          </div>
        </>
      )}
    </section>
  );
}

function RecommendationPanel({ result }: { result: DraftRecommendationResult }) {
  const [primary, ...alternatives] = result.recommendations.slice(0, 3);
  if (!primary) {
    return (
      <div className="mt-6 rounded-xl border border-[#5a4630] bg-[#251d12] p-5">
        <p className="text-sm font-black text-[#f0c777]">
          {result.status === 'data_required'
            ? 'Additional format data required'
            : result.status === 'unsupported'
              ? 'Recommendation mode unavailable'
              : 'No eligible players to score'}
        </p>
        <ul className="mt-3 space-y-2 text-xs leading-5 text-[#c7ad7c]">
          {(result.messages.length > 0
            ? result.messages
            : ['The mapped CSV does not contain an eligible available player.']
          ).map((message) => (
            <li key={message}>· {message}</li>
          ))}
        </ul>
      </div>
    );
  }

  return (
    <div className="mt-6 overflow-hidden rounded-2xl border border-[#354853] bg-[#071019]">
      <div className="flex flex-col justify-between gap-3 border-b border-[#20313d] px-5 py-4 sm:flex-row sm:items-center">
        <div>
          <p className="text-[10px] font-black uppercase tracking-[0.17em] text-[#b9ff38]">
            Best pick
          </p>
          <p className="mt-1 text-xs text-[#71838e]">
            {result.nextUserPick !== null
              ? `${result.userDraftSlot ? `Draft slot ${result.userDraftSlot} · ` : ''}next selection at pick ${result.nextUserPick}`
              : 'Turn-based next selection is unavailable for this format'}
          </p>
        </div>
        <span className="w-fit rounded-full border border-[#2d414d] px-3 py-1.5 text-[10px] font-black uppercase tracking-[0.12em] text-[#8fa0aa]">
          {result.picksUntilNextUserPick === null
            ? 'No snake estimate'
            : `${result.picksUntilNextUserPick} picks away`}
        </span>
      </div>

      <div className="p-5 sm:p-6">
        {result.messages.length > 0 && (
          <details className="mb-5 rounded-xl border border-[#5a4630] bg-[#251d12] p-4">
            <summary className="cursor-pointer text-xs font-black uppercase tracking-[0.12em] text-[#f0c777]">
              {result.status === 'limited' ? 'Limited support · review assumptions' : 'Model notes'}
            </summary>
            <ul className="mt-3 space-y-1 text-xs leading-5 text-[#c7ad7c]">
              {result.messages.map((message) => (
                <li key={message}>· {message}</li>
              ))}
            </ul>
          </details>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <ActionBadge recommendation={primary} />
          <MarketEdgeBadge recommendation={primary} />
        </div>
        <div className="mt-4 flex flex-col justify-between gap-5 sm:flex-row sm:items-start">
          <div>
            <h3 className="text-3xl font-black tracking-[-0.04em] sm:text-4xl">
              {primary.player.name}
            </h3>
            <p className="mt-1 text-sm font-bold text-[#82939d]">
              {primary.player.position} · {primary.player.team || 'FA'} · Tier{' '}
              {primary.tier}
            </p>
          </div>
          <div className="sm:text-right">
            <p className="text-5xl font-black tracking-[-0.07em] text-[#b9ff38]">
              {primary.score.toFixed(1)}
            </p>
            <p className="text-[10px] font-black uppercase tracking-[0.14em] text-[#60727d]">
              Draft score
            </p>
          </div>
        </div>

        {primary.availableNextPickProbability !== null && (
          <div className="mt-6 rounded-xl border border-[#2a3d48] bg-[#0c1822] p-4">
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-sm font-bold">
                  {primary.nextPickConfidence === 'high' ? 'Available' : 'Estimated available'} at your next selection
                </p>
                <p className="mt-1 text-[10px] font-black uppercase tracking-[0.12em] text-[#71838e]">
                  {displayEnum(primary.nextPickConfidence)} confidence · market ADP + room rank
                </p>
              </div>
              <p
                className={`text-xl font-black ${
                  primary.availableNextPickProbability <= 45
                    ? 'text-[#ff7a59]'
                    : 'text-[#d5a858]'
                }`}
              >
                {primary.nextPickConfidence === 'high' ? '' : '≈'}
                {Math.round(primary.availableNextPickProbability)}%
              </p>
            </div>
            <div className="mt-3 h-2 overflow-hidden rounded-full bg-[#263844]">
              <div
                className={`h-full rounded-full ${
                  primary.availableNextPickProbability <= 45
                    ? 'bg-[#ff7a59]'
                    : 'bg-[#d5a858]'
                }`}
                style={{ width: `${primary.availableNextPickProbability}%` }}
              />
            </div>
            <details className="mt-3 border-t border-[#20313d] pt-3 text-xs text-[#71838e]">
              <summary className="cursor-pointer font-bold text-[#9aa9b1]">How this estimate works</summary>
              <ul className="mt-2 space-y-1.5 leading-5">
                <li>· {primary.nextPickExplanation.picksBeforeNextSelection ?? 'Unknown'} picks before your next selection</li>
                <li>· {primary.nextPickExplanation.interveningTeamsWithNeed} intervening teams currently need {primary.player.position}</li>
                <li>· Market ADP: {primary.nextPickExplanation.playerAdp?.toFixed(1) ?? 'Unavailable'} · room rank: {primary.nextPickExplanation.draftRoomRank?.toFixed(0) ?? 'Unavailable'} · current selection: {primary.nextPickExplanation.currentSelection}</li>
                <li>· ADP source: {primary.nextPickExplanation.adpSource}</li>
                <li>· League match: {displayEnum(primary.nextPickExplanation.adpMatchLevel)} · {displayEnum(primary.nextPickConfidence)} confidence</li>
                {primary.nextPickExplanation.adpMatchReasons.map((reason) => (
                  <li key={reason}>· {reason}</li>
                ))}
              </ul>
            </details>
          </div>
        )}

        <ul className="mt-5 grid gap-3 text-sm text-[#c0cad0] sm:grid-cols-2">
          {primary.reasons.map((reason) => (
            <li key={reason} className="flex gap-2">
              <span className="text-[#b9ff38]">+</span>
              <span>{reason}</span>
            </li>
          ))}
        </ul>

        <ModelInspector recommendation={primary} context={result.context} />

        {alternatives.length > 0 && (
          <div className="mt-6 grid gap-3 border-t border-[#20313d] pt-5 sm:grid-cols-2">
            {alternatives.map((recommendation) => (
              <div key={recommendation.player.id} className="rounded-xl bg-[#13232c] p-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <p className="truncate font-black">{recommendation.player.name}</p>
                    <p className="mt-1 text-xs text-[#71838e]">
                      {recommendation.player.position} · Tier {recommendation.tier}
                    </p>
                  </div>
                  <p className="text-xl font-black text-[#dfe6e9]">
                    {recommendation.score.toFixed(1)}
                  </p>
                </div>
                <div className="mt-4 flex items-center justify-between gap-3">
                  <div className="flex flex-wrap gap-2">
                    <ActionBadge recommendation={recommendation} compact />
                    <MarketEdgeBadge recommendation={recommendation} compact />
                  </div>
                  <p className="text-xs font-bold text-[#8fa0aa]">
                    {recommendation.availableNextPickProbability === null
                      ? 'No next-pick estimate'
                      : `${recommendation.nextPickConfidence === 'high' ? '' : '≈'}${Math.round(recommendation.availableNextPickProbability)}% next pick`}
                  </p>
                </div>
                <ModelInspector
                  recommendation={recommendation}
                  context={result.context}
                  compact
                />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ActionBadge({
  recommendation,
  compact = false,
}: {
  recommendation: DraftRecommendation;
  compact?: boolean;
}) {
  const draftNow = recommendation.action === 'DRAFT_NOW';
  return (
    <span
      className={`inline-flex w-fit items-center gap-2 rounded-full font-black uppercase tracking-[0.13em] ${
        compact ? 'px-2.5 py-1 text-[9px]' : 'px-3 py-1.5 text-[10px]'
      } ${
        draftNow
          ? 'bg-[#ff7a59]/15 text-[#ff9a80]'
          : 'bg-[#d5a858]/15 text-[#e5bd70]'
      }`}
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${
          draftNow ? 'bg-[#ff7a59]' : 'bg-[#d5a858]'
        }`}
      />
      {draftNow ? 'Draft now' : 'Wait'}
    </span>
  );
}

function MarketEdgeBadge({
  recommendation,
  compact = false,
}: {
  recommendation: DraftRecommendation;
  compact?: boolean;
}) {
  if (recommendation.marketEdge === null || Math.abs(recommendation.marketEdge) < 8) {
    return null;
  }
  const target = recommendation.marketEdge > 0;
  return (
    <span
      className={`inline-flex w-fit rounded-full font-black uppercase tracking-[0.12em] ${
        compact ? 'px-2.5 py-1 text-[9px]' : 'px-3 py-1.5 text-[10px]'
      } ${
        target
          ? 'bg-[#b9ff38]/12 text-[#b9ff38]'
          : 'bg-[#ff7a59]/12 text-[#ff9a80]'
      }`}
      title={`Juancho rank ${recommendation.juanchoRank}; market ADP ${recommendation.marketAdp?.toFixed(1)}`}
    >
      {target ? 'Target' : 'Avoid at cost'} · {Math.abs(Math.round(recommendation.marketEdge))} picks
    </span>
  );
}

function ModelInspector({
  recommendation,
  context,
  compact = false,
}: {
  recommendation: DraftRecommendation;
  context: LeagueContext;
  compact?: boolean;
}) {
  const components = [
    ['VORP', recommendation.components.vorp, '30%'],
    ['Next-pick risk', recommendation.components.nextPickRisk, '20%'],
    ['Tier urgency', recommendation.components.tierUrgency, '15%'],
    ['Projection', recommendation.components.projection, '15%'],
    ['Roster fit', recommendation.components.rosterFit, '10%'],
    ['ADP value', recommendation.components.adpValue, '5%'],
    ['Scarcity', recommendation.components.scarcity, '5%'],
  ] as const;

  return (
    <details
      className={`${compact ? 'mt-4 bg-[#071019]' : 'mt-6 bg-[#0c1822]'} rounded-xl border border-[#20313d] p-4`}
    >
      <summary className="cursor-pointer text-xs font-black uppercase tracking-[0.13em] text-[#8fa0aa]">
        Model inspector
      </summary>
      <div className="mt-4 grid gap-x-6 gap-y-3 sm:grid-cols-2">
        {components.map(([label, value, weight]) => (
          <div key={label}>
            <div className="flex items-center justify-between text-[10px] font-bold uppercase tracking-[0.1em]">
              <span className="text-[#7f919c]">{label} · {weight}</span>
              <span>{Math.round(value)}</span>
            </div>
            <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-[#263844]">
              <div
                className="h-full rounded-full bg-[#b9ff38]"
                style={{ width: `${value}%` }}
              />
            </div>
          </div>
        ))}
      </div>
      <div className="mt-5 grid gap-3 border-t border-[#20313d] pt-4 text-xs sm:grid-cols-2">
        <InspectorGroup
          label="Raw model inputs"
          rows={[
            ['Projected points', recommendation.raw.projectedPoints.toFixed(1)],
            ['Provider points', recommendation.raw.sourceProjectedPoints.toFixed(1)],
            ['Replacement level', recommendation.raw.replacementProjection.toFixed(1)],
            ['Replacement demand', `Player ${recommendation.raw.replacementDemand}`],
            ['VORP', recommendation.raw.vorp.toFixed(1)],
            ['Juancho rank', String(recommendation.juanchoRank)],
            ['Market ADP', recommendation.marketAdp?.toFixed(1) ?? 'Unavailable'],
            ['Sleeper room rank', recommendation.draftRoomRank?.toFixed(0) ?? 'Unavailable'],
            ['External expert rank', recommendation.externalExpertRank?.toFixed(0) ?? 'Unavailable'],
            ['First Seed value delta', recommendation.firstSeedValueDelta?.toFixed(1) ?? 'Unavailable'],
            ['Tier', String(recommendation.tier)],
            ['Roster need', recommendation.raw.rosterNeed.toFixed(1)],
            [
              'Next-pick probability',
              recommendation.availableNextPickProbability === null
                ? 'Unavailable'
                : `${recommendation.availableNextPickProbability.toFixed(1)}% (${recommendation.nextPickConfidence})`,
            ],
          ]}
        />
        <InspectorGroup
          label="League context"
          rows={[
            ['League type', displayEnum(context.leagueType.value)],
            ['Draft context', displayEnum(context.draftContext.value)],
            ['Draft order', displayEnum(context.draftType.value)],
            ['Lineup', displayEnum(context.lineupType.value)],
            ['Scoring', displayEnum(context.scoring.value.profile)],
            [
              'Roster',
              `${context.roster.value.QB}QB · ${context.roster.value.RB}RB · ${context.roster.value.WR}WR · ${context.roster.value.TE}TE · ${context.roster.value.FLEX}FLEX · ${context.roster.value.SUPER_FLEX}SF`,
            ],
            [
              'Scoring applied',
              recommendation.raw.scoringAdjusted
                ? 'Recalculated from stat line'
                : 'Provider aggregate points',
            ],
          ]}
        />
      </div>
    </details>
  );
}

function InspectorGroup({
  label,
  rows,
}: {
  label: string;
  rows: Array<readonly [string, string]>;
}) {
  return (
    <div>
      <p className="mb-2 text-[10px] font-black uppercase tracking-[0.12em] text-[#60727d]">
        {label}
      </p>
      <dl className="space-y-1.5">
        {rows.map(([name, value]) => (
          <div key={name} className="flex justify-between gap-3">
            <dt className="text-[#71838e]">{name}</dt>
            <dd className="text-right font-bold text-[#c6d0d5]">{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
