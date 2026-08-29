'use client';

/**
 * The three data sources the recommendation stands on, loaded and kept fresh.
 *
 * Lifted out of the dashboard component unchanged in behaviour: each source
 * fetches independently, falls back to its last known good copy, retries on its
 * own, and never takes the screen down with it. The point of the extraction is
 * that the dashboard is now about composing a draft room rather than about
 * cache policy.
 *
 * A custom CSV, once imported, wins over the automatic First Seed feed for that
 * season until it is explicitly restored - which is why the cached override is
 * read on attach, before the automatic effect has a chance to run.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  automaticAdpCacheKey,
  fetchAutomaticAdp,
  mapAdpSnapshot,
  planAutomaticAdp,
  projectionCacheKey,
} from '@/packages/adp/automatic';
import { isAdpSourceSnapshot } from '@/packages/adp/providers/fantasy-football-calculator';
import { loadWithLastGood, readLastGood, writeLastGood } from '@/packages/data/cache';
import {
  createCsvProjectionSnapshot,
  isProjectionSnapshot,
} from '@/packages/data/projections';
import type {
  AdpSnapshot,
  DraftRoomRankingSnapshot,
  ProjectionSnapshot,
} from '@/packages/data/types';
import type { LeagueContext } from '@/packages/engine/context/types';
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
import { mapSupplementalRankings } from '@/packages/fantasy-pros/mapping';
import type { SupplementalRankingSnapshot } from '@/packages/fantasy-pros/types';
import type { CanonicalPlayerMap } from '@/packages/players/types';
import { mapProjectionRecords } from '@/packages/projections/mapping';
import { CsvProjectionProvider } from '@/packages/projections/providers/csv';

const ADP_REFRESH_INTERVAL_MS = 12 * 60 * 60 * 1000;

/** The shape of the committed K/DST asset, before it meets a player map. */
interface SupplementalSource {
  season: string;
  provenance: Parameters<typeof mapSupplementalRankings>[0]['provenance'];
  rows: Parameters<typeof mapSupplementalRankings>[0]['rows'];
}

export type ProjectionMode = 'automatic' | 'custom' | null;

export interface DraftSources {
  projections: ProjectionSnapshot | null;
  projectionMode: ProjectionMode;
  projectionBusy: boolean;
  projectionError: string | null;
  roomRankings: DraftRoomRankingSnapshot | null;
  roomBusy: boolean;
  roomError: string | null;
  adp: AdpSnapshot | null;
  adpBusy: boolean;
  adpError: string | null;
  /**
   * A board for the two positions First Seed does not publish.
   *
   * A static seasonal file rather than a feed: it is a published expert
   * ranking, it changes rarely, and it is used for nothing but the order of the
   * kicker and defense shortlist.
   */
  supplemental: SupplementalRankingSnapshot | null;
  /** True while any source is still resolving for the first time. */
  loading: boolean;
  retryAll: () => void;
  importCsv: (event: React.ChangeEvent<HTMLInputElement>) => Promise<void>;
  restoreAutomatic: () => void;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : 'The source could not be loaded.';
}

export function useDraftSources({
  season,
  draftSeason,
  draftId,
  players,
  context,
}: {
  season: string | null;
  draftSeason: string | null;
  draftId: string | null;
  players: CanonicalPlayerMap | null;
  context: LeagueContext | null;
}): DraftSources {
  const [projections, setProjections] = useState<ProjectionSnapshot | null>(null);
  const [projectionMode, setProjectionMode] = useState<ProjectionMode>(null);
  const [projectionBusy, setProjectionBusy] = useState(false);
  const [projectionError, setProjectionError] = useState<string | null>(null);
  const [roomRankings, setRoomRankings] = useState<DraftRoomRankingSnapshot | null>(null);
  const [roomBusy, setRoomBusy] = useState(false);
  const [roomError, setRoomError] = useState<string | null>(null);
  const [adp, setAdp] = useState<AdpSnapshot | null>(null);
  const [adpBusy, setAdpBusy] = useState(false);
  const [adpError, setAdpError] = useState<string | null>(null);
  const [supplementalRows, setSupplementalRows] = useState<{
    season: string;
    provenance: SupplementalSource['provenance'];
    rows: SupplementalSource['rows'];
  } | null>(null);
  const [nonce, setNonce] = useState(0);

  const adpPlan = useMemo(
    () => (context && season ? planAutomaticAdp(context, season) : null),
    [context, season],
  );
  const firstSeedPlan = useMemo(
    () => (context ? planAutomaticFirstSeed(context) : null),
    [context],
  );
  const usingCustom = projectionMode === 'custom';

  /* Any stored CSV override for this season wins, and is read before the
   * automatic feed can claim the slot. */
  useEffect(() => {
    if (!draftId || !draftSeason || !players) return;
    const cached = readLastGood({
      storage: window.localStorage,
      key: projectionCacheKey(draftSeason),
      validate: isProjectionSnapshot,
    });
    if (!cached) return;
    const records = cached.value.records.filter((record) => players.byId.has(record.playerId));
    if (records.length === 0) return;

    /*
     * Deferred off the effect's synchronous body. Every state write in this
     * hook happens on a microtask for the same reason: writing during the
     * effect pass cascades a second render for something that is about to be
     * followed by an async result anyway.
     */
    let cancelled = false;
    void Promise.resolve().then(() => {
      if (cancelled) return;
      setProjectionMode('custom');
      setProjections({
        ...cached.value,
        records,
        resolution: { ...cached.value.resolution, matched: records.length },
      });
    });
    return () => {
      cancelled = true;
    };
  }, [draftId, draftSeason, players]);

  /* First Seed projections. */
  useEffect(() => {
    if (usingCustom || !firstSeedPlan || !draftSeason || !players) return;
    const controller = new AbortController();
    let cancelled = false;
    void Promise.resolve().then(() => {
      if (cancelled) return;
      setProjectionBusy(true);
      setProjectionError(null);
    });

    void loadWithLastGood({
      storage: window.localStorage,
      key: firstSeedProjectionCacheKey(draftSeason, firstSeedPlan.projectionFormat),
      validate: isProjectionSourceSnapshot,
      fetchFresh: () =>
        fetchFirstSeedProjections({
          season: draftSeason,
          scoringFormat: firstSeedPlan.projectionFormat,
          signal: controller.signal,
        }),
      refreshIntervalMs: FIRST_SEED_REFRESH_INTERVAL_MS,
      forceRefresh: nonce > 0,
    })
      .then((result) => {
        if (cancelled) return;
        setProjections(mapFirstSeedProjectionSnapshot(result.value, players));
        setProjectionMode('automatic');
        setProjectionError(result.refreshError);
      })
      .catch((error) => {
        if (cancelled || controller.signal.aborted) return;
        setProjections(null);
        setProjectionMode(null);
        setProjectionError(describe(error));
      })
      .finally(() => {
        if (!cancelled) setProjectionBusy(false);
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [firstSeedPlan, draftSeason, players, usingCustom, nonce]);

  /* First Seed's Sleeper draft-room board for this exact format. */
  useEffect(() => {
    if (!firstSeedPlan || !draftSeason || !players || !context) return;
    const controller = new AbortController();
    let cancelled = false;
    void Promise.resolve().then(() => {
      if (cancelled) return;
      setRoomBusy(true);
      setRoomError(null);
    });

    void loadWithLastGood({
      storage: window.localStorage,
      key: firstSeedRoomRankingCacheKey(
        draftSeason,
        firstSeedPlan.roomFormat,
        firstSeedPlan.qbFormat,
      ),
      validate: isDraftRoomRankingSourceSnapshot,
      fetchFresh: () =>
        fetchFirstSeedRoomRankings({
          season: draftSeason,
          scoringFormat: firstSeedPlan.roomFormat,
          qbFormat: firstSeedPlan.qbFormat,
          signal: controller.signal,
        }),
      refreshIntervalMs: FIRST_SEED_REFRESH_INTERVAL_MS,
      forceRefresh: nonce > 0,
    })
      .then((result) => {
        if (cancelled) return;
        setRoomRankings(mapFirstSeedDraftRoomRankingSnapshot(result.value, players, context));
        setRoomError(result.refreshError);
      })
      .catch((error) => {
        if (cancelled || controller.signal.aborted) return;
        setRoomRankings(null);
        setRoomError(describe(error));
      })
      .finally(() => {
        if (!cancelled) setRoomBusy(false);
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
    // `context` changes on every pick; the plan and season are what actually
    // decide which sheet to fetch, and the cache absorbs the rest.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [firstSeedPlan, draftSeason, players, nonce]);

  /* Market ADP. Informational only - nothing depends on it. */
  useEffect(() => {
    if (!adpPlan || !players || !context) return;
    const controller = new AbortController();
    let cancelled = false;
    void Promise.resolve().then(() => {
      if (cancelled) return;
      setAdpBusy(true);
      setAdpError(null);
    });

    void loadWithLastGood({
      storage: window.localStorage,
      key: automaticAdpCacheKey(adpPlan.request),
      validate: isAdpSourceSnapshot,
      fetchFresh: () => fetchAutomaticAdp(adpPlan.request, controller.signal),
      refreshIntervalMs: ADP_REFRESH_INTERVAL_MS,
      forceRefresh: nonce > 0,
    })
      .then((result) => {
        if (cancelled) return;
        setAdp(mapAdpSnapshot(result.value, players, context));
        setAdpError(result.refreshError);
      })
      .catch((error) => {
        if (cancelled || controller.signal.aborted) return;
        setAdp(null);
        setAdpError(describe(error));
      })
      .finally(() => {
        if (!cancelled) setAdpBusy(false);
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adpPlan, players, nonce]);

  /*
   * The K/DST board. Fetched once, then mapped against the LIVE player
   * universe rather than at build time, so a kicker who changed teams or left
   * the league resolves - or fails to resolve - the same way everything else
   * does.
   */
  useEffect(() => {
    let cancelled = false;
    void fetch('/fantasy-pros-kdst-2026.json')
      .then((response) => (response.ok ? response.json() : null))
      .then((body) => {
        if (!cancelled) setSupplementalRows(body as typeof supplementalRows);
      })
      .catch(() => {
        // Optional. Without it the shortlist falls back to its old ordering.
        if (!cancelled) setSupplementalRows(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const supplemental = useMemo(() => {
    if (!supplementalRows || !players) return null;
    return mapSupplementalRankings({
      rows: supplementalRows.rows,
      players,
      provenance: supplementalRows.provenance,
      season: supplementalRows.season,
    });
  }, [supplementalRows, players]);

  const importCsv = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (!file || !players || !draftSeason) return;
      setProjectionBusy(true);
      try {
        const provider = new CsvProjectionProvider(await file.text());
        const snapshot = createCsvProjectionSnapshot({
          mapping: mapProjectionRecords(await provider.getRecords(), players),
          filename: file.name,
          season: draftSeason,
        });
        setProjectionMode('custom');
        setProjections(snapshot);
        setProjectionError(null);
        writeLastGood({
          storage: window.localStorage,
          key: projectionCacheKey(draftSeason),
          value: snapshot,
          savedAt: new Date(),
        });
      } catch (error) {
        setProjectionError(describe(error));
      } finally {
        setProjectionBusy(false);
        event.target.value = '';
      }
    },
    [players, draftSeason],
  );

  const restoreAutomatic = useCallback(() => {
    if (!draftSeason) return;
    window.localStorage.removeItem(projectionCacheKey(draftSeason));
    setProjections(null);
    setProjectionMode(null);
    setNonce((current) => current + 1);
  }, [draftSeason]);

  return {
    projections,
    projectionMode,
    projectionBusy,
    projectionError,
    roomRankings,
    roomBusy,
    roomError,
    adp,
    adpBusy,
    adpError,
    supplemental,
    loading: projectionBusy || roomBusy || adpBusy,
    retryAll: useCallback(() => setNonce((current) => current + 1), []),
    importCsv,
    restoreAutomatic,
  };
}
