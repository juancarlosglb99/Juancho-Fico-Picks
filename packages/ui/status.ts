/**
 * What the top of the draft room says, worked out away from the markup.
 *
 * The status bar is the one part of the screen a drafter looks at without
 * meaning to, so everything on it has to be true. Two things in particular:
 *
 * A CLOCK IS NOT INVENTED. Sleeper publishes `pick_timer` (how long a team is
 * allowed) and `last_picked` (when the previous selection landed). It does not
 * publish a deadline, and a room can be paused, resumed, or autopicked without
 * either field moving. So this reports elapsed time since the last pick, which
 * is measured, and the configured timer alongside it - never a countdown, which
 * would be a guess rendered as a fact.
 *
 * FRESHNESS IS THE SYNC, NOT THE RENDER. "Live" means Sleeper answered us
 * recently, so the age reported is the age of the last successful sync rather
 * than the moment this component happened to re-render.
 */
import type { LeagueContext } from '../engine/context/types';
import type { DraftBoardState } from '../engine/draft/types';
import type { SyncState } from '../sleeper/live-sync';
import type { SleeperDraft } from '../sleeper/types';

export type DraftPhase =
  | 'pre_draft'
  | 'your_pick'
  | 'live'
  | 'paused'
  | 'complete';

export type ConnectionTone = 'live' | 'reconnecting' | 'idle' | 'ended';

export interface DraftStatusModel {
  leagueName: string;
  draftName: string;
  isMock: boolean;
  phase: DraftPhase;
  /** The single word the bar leads with. */
  headline: string;
  round: number;
  totalRounds: number;
  pickInRound: number;
  overallPick: number;
  totalPicks: number;
  picksMade: number;
  ourNextPick: number | null;
  /** Zero means we are on the clock right now. */
  picksUntilOurTurn: number | null;
  ourDraftSlot: number | null;
  connection: {
    tone: ConnectionTone;
    label: string;
    /** Milliseconds since the last SUCCESSFUL Sleeper sync, not since render. */
    ageMs: number | null;
    detail: string;
  };
  /**
   * How long the current selection has been on the clock.
   *
   * Elapsed, never remaining. Null before the first pick of a draft, since
   * there is no previous selection to measure from.
   */
  onClockElapsedMs: number | null;
  /** Sleeper's configured allowance in seconds, or null when there is none. */
  pickTimerSeconds: number | null;
}

export function formatClock(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return '—';
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/** "12s ago", "4m ago" - short enough to sit in a bar without wrapping. */
export function formatAge(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return 'unknown';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.round(minutes / 60)}h ago`;
}

export function deriveDraftStatus({
  draft,
  board,
  context,
  syncState,
  syncedAtMs,
  leagueName,
  isMock,
  now,
}: {
  draft: SleeperDraft;
  board: DraftBoardState;
  context: LeagueContext;
  syncState: SyncState;
  /** Epoch ms of the snapshot on screen. */
  syncedAtMs: number;
  leagueName: string;
  isMock: boolean;
  now: number;
}): DraftStatusModel {
  const state = context.draftState.value;
  const onClock = state.isUserOnClock && draft.status === 'drafting';

  const phase: DraftPhase =
    draft.status === 'complete'
      ? 'complete'
      : draft.status === 'pre_draft'
        ? 'pre_draft'
        : draft.status === 'paused'
          ? 'paused'
          : onClock
            ? 'your_pick'
            : 'live';

  const headline =
    phase === 'your_pick'
      ? 'YOUR PICK'
      : phase === 'complete'
        ? 'Draft complete'
        : phase === 'pre_draft'
          ? 'Waiting to start'
          : phase === 'paused'
            ? 'Draft paused'
            : 'Live draft';

  /*
   * Freshness is measured from the last successful sync when we have one. A
   * reconnecting feed keeps the last good board on screen, and the honest thing
   * to report then is how old that board is - not the moment it was drawn.
   */
  const lastGoodAt = syncState.lastSyncedAt ?? syncedAtMs;
  const ageMs = Number.isFinite(lastGoodAt) ? Math.max(0, now - lastGoodAt) : null;

  const connection = describeConnection(draft.status, syncState, ageMs);

  const pickTimer = draft.settings.pick_timer;
  const pickTimerSeconds = typeof pickTimer === 'number' && pickTimer > 0 ? pickTimer : null;
  const onClockElapsedMs =
    draft.status === 'drafting' && typeof draft.last_picked === 'number' && draft.last_picked > 0
      ? Math.max(0, now - draft.last_picked)
      : null;

  return {
    leagueName,
    draftName: draft.metadata.name?.trim() || (isMock ? 'Mock draft' : 'League draft'),
    isMock,
    phase,
    headline,
    round: board.currentRound,
    totalRounds: board.rounds,
    pickInRound: board.pickInRound,
    overallPick: board.currentOverallPick,
    totalPicks: board.teams * board.rounds,
    picksMade: board.picksMade,
    ourNextPick: state.nextUserPick,
    picksUntilOurTurn: onClock ? 0 : state.picksBeforeNextSelection,
    ourDraftSlot: state.userDraftSlot,
    connection,
    onClockElapsedMs,
    pickTimerSeconds,
  };
}

function describeConnection(
  status: SleeperDraft['status'],
  syncState: SyncState,
  ageMs: number | null,
): DraftStatusModel['connection'] {
  if (status === 'complete') {
    return { tone: 'ended', label: 'Final', ageMs, detail: 'Every selection is in.' };
  }
  if (syncState.phase === 'reconnecting') {
    return {
      tone: 'reconnecting',
      label: 'Reconnecting',
      ageMs,
      detail:
        syncState.lastSyncedAt === null
          ? 'Retrying Sleeper.'
          : `Showing the board from ${formatAge(ageMs)}.`,
    };
  }
  if (status === 'pre_draft') {
    return {
      tone: 'idle',
      label: 'Watching',
      ageMs,
      detail: 'Picks appear the moment the room opens.',
    };
  }
  return { tone: 'live', label: 'LIVE', ageMs, detail: `Synced ${formatAge(ageMs)}` };
}
