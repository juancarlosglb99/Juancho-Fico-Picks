/**
 * The top bar. Two of these are about what it refuses to display.
 */
import { describe, expect, it } from 'vitest';
import { deriveDraftStatus, formatAge, formatClock } from '../../packages/ui/status';
import { INITIAL_SYNC_STATE, type SyncState } from '../../packages/sleeper/live-sync';
import type { SleeperDraft } from '../../packages/sleeper/types';
import { scenario } from './scenario';

const NOW = 1_700_000_000_000;

function status({
  draft,
  syncState = { ...INITIAL_SYNC_STATE, phase: 'live', lastSyncedAt: NOW - 4_000 },
  picksMade = 26,
  userId = 'user-3',
}: {
  draft?: Partial<SleeperDraft>;
  syncState?: SyncState;
  picksMade?: number;
  userId?: string;
} = {}) {
  const state = scenario({ picksMade, userId });
  return deriveDraftStatus({
    draft: { ...state.draft, ...draft },
    board: state.board,
    context: state.context,
    syncState,
    syncedAtMs: NOW - 4_000,
    leagueName: 'Fico’s League',
    isMock: false,
    now: NOW,
  });
}

describe('draft status bar', () => {
  it('carries the position in the draft and our own next turn', () => {
    const model = status();
    expect(model.overallPick).toBe(27);
    expect(model.round).toBe(3);
    expect(model.totalPicks).toBe(180);
    expect(model.picksMade).toBe(26);
    expect(model.ourDraftSlot).toBe(3);
    expect(model.ourNextPick).toBeGreaterThan(model.overallPick - 1);
  });

  it('says YOUR PICK, unmistakably, when we are on the clock', () => {
    // Slot 3 is on the clock at overall pick 3, so two picks in it is our turn.
    const model = status({ picksMade: 2 });
    expect(model.phase).toBe('your_pick');
    expect(model.headline).toBe('YOUR PICK');
    expect(model.picksUntilOurTurn).toBe(0);
  });

  it('never invents a countdown: it reports elapsed time and the allowance', () => {
    const model = status({
      draft: { last_picked: NOW - 12_000, settings: { teams: 12, rounds: 15, pick_timer: 30 } },
    });
    expect(model.onClockElapsedMs).toBe(12_000);
    expect(formatClock(model.onClockElapsedMs)).toBe('0:12');
    expect(model.pickTimerSeconds).toBe(30);
    // There is deliberately no "remaining" field to render.
    expect(Object.keys(model)).not.toContain('remainingMs');
  });

  it('reports no clock at all when Sleeper has published no pick', () => {
    const model = status({ draft: { last_picked: null } });
    expect(model.onClockElapsedMs).toBeNull();
    expect(formatClock(null)).toBe('—');
  });

  it('reports no allowance when the room has no pick timer', () => {
    const model = status({
      draft: { last_picked: NOW - 5_000, settings: { teams: 12, rounds: 15, pick_timer: 0 } },
    });
    expect(model.pickTimerSeconds).toBeNull();
  });

  it('ages the board from the last successful sync, not from the render', () => {
    const model = status({
      syncState: {
        ...INITIAL_SYNC_STATE,
        phase: 'reconnecting',
        lastSyncedAt: NOW - 45_000,
        consecutiveFailures: 3,
      },
    });
    expect(model.connection.tone).toBe('reconnecting');
    expect(model.connection.ageMs).toBe(45_000);
    expect(model.connection.detail).toContain('45s ago');
  });

  it('is watching, not live, before the room opens', () => {
    const model = status({ draft: { status: 'pre_draft' } });
    expect(model.phase).toBe('pre_draft');
    expect(model.connection.tone).toBe('idle');
  });

  it('is final, not live, once the draft is complete', () => {
    const model = status({ draft: { status: 'complete' } });
    expect(model.phase).toBe('complete');
    expect(model.connection.tone).toBe('ended');
    expect(model.headline).toBe('Draft complete');
  });

  it('formats an age the way a person would say it', () => {
    expect(formatAge(3_000)).toBe('3s ago');
    expect(formatAge(120_000)).toBe('2m ago');
    expect(formatAge(7_200_000)).toBe('2h ago');
    expect(formatAge(null)).toBe('unknown');
  });
});
