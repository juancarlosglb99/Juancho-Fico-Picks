/**
 * The live draft loop itself, with every dependency injected.
 *
 * This is deliberately framework-free: no React, no `window`, no global timers,
 * no direct network. The React hook in `app/use-live-draft-sync.ts` is a thin
 * wrapper that supplies the real fetch, clock and timers.
 *
 * Keeping the loop here means the actual sequencing - first poll, cadence,
 * backoff, cancellation, change detection, stopping on a completed draft - can
 * be driven through a whole scripted draft in a unit test, rather than only
 * being exercised against the live Sleeper API.
 */
import {
  INITIAL_SYNC_STATE,
  draftSnapshotSignature,
  nextSyncDelayMs,
  reduceSyncState,
  type SyncState,
} from './live-sync';
import type {
  SleeperDraft,
  SleeperDraftPick,
  SleeperTradedPick,
} from './types';

export interface DraftSnapshot {
  draft: SleeperDraft;
  picks: SleeperDraftPick[];
  tradedPicks: SleeperTradedPick[];
  /** Epoch ms this snapshot was received. */
  fetchedAt: number;
}

export type FetchedDraft = Omit<DraftSnapshot, 'fetchedAt'>;

export interface DraftFollowerDeps {
  /** Reads the draft, its picks and its traded picks in one go. */
  fetchSnapshot: (draftId: string, signal: AbortSignal) => Promise<FetchedDraft>;
  now: () => number;
  setTimer: (fn: () => void, ms: number) => number;
  clearTimer: (handle: number) => void;
  /** Injectable for tests; defaults to Math.random for jitter. */
  random?: () => number;
  /** True when the tab is in the background, which slows the cadence. */
  isHidden?: () => boolean;
  /** Turns a thrown value into a message for the status pill. */
  describeError?: (error: unknown) => string;
}

export interface FollowerUpdate {
  /** The newest board, or the last good one while reconnecting. */
  snapshot: DraftSnapshot | null;
  sync: SyncState;
  /** True when this update carries a board that differs from the previous one. */
  changed: boolean;
}

export interface DraftFollower {
  /** Begins following. The first poll happens immediately. */
  start: () => void;
  /** Polls right now, cancelling any scheduled or in-flight poll. */
  syncNow: () => void;
  /** Stops for good. Safe to call more than once. */
  stop: () => void;
  /** Current sync state, for callers that need it outside an update. */
  getState: () => SyncState;
}

const ATTACHED: SyncState = { ...INITIAL_SYNC_STATE, phase: 'live' };

function defaultDescribeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return 'Could not reach Sleeper.';
}

export function createDraftFollower(
  draftId: string,
  deps: DraftFollowerDeps,
  onUpdate: (update: FollowerUpdate) => void,
): DraftFollower {
  let timer: number | null = null;
  let controller: AbortController | null = null;
  let signature: string | null = null;
  let sync: SyncState = ATTACHED;
  let lastStatus: SleeperDraft['status'] = 'pre_draft';
  let snapshot: DraftSnapshot | null = null;
  let stopped = false;

  const describeError = deps.describeError ?? defaultDescribeError;

  const clearPending = () => {
    if (timer !== null) {
      deps.clearTimer(timer);
      timer = null;
    }
  };

  const schedule = (status: SleeperDraft['status']) => {
    if (stopped) return;
    const delay = nextSyncDelayMs(
      {
        draftStatus: status,
        consecutiveFailures: sync.consecutiveFailures,
        hidden: deps.isHidden?.() ?? false,
      },
      deps.random,
    );
    // null means the draft is complete: stop polling on purpose.
    if (delay === null) return;
    timer = deps.setTimer(() => void tick(), delay);
  };

  const tick = async (): Promise<void> => {
    if (stopped) return;
    clearPending();

    // Cancel any poll still in flight so a slow reply cannot land out of order.
    controller?.abort();
    const local = new AbortController();
    controller = local;

    try {
      const result = await deps.fetchSnapshot(draftId, local.signal);
      if (stopped || local.signal.aborted) return;

      const at = deps.now();
      lastStatus = result.draft.status;
      sync = reduceSyncState(sync, {
        type: 'success',
        at,
        draftStatus: result.draft.status,
      });

      const nextSignature = draftSnapshotSignature(result.draft, result.picks);
      const changed = nextSignature !== signature;
      signature = nextSignature;
      if (changed) snapshot = { ...result, fetchedAt: at };

      onUpdate({ snapshot, sync, changed });
      schedule(result.draft.status);
    } catch (error) {
      // A superseded poll is not a failure - it was cancelled on purpose.
      if (stopped || local.signal.aborted) return;

      sync = reduceSyncState(sync, {
        type: 'failure',
        at: deps.now(),
        error: describeError(error),
      });

      // The last good board stays exactly where it is.
      onUpdate({ snapshot, sync, changed: false });

      // Retry on the last known status, so a room that was live stays on the
      // fast cadence the moment the connection comes back.
      schedule(lastStatus);
    }
  };

  return {
    start() {
      if (stopped) return;
      void tick();
    },
    syncNow() {
      if (stopped) return;
      void tick();
    },
    stop() {
      stopped = true;
      clearPending();
      controller?.abort();
      controller = null;
    },
    getState: () => sync,
  };
}
