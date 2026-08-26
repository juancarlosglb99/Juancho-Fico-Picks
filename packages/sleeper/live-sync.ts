/**
 * Live draft synchronization policy.
 *
 * This file holds the DECISIONS - how often to poll, when to back off, when to
 * stop, and whether anything actually changed. It performs no I/O at all, so
 * every rule below is unit testable without a network or a browser.
 *
 * Why a policy module instead of a bare `setInterval`:
 *   - A draft that has not started yet still has to be watched, or the moment it
 *     goes live is missed. Polling only while `status === 'drafting'` never sees
 *     the transition into `drafting`.
 *   - Sleeper occasionally drops a request. A single failure must not surface as
 *     an error banner or throw away the last good board - it should retry.
 *   - Hammering a public API every few seconds from a hidden tab is rude and
 *     gets an app rate limited.
 */
import type { SleeperDraft, SleeperDraftPick } from './types';

/* ------------------------------------------------------------------ cadence */

export const SYNC_INTERVALS = {
  /** Picks land fast once a room is live; this is the responsiveness budget. */
  drafting: 2_500,
  /** Before the first pick, we only need to notice the room going live. */
  preDraft: 10_000,
  /** A paused room can resume at any moment, so keep a moderate watch. */
  paused: 8_000,
  /** Backoff after the first failure, doubling each time. */
  backoffBase: 2_000,
  /** Backoff never grows past this, so recovery is never more than a rest away. */
  backoffMax: 30_000,
  /** Hidden tabs poll this many times slower. */
  hiddenMultiplier: 4,
  /** Jitter spread applied to steady-state polling, as a fraction. */
  jitterRatio: 0.15,
} as const;

export interface SyncDelayInput {
  draftStatus: SleeperDraft['status'];
  /** How many attempts in a row have failed. 0 when healthy. */
  consecutiveFailures: number;
  /** True when the browser tab is in the background. */
  hidden: boolean;
}

/**
 * How long to wait before the next poll, or `null` to stop polling entirely.
 *
 * `random` is injectable so tests can pin the jitter.
 */
export function nextSyncDelayMs(
  input: SyncDelayInput,
  random: () => number = Math.random,
): number | null {
  // A finished draft never changes again.
  if (input.draftStatus === 'complete') return null;

  if (input.consecutiveFailures > 0) {
    // Exponential backoff. Jitter here too, so several tabs do not retry in lockstep.
    const raw =
      SYNC_INTERVALS.backoffBase * 2 ** (input.consecutiveFailures - 1);
    const capped = Math.min(raw, SYNC_INTERVALS.backoffMax);
    return Math.round(applyJitter(capped, random));
  }

  const base =
    input.draftStatus === 'drafting'
      ? SYNC_INTERVALS.drafting
      : input.draftStatus === 'paused'
        ? SYNC_INTERVALS.paused
        : SYNC_INTERVALS.preDraft;

  const scaled = input.hidden ? base * SYNC_INTERVALS.hiddenMultiplier : base;
  return Math.round(applyJitter(scaled, random));
}

function applyJitter(value: number, random: () => number): number {
  const spread = value * SYNC_INTERVALS.jitterRatio;
  // random() in [0,1) maps to [-spread, +spread).
  return value + (random() * 2 - 1) * spread;
}

/* -------------------------------------------------------------- state machine */

export type SyncPhase =
  /** Not attached to anything. */
  | 'idle'
  /** Attached, healthy, watching for picks. */
  | 'live'
  /** A request failed; retrying with backoff. The last good board is still shown. */
  | 'reconnecting'
  /** The draft is finished; polling has stopped on purpose. */
  | 'complete';

export interface SyncState {
  phase: SyncPhase;
  consecutiveFailures: number;
  /** Epoch ms of the last SUCCESSFUL sync. */
  lastSyncedAt: number | null;
  /** Message from the most recent failure, cleared on the next success. */
  lastError: string | null;
  /** Total successful syncs, useful for tests and diagnostics. */
  successCount: number;
}

export const INITIAL_SYNC_STATE: SyncState = {
  phase: 'idle',
  consecutiveFailures: 0,
  lastSyncedAt: null,
  lastError: null,
  successCount: 0,
};

export type SyncEvent =
  | { type: 'attach' }
  | { type: 'detach' }
  | { type: 'success'; at: number; draftStatus: SleeperDraft['status'] }
  | { type: 'failure'; at: number; error: string };

/**
 * The sync lifecycle as a pure reducer.
 *
 * The important property: a `failure` NEVER clears `lastSyncedAt` and never
 * moves the phase back to `idle`. A dropped request degrades the status pill to
 * "reconnecting" and leaves the last known board on screen.
 */
export function reduceSyncState(state: SyncState, event: SyncEvent): SyncState {
  switch (event.type) {
    case 'attach':
      return { ...INITIAL_SYNC_STATE, phase: 'live' };

    case 'detach':
      return INITIAL_SYNC_STATE;

    case 'success':
      return {
        phase: event.draftStatus === 'complete' ? 'complete' : 'live',
        consecutiveFailures: 0,
        lastSyncedAt: event.at,
        lastError: null,
        successCount: state.successCount + 1,
      };

    case 'failure':
      return {
        ...state,
        phase: 'reconnecting',
        consecutiveFailures: state.consecutiveFailures + 1,
        lastError: event.error,
      };

    default:
      return state;
  }
}

/** How long we have been unable to reach Sleeper, in ms. */
export function staleForMs(state: SyncState, now: number): number | null {
  if (state.lastSyncedAt === null) return null;
  return Math.max(0, now - state.lastSyncedAt);
}

/* ------------------------------------------------------------ change detection */

/**
 * A cheap fingerprint of a draft snapshot.
 *
 * The recommendation engine is expensive, so we only push new state into React
 * when this string changes. It covers everything that can move: the pick count,
 * the most recent selection, and the draft's own status.
 */
export function draftSnapshotSignature(
  draft: Pick<SleeperDraft, 'status' | 'draft_id'>,
  picks: SleeperDraftPick[],
): string {
  let latestPickNo = 0;
  let latestPlayerId = '';
  for (const pick of picks) {
    if (pick.pick_no >= latestPickNo) {
      latestPickNo = pick.pick_no;
      latestPlayerId = pick.player_id;
    }
  }
  return [
    draft.draft_id,
    draft.status,
    picks.length,
    latestPickNo,
    latestPlayerId,
  ].join('|');
}

/** The picks present in `next` that were not in `previous`, newest last. */
export function newPicksSince(
  previous: SleeperDraftPick[],
  next: SleeperDraftPick[],
): SleeperDraftPick[] {
  const seen = new Set(previous.map((pick) => pick.pick_no));
  return next
    .filter((pick) => !seen.has(pick.pick_no))
    .sort((a, b) => a.pick_no - b.pick_no);
}
