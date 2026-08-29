import { describe, expect, it } from 'vitest';
import {
  INITIAL_SYNC_STATE,
  SYNC_INTERVALS,
  draftSnapshotSignature,
  newPicksSince,
  nextSyncDelayMs,
  reduceSyncState,
  staleForMs,
  type SyncState,
} from '../../packages/sleeper/live-sync';
import type { SleeperDraftPick } from '../../packages/sleeper/types';

/** Pin the jitter to the midpoint so delays are exact in tests. */
const noJitter = () => 0.5;

function pick(pickNo: number, playerId: string): SleeperDraftPick {
  return {
    player_id: playerId,
    picked_by: 'user-1',
    roster_id: '1',
    round: Math.ceil(pickNo / 12),
    draft_slot: ((pickNo - 1) % 12) + 1,
    pick_no: pickNo,
    metadata: {},
  };
}

describe('nextSyncDelayMs', () => {
  it('polls fast while a draft is live', () => {
    const delay = nextSyncDelayMs(
      { draftStatus: 'drafting', consecutiveFailures: 0, hidden: false },
      noJitter,
    );
    expect(delay).toBe(SYNC_INTERVALS.drafting);
  });

  it('keeps watching a draft that has not started yet', () => {
    // This is the whole point: polling only when status === 'drafting' would
    // never notice the room going live.
    const delay = nextSyncDelayMs(
      { draftStatus: 'pre_draft', consecutiveFailures: 0, hidden: false },
      noJitter,
    );
    expect(delay).toBe(SYNC_INTERVALS.preDraft);
  });

  it('keeps watching a paused room', () => {
    const delay = nextSyncDelayMs(
      { draftStatus: 'paused', consecutiveFailures: 0, hidden: false },
      noJitter,
    );
    expect(delay).toBe(SYNC_INTERVALS.paused);
  });

  it('stops entirely once the draft is complete', () => {
    expect(
      nextSyncDelayMs(
        { draftStatus: 'complete', consecutiveFailures: 0, hidden: false },
        noJitter,
      ),
    ).toBeNull();
  });

  it('stops a completed draft even if requests were failing', () => {
    expect(
      nextSyncDelayMs(
        { draftStatus: 'complete', consecutiveFailures: 5, hidden: false },
        noJitter,
      ),
    ).toBeNull();
  });

  it('slows down in a background tab', () => {
    const delay = nextSyncDelayMs(
      { draftStatus: 'drafting', consecutiveFailures: 0, hidden: true },
      noJitter,
    );
    expect(delay).toBe(SYNC_INTERVALS.drafting * SYNC_INTERVALS.hiddenMultiplier);
  });

  it('backs off exponentially while failing', () => {
    const delays = [1, 2, 3, 4].map((failures) =>
      nextSyncDelayMs(
        { draftStatus: 'drafting', consecutiveFailures: failures, hidden: false },
        noJitter,
      ),
    );
    expect(delays).toEqual([2_000, 4_000, 8_000, 16_000]);
  });

  it('caps the backoff so recovery is never far away', () => {
    const delay = nextSyncDelayMs(
      { draftStatus: 'drafting', consecutiveFailures: 20, hidden: false },
      noJitter,
    );
    expect(delay).toBe(SYNC_INTERVALS.backoffMax);
  });

  it('spreads polls with jitter so tabs do not retry in lockstep', () => {
    const low = nextSyncDelayMs(
      { draftStatus: 'drafting', consecutiveFailures: 0, hidden: false },
      () => 0,
    )!;
    const high = nextSyncDelayMs(
      { draftStatus: 'drafting', consecutiveFailures: 0, hidden: false },
      () => 1,
    )!;
    expect(low).toBeLessThan(SYNC_INTERVALS.drafting);
    expect(high).toBeGreaterThan(SYNC_INTERVALS.drafting);
    // Jitter must stay small enough that live polling is still responsive.
    expect(high - low).toBeLessThanOrEqual(SYNC_INTERVALS.drafting * 0.31);
  });

  it('never returns a negative delay', () => {
    for (const status of ['pre_draft', 'drafting', 'paused'] as const) {
      for (const failures of [0, 1, 9]) {
        const delay = nextSyncDelayMs(
          { draftStatus: status, consecutiveFailures: failures, hidden: false },
          () => 0,
        );
        expect(delay).toBeGreaterThan(0);
      }
    }
  });
});

describe('reduceSyncState', () => {
  it('starts idle', () => {
    expect(INITIAL_SYNC_STATE.phase).toBe('idle');
  });

  it('goes live on attach', () => {
    expect(reduceSyncState(INITIAL_SYNC_STATE, { type: 'attach' }).phase).toBe('live');
  });

  it('records a successful sync', () => {
    const state = reduceSyncState(
      reduceSyncState(INITIAL_SYNC_STATE, { type: 'attach' }),
      { type: 'success', at: 1_000, draftStatus: 'drafting' },
    );
    expect(state).toMatchObject({
      phase: 'live',
      lastSyncedAt: 1_000,
      consecutiveFailures: 0,
      lastError: null,
      successCount: 1,
    });
  });

  it('marks the draft complete when Sleeper says so', () => {
    const state = reduceSyncState(INITIAL_SYNC_STATE, {
      type: 'success',
      at: 5,
      draftStatus: 'complete',
    });
    expect(state.phase).toBe('complete');
  });

  it('moves to reconnecting on failure without losing the last good sync', () => {
    const healthy = reduceSyncState(INITIAL_SYNC_STATE, {
      type: 'success',
      at: 1_000,
      draftStatus: 'drafting',
    });
    const failed = reduceSyncState(healthy, {
      type: 'failure',
      at: 2_000,
      error: 'network down',
    });

    expect(failed.phase).toBe('reconnecting');
    expect(failed.consecutiveFailures).toBe(1);
    expect(failed.lastError).toBe('network down');
    // The board stays on screen because the last good sync is remembered.
    expect(failed.lastSyncedAt).toBe(1_000);
  });

  it('counts consecutive failures', () => {
    let state: SyncState = reduceSyncState(INITIAL_SYNC_STATE, { type: 'attach' });
    for (let i = 0; i < 3; i += 1) {
      state = reduceSyncState(state, { type: 'failure', at: i, error: 'boom' });
    }
    expect(state.consecutiveFailures).toBe(3);
  });

  it('recovers cleanly after a run of failures', () => {
    let state: SyncState = reduceSyncState(INITIAL_SYNC_STATE, { type: 'attach' });
    state = reduceSyncState(state, { type: 'failure', at: 1, error: 'boom' });
    state = reduceSyncState(state, { type: 'failure', at: 2, error: 'boom' });
    state = reduceSyncState(state, { type: 'success', at: 3, draftStatus: 'drafting' });

    expect(state.phase).toBe('live');
    expect(state.consecutiveFailures).toBe(0);
    expect(state.lastError).toBeNull();
  });

  it('resets completely on detach', () => {
    const busy = reduceSyncState(INITIAL_SYNC_STATE, {
      type: 'success',
      at: 10,
      draftStatus: 'drafting',
    });
    expect(reduceSyncState(busy, { type: 'detach' })).toEqual(INITIAL_SYNC_STATE);
  });

  it('clears stale counters when attaching to a different draft', () => {
    const failing = reduceSyncState(INITIAL_SYNC_STATE, {
      type: 'failure',
      at: 1,
      error: 'boom',
    });
    const reattached = reduceSyncState(failing, { type: 'attach' });
    expect(reattached.consecutiveFailures).toBe(0);
    expect(reattached.lastError).toBeNull();
    expect(reattached.lastSyncedAt).toBeNull();
  });
});

describe('staleForMs', () => {
  it('is null before the first sync', () => {
    expect(staleForMs(INITIAL_SYNC_STATE, 5_000)).toBeNull();
  });

  it('measures the gap since the last good sync', () => {
    const state = reduceSyncState(INITIAL_SYNC_STATE, {
      type: 'success',
      at: 1_000,
      draftStatus: 'drafting',
    });
    expect(staleForMs(state, 4_000)).toBe(3_000);
  });
});

describe('draftSnapshotSignature', () => {
  const draft = { draft_id: 'd1', status: 'drafting' as const };

  it('is stable when nothing changed', () => {
    const picks = [pick(1, 'a'), pick(2, 'b')];
    expect(draftSnapshotSignature(draft, picks)).toBe(
      draftSnapshotSignature(draft, [...picks]),
    );
  });

  it('changes when a pick is made', () => {
    const before = draftSnapshotSignature(draft, [pick(1, 'a')]);
    const after = draftSnapshotSignature(draft, [pick(1, 'a'), pick(2, 'b')]);
    expect(after).not.toBe(before);
  });

  it('changes when the draft status changes', () => {
    const before = draftSnapshotSignature({ ...draft, status: 'pre_draft' }, []);
    const after = draftSnapshotSignature(draft, []);
    expect(after).not.toBe(before);
  });

  it('does not depend on the order Sleeper returns picks in', () => {
    const ordered = draftSnapshotSignature(draft, [pick(1, 'a'), pick(2, 'b')]);
    const shuffled = draftSnapshotSignature(draft, [pick(2, 'b'), pick(1, 'a')]);
    expect(shuffled).toBe(ordered);
  });
});

describe('newPicksSince', () => {
  it('returns only the picks that arrived, in draft order', () => {
    const before = [pick(1, 'a')];
    const after = [pick(1, 'a'), pick(3, 'c'), pick(2, 'b')];
    expect(newPicksSince(before, after).map((entry) => entry.pick_no)).toEqual([2, 3]);
  });

  it('returns nothing when the board has not moved', () => {
    const picks = [pick(1, 'a'), pick(2, 'b')];
    expect(newPicksSince(picks, picks)).toEqual([]);
  });

  it('treats a first sync as all-new', () => {
    expect(newPicksSince([], [pick(1, 'a')])).toHaveLength(1);
  });
});
