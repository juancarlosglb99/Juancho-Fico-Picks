'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { SleeperApiError, sleeperClient } from '@/packages/sleeper/client';
import {
  createDraftFollower,
  type DraftFollower,
  type DraftSnapshot,
} from '@/packages/sleeper/draft-follower';
import { INITIAL_SYNC_STATE, type SyncState } from '@/packages/sleeper/live-sync';
import type { SleeperTradedPick } from '@/packages/sleeper/types';

/** How long a traded-pick reading stays good enough to reuse. */
const TRADED_PICK_REFRESH_MS = 20_000;

export type LiveDraftSnapshot = DraftSnapshot;

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
 * All of the sequencing lives in `createDraftFollower`, which is framework-free
 * and unit tested through a whole scripted draft. This hook only supplies the
 * browser's fetch, clock and timers, and mirrors the result into React state.
 *
 * The feed is tagged with its draft id and the "current" view is DERIVED during
 * render, so switching drafts clears the board without resetting state from
 * inside an effect.
 */
export function useLiveDraftSync(draftId: string | null): LiveDraftSync {
  const [feed, setFeed] = useState<Feed>(EMPTY_FEED);
  const followerRef = useRef<DraftFollower | null>(null);

  useEffect(() => {
    if (!draftId) {
      followerRef.current = null;
      return;
    }

    /*
     * Traded picks barely change, and asking for them every second is a third
     * of our request budget spent on an answer that is almost always identical.
     * A mock draft has none at all. Reading them occasionally leaves room to
     * poll the picks - the thing that actually moves - more often.
     */
    let tradedPicks: SleeperTradedPick[] = [];
    let tradedPicksReadAt = 0;

    const follower = createDraftFollower(
      draftId,
      {
        fetchSnapshot: async (id, signal) => {
          const stale = Date.now() - tradedPicksReadAt > TRADED_PICK_REFRESH_MS;
          const [draft, picks, freshTradedPicks] = await Promise.all([
            sleeperClient.getDraft(id, signal),
            sleeperClient.getDraftPicks(id, signal),
            stale ? sleeperClient.getDraftTradedPicks(id, signal) : Promise.resolve(null),
          ]);
          if (freshTradedPicks !== null) {
            tradedPicks = freshTradedPicks;
            tradedPicksReadAt = Date.now();
          }
          return { draft, picks, tradedPicks };
        },
        now: () => Date.now(),
        setTimer: (fn, ms) => window.setTimeout(fn, ms),
        clearTimer: (handle) => window.clearTimeout(handle),
        isHidden: () =>
          typeof document !== 'undefined' && document.visibilityState === 'hidden',
        describeError: describeSyncError,
      },
      (update) => {
        // Fired from a promise callback, never synchronously from this effect.
        setFeed({ draftId, snapshot: update.snapshot, sync: update.sync });
      },
    );

    followerRef.current = follower;
    follower.start();

    return () => {
      follower.stop();
      followerRef.current = null;
    };
  }, [draftId]);

  const syncNow = useCallback(() => {
    followerRef.current?.syncNow();
  }, []);

  // Come back to life the moment the user (or the network) does.
  useEffect(() => {
    if (!draftId) return;

    const resume = () => {
      if (document.visibilityState === 'hidden') return;
      if (followerRef.current?.getState().phase === 'complete') return;
      followerRef.current?.syncNow();
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
