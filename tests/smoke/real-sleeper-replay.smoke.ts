/**
 * Replays a REAL Sleeper draft, pick by pick, through the real live loop.
 *
 * The other smoke tests prove two separate things: that we can attach to a real
 * draft, and that a real draft state produces recommendations. Neither proves
 * the thing that actually matters during a draft:
 *
 *     every time somebody picks, the board and the recommendations move.
 *
 * That has only ever been covered with synthetic fixtures. This test closes the
 * gap. It pulls a genuine completed Sleeper draft, replays its picks one at a
 * time through `createDraftFollower` - the same loop the browser runs - and
 * regenerates recommendations after every single pick using real First Seed
 * projections, real Sleeper room ranks and real market ADP.
 *
 *     npm run test:smoke
 *
 * Point it at any other draft (a finished mock is ideal) with:
 *
 *     SLEEPER_REPLAY_DRAFT_ID="https://sleeper.com/draft/nfl/123..." npm run test:smoke
 *
 * By default it replays the first 4 rounds, which is where the recommendation
 * engine does its most consequential work. Replay the whole thing with:
 *
 *     SLEEPER_REPLAY_ROUNDS=all npm run test:smoke
 */
import { describe, expect, it } from 'vitest';
import { FantasyFootballCalculatorAdpProvider } from '../../packages/adp/providers/fantasy-football-calculator';
import { mapAdpSnapshot, planAutomaticAdp } from '../../packages/adp/automatic';
import { composeProjectionAndAdp } from '../../packages/data/projections';
import { normalizeLeagueContext } from '../../packages/engine/context/normalize';
import { generateDraftRecommendations } from '../../packages/engine/draft/recommendations';
import { deriveDraftBoardState } from '../../packages/engine/draft/state';
import { planAutomaticFirstSeed } from '../../packages/first-seed/automatic';
import {
  FirstSeedDraftRoomRankingProvider,
  FirstSeedProjectionProvider,
} from '../../packages/first-seed/providers';
import {
  mapFirstSeedDraftRoomRankingSnapshot,
  mapFirstSeedProjectionSnapshot,
} from '../../packages/first-seed/mapping';
import { buildCanonicalPlayerMap } from '../../packages/players/player-map';
import { buildDraftAttachment } from '../../packages/sleeper/attachment';
import { sleeperClient } from '../../packages/sleeper/client';
import { createDraftFollower, type FollowerUpdate } from '../../packages/sleeper/draft-follower';
import { extractSleeperDraftId } from '../../packages/sleeper/draft-ref';
import type { SleeperDraft, SleeperDraftPick } from '../../packages/sleeper/types';

/** A public, completed 16-team PPR league draft: 240 real picks. */
const FALLBACK_LEAGUE_ID = '1388280410047275008';
const RAW_TARGET = process.env.SLEEPER_REPLAY_DRAFT_ID?.trim();
const RAW_ROUNDS = process.env.SLEEPER_REPLAY_ROUNDS?.trim();

/* ------------------------------------------------------------ test harness */

/** A controllable clock, so a whole draft replays without any real waiting. */
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

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}

/**
 * Stands in for Sleeper while replaying a real draft.
 *
 * It holds the real pick list and reveals it one selection at a time, so the
 * follower sees exactly what it would see against a live room.
 */
function createReplayFeed(draft: SleeperDraft, allPicks: SleeperDraftPick[]) {
  let revealed = 0;
  let status: SleeperDraft['status'] = 'drafting';
  let calls = 0;

  return {
    get calls() {
      return calls;
    },
    get revealed() {
      return revealed;
    },
    revealNextPick() {
      if (revealed < allPicks.length) revealed += 1;
      return allPicks[revealed - 1];
    },
    finish() {
      status = 'complete';
    },
    fetchSnapshot: async (_draftId: string, signal: AbortSignal) => {
      calls += 1;
      if (signal.aborted) throw new Error('aborted');
      return {
        draft: { ...draft, status },
        picks: allPicks.slice(0, revealed),
        tradedPicks: [] as never[],
      };
    },
  };
}

async function resolveDraftId(): Promise<string> {
  if (RAW_TARGET) {
    const draftId = extractSleeperDraftId(RAW_TARGET);
    if (!draftId) {
      throw new Error(`SLEEPER_REPLAY_DRAFT_ID="${RAW_TARGET}" is not a Sleeper draft link or ID.`);
    }
    return draftId;
  }
  const drafts = await sleeperClient.getLeagueDrafts(FALLBACK_LEAGUE_ID);
  const draft = drafts[0];
  if (!draft) throw new Error('Fallback league exposed no drafts.');
  return draft.draft_id;
}

/** Statuses that still carry actionable recommendations. */
const USABLE = ['ready', 'limited'] as const;

/* ------------------------------------------------------------------- test */

describe('a real Sleeper draft replayed pick by pick', () => {
  it('re-derives the board and the recommendations after every single pick', async () => {
    const draftId = await resolveDraftId();

    /* ---------------------------------------------- load the real draft */
    const [draft, allPicks, rawPlayers] = await Promise.all([
      sleeperClient.getDraft(draftId),
      sleeperClient.getDraftPicks(draftId),
      sleeperClient.getActivePlayers(),
    ]);

    const league =
      draft.league_id !== null ? await sleeperClient.getLeague(draft.league_id) : null;
    const liveRosters =
      draft.league_id !== null ? await sleeperClient.getRosters(draft.league_id) : null;

    /**
     * Rewind the rosters to their pre-draft state.
     *
     * `deriveDraftBoardState` treats anybody already sitting on a league roster
     * as unavailable, which is exactly right in production: when a real draft
     * starts, the rosters are empty. But this draft has already FINISHED, so its
     * rosters hold all 240 drafted players. Replaying against them would hide
     * every player who was ever picked and leave the engine choosing among the
     * leftovers. Clearing them puts the room back on the clock at pick 1.
     */
    const rosters = liveRosters?.map((roster) => ({ ...roster, players: [] })) ?? null;

    const players = buildCanonicalPlayerMap(rawPlayers);
    const attachment = buildDraftAttachment({ draft, league, rosters });

    // Replay in true draft order, whatever order Sleeper returned them in.
    const ordered = [...allPicks].sort((a, b) => a.pick_no - b.pick_no);
    expect(ordered.length).toBeGreaterThan(0);

    const teams = draft.settings.teams ?? attachment.rosters.length;
    const replayCount =
      RAW_ROUNDS === 'all' ? ordered.length : Math.min(ordered.length, teams * 4);

    /* ------------------------------- the seat we are drafting for */
    const userId =
      Object.keys(draft.draft_order ?? {})[0] ??
      attachment.rosters.find((roster) => roster.owner_id)?.owner_id ??
      '';
    expect(userId).not.toBe('');

    /* ------------- load real projections / room ranks / ADP exactly once */
    const openingBoard = deriveDraftBoardState(draft, [], attachment.rosters, players);
    const openingContext = normalizeLeagueContext({
      league: attachment.league,
      draft,
      drafts: [draft],
      picks: [],
      tradedPicks: [],
      rosters: attachment.rosters,
      board: openingBoard,
      userId,
    });

    const firstSeedPlan = planAutomaticFirstSeed(openingContext);
    const adpPlan = planAutomaticAdp(openingContext, draft.season);
    expect(firstSeedPlan).toBeTruthy();
    expect(adpPlan).toBeTruthy();

    const [projectionSource, roomSource, adpSource] = await Promise.all([
      new FirstSeedProjectionProvider().getSnapshot({
        season: draft.season,
        scoringFormat: firstSeedPlan!.projectionFormat,
      }),
      new FirstSeedDraftRoomRankingProvider().getSnapshot({
        season: draft.season,
        platform: 'sleeper',
        scoringFormat: firstSeedPlan!.roomFormat,
        qbFormat: firstSeedPlan!.qbFormat,
      }),
      new FantasyFootballCalculatorAdpProvider().getSnapshot(adpPlan!.request),
    ]);

    const projections = mapFirstSeedProjectionSnapshot(projectionSource, players);
    const roomRankings = mapFirstSeedDraftRoomRankingSnapshot(roomSource, players, openingContext);
    const adp = mapAdpSnapshot(adpSource, players, openingContext);
    const composed = composeProjectionAndAdp(projections, adp);

    console.log(
      `[replay] ${attachment.label} · ${draftId} · replaying ${replayCount}/${ordered.length} picks · ` +
        `projections=${projections.resolution.matched} room=${roomRankings.resolution.matched} adp=${adp.resolution.matched}`,
    );

    /* --------------------------------------------- run the real loop */
    const clock = createClock();
    const feed = createReplayFeed(draft, ordered);
    const updates: FollowerUpdate[] = [];

    const follower = createDraftFollower(
      draftId,
      {
        fetchSnapshot: feed.fetchSnapshot,
        now: clock.now,
        setTimer: clock.setTimer,
        clearTimer: clock.clearTimer,
        random: () => 0.5,
        isHidden: () => false,
      },
      (update) => updates.push(update),
    );

    /** Exactly what the dashboard derives, for whatever the follower last saw. */
    const deriveFromLatest = () => {
      const snapshot = updates[updates.length - 1]?.snapshot;
      expect(snapshot).toBeTruthy();
      const live = snapshot!;
      const currentAttachment = buildDraftAttachment({
        draft: live.draft,
        league,
        rosters,
      });
      const board = deriveDraftBoardState(
        live.draft,
        live.picks,
        currentAttachment.rosters,
        players,
      );
      const context = normalizeLeagueContext({
        league: currentAttachment.league,
        draft: live.draft,
        drafts: [live.draft],
        picks: live.picks,
        tradedPicks: live.tradedPicks,
        rosters: currentAttachment.rosters,
        board,
        userId,
      });
      const result = generateDraftRecommendations({
        context,
        picks: live.picks,
        rosters: currentAttachment.rosters,
        board,
        players,
        projections: composed,
        roomRankings,
      });
      return { board, result };
    };

    follower.start();
    await flush();

    // The opening board: nothing drafted, everybody available.
    expect(updates).toHaveLength(1);
    const opening = deriveFromLatest();
    expect(opening.board.picksMade).toBe(0);
    expect(opening.result.recommendations.length).toBeGreaterThan(0);
    // 'limited' is the honest status for First Seed aggregate projections: the
    // engine will not claim it recalculated custom Sleeper scoring it cannot
    // verify. Both statuses mean the recommendations are usable.
    expect(USABLE).toContain(opening.result.status);
    console.log(`[replay] status=${opening.result.status}`);
    for (const message of opening.result.messages) console.log(`[replay]   note: ${message}`);

    let previousTopId = opening.result.recommendations[0].player.id;
    let topChanges = 0;
    let topSurvivedItsOwnPick = 0;
    let userSelections = 0;

    for (let n = 1; n <= replayCount; n += 1) {
      const madePick = feed.revealNextPick();
      const updatesBefore = updates.length;

      const elapsed = await clock.advance();
      expect(elapsed).not.toBeNull();

      // Every pick produces exactly one update, and it is a real change.
      expect(updates.length).toBe(updatesBefore + 1);
      const update = updates[updates.length - 1];
      expect(update.changed).toBe(true);
      expect(update.sync.phase).toBe('live');

      const { board, result } = deriveFromLatest();

      // The board advanced by exactly one selection.
      expect(board.picksMade).toBe(n);
      expect(board.currentOverallPick).toBe(n + 1);

      // The player just taken is off the board.
      if (players.bySleeperId.has(madePick.player_id)) {
        expect(board.unavailableSleeperIds.has(madePick.player_id)).toBe(true);
      }

      // Recommendations regenerated, and never suggest somebody already gone.
      expect(result.recommendations.length).toBeGreaterThan(0);
      expect(USABLE).toContain(result.status);
      for (const recommendation of result.recommendations) {
        const sleeperId = recommendation.player.externalIds.sleeper;
        if (sleeperId) expect(board.unavailableSleeperIds.has(sleeperId)).toBe(false);
      }

      // The clock we are counting down to our own next pick stays coherent.
      if (result.picksUntilNextUserPick !== null) {
        expect(result.picksUntilNextUserPick).toBeGreaterThanOrEqual(0);
      }
      if (result.nextUserPick !== null) {
        expect(result.nextUserPick).toBeGreaterThan(n);
      }

      // The headline pick must react when it is the one that just got taken.
      const topId = result.recommendations[0].player.id;
      const topWasTaken =
        players.bySleeperId.get(madePick.player_id)?.id === previousTopId;
      if (topWasTaken) {
        expect(topId).not.toBe(previousTopId);
        topSurvivedItsOwnPick += 1;
      }
      if (topId !== previousTopId) topChanges += 1;
      previousTopId = topId;

      if (result.userRosterId !== null && Number(madePick.roster_id) === result.userRosterId) {
        userSelections += 1;
      }
    }

    console.log(
      `[replay] ${replayCount} picks replayed · top recommendation changed ${topChanges}x · ` +
        `${topSurvivedItsOwnPick} of those because the top player was taken · ` +
        `${userSelections} of the picks were our seat's`,
    );

    // Recommendations must actually move over a draft, not sit still.
    expect(topChanges).toBeGreaterThan(0);

    /* ------------------------------- the room closes, the loop stops */
    feed.finish();
    await clock.advance();
    await flush();

    const last = updates[updates.length - 1];
    expect(last.sync.phase).toBe('complete');
    expect(clock.pending()).toBe(0);

    follower.stop();
  }, 120_000);
});
