import { describe, expect, it } from 'vitest';
import {
  createDraftFollower,
  type FollowerUpdate,
} from '../../packages/sleeper/draft-follower';
import { SYNC_INTERVALS } from '../../packages/sleeper/live-sync';
import { buildDraftAttachment } from '../../packages/sleeper/attachment';
import { deriveDraftBoardState } from '../../packages/engine/draft/state';
import type { SleeperDraft, SleeperDraftPick } from '../../packages/sleeper/types';
import { makeDraft, makePlayerPool } from '../engine/fixtures';

/* ------------------------------------------------------------ test harness */

/** A controllable clock so a whole draft can be driven without real waiting. */
function createClock() {
  let now = 0;
  let nextId = 0;
  const tasks = new Map<number, { at: number; fn: () => void }>();

  return {
    now: () => now,
    setTimer: (fn: () => void, ms: number) => {
      const id = (nextId += 1);
      tasks.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimer: (id: number) => {
      tasks.delete(id);
    },
    pending: () => tasks.size,
    /** Runs the next scheduled task, returning the delay that elapsed. */
    async advance(): Promise<number | null> {
      const due = [...tasks.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) return null;
      const [id, task] = due;
      tasks.delete(id);
      const elapsed = task.at - now;
      now = task.at;
      task.fn();
      await flush();
      return elapsed;
    },
  };
}

/** Let every queued promise callback settle. */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}

function pick(pickNo: number, playerId: string, teams = 12): SleeperDraftPick {
  return {
    player_id: playerId,
    picked_by: 'user-1',
    roster_id: String(((pickNo - 1) % teams) + 1),
    round: Math.ceil(pickNo / teams),
    draft_slot: ((pickNo - 1) % teams) + 1,
    pick_no: pickNo,
    metadata: {},
  };
}

/**
 * A scripted stand-in for Sleeper. The test moves it through the draft and the
 * follower has to keep up, exactly as it would against the real API.
 */
function createFakeSleeper(initial: SleeperDraft) {
  let draft = initial;
  let picks: SleeperDraftPick[] = [];
  let failures = 0;
  let calls = 0;

  return {
    get calls() {
      return calls;
    },
    get picks() {
      return picks;
    },
    setStatus(status: SleeperDraft['status']) {
      draft = { ...draft, status };
    },
    makePick(playerId: string) {
      picks = [...picks, pick(picks.length + 1, playerId)];
    },
    /** The next `count` reads reject, as a dropped connection would. */
    failNext(count: number) {
      failures = count;
    },
    fetchSnapshot: async (_draftId: string, signal: AbortSignal) => {
      calls += 1;
      if (signal.aborted) throw new Error('aborted');
      if (failures > 0) {
        failures -= 1;
        throw new Error('Sleeper returned an error (503).');
      }
      return { draft, picks: [...picks], tradedPicks: [] };
    },
  };
}

function follow(
  sleeper: ReturnType<typeof createFakeSleeper>,
  clock: ReturnType<typeof createClock>,
  updates: FollowerUpdate[],
  options: { hidden?: boolean } = {},
) {
  return createDraftFollower(
    'draft-1',
    {
      fetchSnapshot: sleeper.fetchSnapshot,
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      // Pin the jitter so scheduled delays are exact.
      random: () => 0.5,
      isHidden: () => options.hidden ?? false,
    },
    (update) => updates.push(update),
  );
}

/* ------------------------------------------------------------------- tests */

describe('draft follower', () => {
  it('polls immediately on start', async () => {
    const sleeper = createFakeSleeper(makeDraft({ status: 'pre_draft' }));
    const clock = createClock();
    const updates: FollowerUpdate[] = [];
    const follower = follow(sleeper, clock, updates);

    follower.start();
    await flush();

    expect(sleeper.calls).toBe(1);
    expect(updates).toHaveLength(1);
    expect(updates[0].sync.phase).toBe('live');
    expect(updates[0].changed).toBe(true);
    follower.stop();
  });

  it('keeps watching a room that has not started, then catches it going live', async () => {
    // The old implementation polled only while status was already 'drafting',
    // so it could never observe this transition.
    const sleeper = createFakeSleeper(makeDraft({ status: 'pre_draft' }));
    const clock = createClock();
    const updates: FollowerUpdate[] = [];
    const follower = follow(sleeper, clock, updates);

    follower.start();
    await flush();
    expect(updates.at(-1)!.snapshot!.draft.status).toBe('pre_draft');

    // Pre-draft cadence.
    expect(await clock.advance()).toBe(SYNC_INTERVALS.preDraft);

    sleeper.setStatus('drafting');
    expect(await clock.advance()).toBe(SYNC_INTERVALS.preDraft);
    expect(updates.at(-1)!.snapshot!.draft.status).toBe('drafting');

    // Having seen it go live, it switches to the fast cadence on its own.
    expect(await clock.advance()).toBe(SYNC_INTERVALS.drafting);
    follower.stop();
  });

  it('follows a whole draft and stops once it completes', async () => {
    const sleeper = createFakeSleeper(makeDraft({ status: 'drafting' }));
    const clock = createClock();
    const updates: FollowerUpdate[] = [];
    const follower = follow(sleeper, clock, updates);

    follower.start();
    await flush();

    for (let i = 1; i <= 5; i += 1) {
      sleeper.makePick(String(i));
      await clock.advance();
    }

    const latest = updates.at(-1)!;
    expect(latest.snapshot!.picks).toHaveLength(5);
    expect(latest.sync.phase).toBe('live');

    sleeper.setStatus('complete');
    await clock.advance();

    expect(updates.at(-1)!.sync.phase).toBe('complete');
    // Nothing further is scheduled: a finished draft never changes again.
    expect(clock.pending()).toBe(0);
    follower.stop();
  });

  it('only reports a change when the board actually moved', async () => {
    const sleeper = createFakeSleeper(makeDraft({ status: 'drafting' }));
    const clock = createClock();
    const updates: FollowerUpdate[] = [];
    const follower = follow(sleeper, clock, updates);

    follower.start();
    await flush();
    expect(updates.at(-1)!.changed).toBe(true);

    // Three quiet polls with nobody picking.
    await clock.advance();
    await clock.advance();
    await clock.advance();
    expect(updates.slice(1).every((update) => update.changed === false)).toBe(true);

    // The snapshot object is reused, so React does not re-run the engine.
    expect(updates.at(-1)!.snapshot).toBe(updates[0].snapshot);

    sleeper.makePick('42');
    await clock.advance();
    expect(updates.at(-1)!.changed).toBe(true);
    expect(updates.at(-1)!.snapshot).not.toBe(updates[0].snapshot);
    follower.stop();
  });

  it('rides out a dropped connection without losing the board', async () => {
    const sleeper = createFakeSleeper(makeDraft({ status: 'drafting' }));
    const clock = createClock();
    const updates: FollowerUpdate[] = [];
    const follower = follow(sleeper, clock, updates);

    follower.start();
    await flush();
    sleeper.makePick('7');
    await clock.advance();

    const goodBoard = updates.at(-1)!.snapshot;
    expect(goodBoard!.picks).toHaveLength(1);

    sleeper.failNext(3);

    // Three polls in a row fail. The first waited the normal live cadence; the
    // next two waited a growing backoff.
    const waits: number[] = [];
    for (let i = 0; i < 3; i += 1) waits.push((await clock.advance())!);
    expect(waits).toEqual([SYNC_INTERVALS.drafting, 2_000, 4_000]);

    const duringOutage = updates.at(-1)!;
    expect(duringOutage.sync.phase).toBe('reconnecting');
    expect(duringOutage.sync.consecutiveFailures).toBe(3);
    // The last good board is still exactly what a user would be looking at.
    expect(duringOutage.snapshot).toBe(goodBoard);
    expect(duringOutage.sync.lastSyncedAt).not.toBeNull();
    expect(duringOutage.sync.lastError).toContain('503');

    // The connection returns and the draft resumes on the fast cadence.
    sleeper.makePick('8');
    expect(await clock.advance()).toBe(8_000);
    const recovered = updates.at(-1)!;
    expect(recovered.sync.phase).toBe('live');
    expect(recovered.sync.consecutiveFailures).toBe(0);
    expect(recovered.sync.lastError).toBeNull();
    expect(recovered.snapshot!.picks).toHaveLength(2);
    expect(await clock.advance()).toBe(SYNC_INTERVALS.drafting);
    follower.stop();
  });

  it('polls slower in a background tab', async () => {
    const sleeper = createFakeSleeper(makeDraft({ status: 'drafting' }));
    const clock = createClock();
    const updates: FollowerUpdate[] = [];
    const follower = follow(sleeper, clock, updates, { hidden: true });

    follower.start();
    await flush();
    expect(await clock.advance()).toBe(
      SYNC_INTERVALS.drafting * SYNC_INTERVALS.hiddenMultiplier,
    );
    follower.stop();
  });

  it('syncNow polls at once and replaces the scheduled poll', async () => {
    const sleeper = createFakeSleeper(makeDraft({ status: 'drafting' }));
    const clock = createClock();
    const updates: FollowerUpdate[] = [];
    const follower = follow(sleeper, clock, updates);

    follower.start();
    await flush();
    expect(clock.pending()).toBe(1);

    sleeper.makePick('9');
    follower.syncNow();
    await flush();

    expect(sleeper.calls).toBe(2);
    expect(updates.at(-1)!.snapshot!.picks).toHaveLength(1);
    // Exactly one poll is queued; syncNow did not leave a duplicate behind.
    expect(clock.pending()).toBe(1);
    follower.stop();
  });

  it('stops for good, leaving nothing scheduled', async () => {
    const sleeper = createFakeSleeper(makeDraft({ status: 'drafting' }));
    const clock = createClock();
    const updates: FollowerUpdate[] = [];
    const follower = follow(sleeper, clock, updates);

    follower.start();
    await flush();
    follower.stop();

    const callsAtStop = sleeper.calls;
    expect(clock.pending()).toBe(0);

    follower.syncNow();
    await flush();
    expect(sleeper.calls).toBe(callsAtStop);
  });

  it('ignores a reply that arrives after it was stopped', async () => {
    const draft = makeDraft({ status: 'drafting' });
    // Held in an object so TypeScript does not narrow it away across the closure.
    const gate: { release: (() => void) | null } = { release: null };
    const clock = createClock();
    const updates: FollowerUpdate[] = [];

    const follower = createDraftFollower(
      'draft-1',
      {
        fetchSnapshot: async () => {
          await new Promise<void>((resolve) => {
            gate.release = resolve;
          });
          return { draft, picks: [], tradedPicks: [] };
        },
        now: clock.now,
        setTimer: clock.setTimer,
        clearTimer: clock.clearTimer,
        random: () => 0.5,
      },
      (update) => updates.push(update),
    );

    follower.start();
    await flush();
    follower.stop();

    gate.release?.();
    await flush();

    // The in-flight poll resolved after stop() and was correctly discarded.
    expect(updates).toHaveLength(0);
  });
});

describe('drafted players leave the board as picks arrive', () => {
  it('removes each pick from the available pool on the very next sync', async () => {
    const players = makePlayerPool(20);
    const draft = makeDraft({ leagueId: null, status: 'drafting' });
    const attachment = buildDraftAttachment({ draft });

    const sleeper = createFakeSleeper(draft);
    const clock = createClock();
    const updates: FollowerUpdate[] = [];
    const follower = follow(sleeper, clock, updates);

    follower.start();
    await flush();

    const boardFor = (update: FollowerUpdate) =>
      deriveDraftBoardState(
        update.snapshot!.draft,
        update.snapshot!.picks,
        attachment.rosters,
        players,
      );

    const startingBoard = boardFor(updates.at(-1)!);
    const startingCount = startingBoard.availablePlayers.length;
    expect(startingCount).toBeGreaterThan(0);

    const takenIds = ['1', '2', '3', '4'];
    for (const [index, playerId] of takenIds.entries()) {
      sleeper.makePick(playerId);
      await clock.advance();

      const board = boardFor(updates.at(-1)!);
      const availableIds = new Set(
        board.availablePlayers.map((player) => player.externalIds.sleeper),
      );

      // The player just taken is gone immediately - no refresh step.
      expect(availableIds.has(playerId)).toBe(false);
      // ...and so is everyone taken before him.
      for (const earlier of takenIds.slice(0, index + 1)) {
        expect(availableIds.has(earlier)).toBe(false);
      }
      expect(board.availablePlayers).toHaveLength(startingCount - (index + 1));
      expect(board.picksMade).toBe(index + 1);
      expect(board.currentOverallPick).toBe(index + 2);
    }

    follower.stop();
  });
});
