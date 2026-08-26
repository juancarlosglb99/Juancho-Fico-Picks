'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { SleeperApiError, sleeperClient } from '@/packages/sleeper/client';
import {
  INITIAL_SYNC_STATE,
  draftSnapshotSignature,
  nextSyncDelayMs,
  reduceSyncState,
  type SyncState,
} from '@/packages/sleeper/live-sync';
import type {
  SleeperDraft,
  SleeperDraftPick,
  SleeperTradedPick,
} from '@/packages/sleeper/types';

export interface LiveDraftSnapshot {
  draft: SleeperDraft;
  picks: SleeperDraftPick[];
  tradedPicks: SleeperTradedPick[];
  /** Epoch ms this snapshot was received. */
  fetchedAt: number;
}

export interface LiveDraftSync {
  snapshot: LiveDraftSnapshot | null;
  syncState: SyncState;
  /** Force an immediate sync, cancelling any scheduled one. */
  syncNow: () => void;
}

/** What the hook holds, tagged with the draft it belongs to. */
interface Feed {
  draftId: string | null;
  snapshot: LiveDraftSnapshot | null;
  sync: SyncState;
}

const EMPTY_FEED: Feed = {
  draftId: null,
  snapshot: null,
  sync: INITIAL_SYNC_STATE,
};

const ATTACHED_SYNC: SyncState = { ...INITIAL_SYNC_STATE, phase: 'live' };

function describeSyncError(error: unknown): string {
  if (error instanceof SleeperApiError) {
    return error.status === 404
      ? 'Sleeper no longer recognises that draft ID.'
      : `Sleeper returned an error (${error.status}).`;
  }
  if (error instanceof Error) return error.message;
  return 'Could not reach Sleeper.';
}

/**
 * Follows a Sleeper draft in near real time.
 *
 * Behaviour that matters:
 *   - Polls from the moment you attach, INCLUDING while the room is still in
 *     `pre_draft`, so the transition into a live draft is picked up on its own.
 *   - Only publishes a new snapshot when the board actually changed, so the
 *     recommendation engine is not re-run several times a second for nothing.
 *   - A failed request does not clear the board and does not raise an error
 *     banner. It moves the status to "reconnecting" and retries with exponential
 *     backoff until Sleeper answers again.
 *   - Replies that arrive after you have switched drafts are discarded, so a
 *     slow response can never overwrite a newer attachment.
 *   - Re-syncs immediately when the tab returns to the foreground or the machine
 *     comes back online.
 *
 * The feed is tagged with its draft id and the "current" view is DERIVED during
 * render. That is what lets switching drafts reset the view without resetting
 * state from inside an effect.
 */
export function useLiveDraftSync(draftId: string | null): LiveDraftSync {
  const [feed, setFeed] = useState<Feed>(EMPTY_FEED);

  const timerRef = useRef<number | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const signatureRef = useRef<string | null>(null);
  const syncStateRef = useRef<SyncState>(INITIAL_SYNC_STATE);
  const lastStatusRef = useRef<SleeperDraft['status']>('pre_draft');
  /** Bumped on every attach so in-flight work from a previous draft is ignored. */
  const runIdRef = useRef(0);
  /** Lets `syncNow` and the resume listeners reach the current tick function. */
  const tickRef = useRef<(() => void) | null>(null);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  useEffect(() => {
    clearTimer();
    controllerRef.current?.abort();
    controllerRef.current = null;
    signatureRef.current = null;
    lastStatusRef.current = 'pre_draft';
    runIdRef.current += 1;

    if (!draftId) {
      syncStateRef.current = INITIAL_SYNC_STATE;
      tickRef.current = null;
      return;
    }

    syncStateRef.current = ATTACHED_SYNC;
    const runId = runIdRef.current;
    const isCurrent = () => runIdRef.current === runId;

    const schedule = (status: SleeperDraft['status']) => {
      if (!isCurrent()) return;
      const delay = nextSyncDelayMs({
        draftStatus: status,
        consecutiveFailures: syncStateRef.current.consecutiveFailures,
        hidden:
          typeof document !== 'undefined' && document.visibilityState === 'hidden',
      });
      // null means the draft is complete: stop polling on purpose.
      if (delay === null) return;
      timerRef.current = window.setTimeout(() => void tick(), delay);
    };

    const tick = async () => {
      if (!isCurrent()) return;
      clearTimer();

      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;

      try {
        const [draft, picks, tradedPicks] = await Promise.all([
          sleeperClient.getDraft(draftId, controller.signal),
          sleeperClient.getDraftPicks(draftId, controller.signal),
          sleeperClient.getDraftTradedPicks(draftId, controller.signal),
        ]);
        if (!isCurrent()) return;

        const at = Date.now();
        lastStatusRef.current = draft.status;

        const nextSync = reduceSyncState(syncStateRef.current, {
          type: 'success',
          at,
          draftStatus: draft.status,
        });
        syncStateRef.current = nextSync;

        const signature = draftSnapshotSignature(draft, picks);
        const changed = signature !== signatureRef.current;
        signatureRef.current = signature;

        setFeed((previous) => ({
          draftId,
          snapshot:
            changed || previous.draftId !== draftId
              ? { draft, picks, tradedPicks, fetchedAt: at }
              : previous.snapshot,
          sync: nextSync,
        }));

        schedule(draft.status);
      } catch (error) {
        // A superseded request is not a failure - it was cancelled on purpose.
        if (controller.signal.aborted || !isCurrent()) return;

        const nextSync = reduceSyncState(syncStateRef.current, {
          type: 'failure',
          at: Date.now(),
          error: describeSyncError(error),
        });
        syncStateRef.current = nextSync;

        // Keep the last good snapshot on screen while we retry.
        setFeed((previous) => ({
          draftId,
          snapshot: previous.draftId === draftId ? previous.snapshot : null,
          sync: nextSync,
        }));

        // Retry on the last known status, so a room that was live stays on the
        // fast cadence the moment the connection comes back.
        schedule(lastStatusRef.current);
      }
    };

    tickRef.current = () => void tick();
    void tick();

    return () => {
      clearTimer();
      controllerRef.current?.abort();
      controllerRef.current = null;
      tickRef.current = null;
    };
  }, [draftId, clearTimer]);

  const syncNow = useCallback(() => {
    tickRef.current?.();
  }, []);

  // Come back to life the moment the user (or the network) does.
  useEffect(() => {
    if (!draftId) return;

    const resume = () => {
      if (document.visibilityState === 'hidden') return;
      if (syncStateRef.current.phase === 'complete') return;
      tickRef.current?.();
    };

    document.addEventListener('visibilitychange', resume);
    window.addEventListener('online', resume);
    window.addEventListener('focus', resume);
    return () => {
      document.removeEventListener('visibilitychange', resume);
      window.removeEventListener('online', resume);
      window.removeEventListener('focus', resume);
    };
  }, [draftId]);

  // Derived, never stored: a draft switch shows an empty, freshly attached feed
  // straight away instead of briefly showing the previous draft's board.
  const current: Feed =
    feed.draftId === draftId
      ? feed
      : {
          draftId,
          snapshot: null,
          sync: draftId ? ATTACHED_SYNC : INITIAL_SYNC_STATE,
        };

  return { snapshot: current.snapshot, syncState: current.sync, syncNow };
}
