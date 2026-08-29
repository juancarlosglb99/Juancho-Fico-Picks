/**
 * The regression case: the real Sleeper mock that produced nine quarterbacks.
 *
 *   https://sleeper.com/draft/nfl/1398412036827783168
 *
 * A 10-team standard-scoring snake mock, seat 1, 15 rounds. Following the top
 * recommendation every round finished QB9 RB4 WR1 TE1 - a roster that cannot
 * even field a legal lineup, since it needs two receivers, a kicker and a
 * defense it never drafted.
 *
 * This replays the exact board at each of those fifteen selections and asserts
 * the engine now builds something a person would actually draft. It runs
 * against the live Sleeper and First Seed APIs:
 *
 *     npm run test:smoke
 *
 * Set SLEEPER_REGRESSION_VERBOSE=1 to print the full pick-by-pick comparison.
 */
import { describe, expect, it } from 'vitest';
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
import type { Position } from '../../packages/players/types';

const DRAFT_ID = '1398412036827783168';
const USER_ID = '635739229082718208';
const OUR_SLOT = 1;
const VERBOSE = process.env.SLEEPER_REGRESSION_VERBOSE === '1';

/** What the old engine actually produced, for the record. */
const ORIGINAL_ROSTER: Record<string, number> = { QB: 9, RB: 4, WR: 1, TE: 1 };

describe('the mock draft that produced nine quarterbacks', () => {
  it('now recommends a roster a person would build', async () => {
    const [draft, allPicks, rawPlayers] = await Promise.all([
      sleeperClient.getDraft(DRAFT_ID),
      sleeperClient.getDraftPicks(DRAFT_ID),
      sleeperClient.getActivePlayers(),
    ]);

    // A Sleeper mock has no league behind it, so everything is synthesized from
    // the draft room itself - and its picks carry no roster id.
    const attachment = buildDraftAttachment({ draft, league: null, rosters: null });
    const players = buildCanonicalPlayerMap(rawPlayers);
    const ordered = [...allPicks].sort((a, b) => a.pick_no - b.pick_no);
    const ourPicks = ordered.filter((pick) => pick.draft_slot === OUR_SLOT);
    expect(ourPicks).toHaveLength(15);

    const openingBoard = deriveDraftBoardState(draft, [], attachment.rosters, players);
    const openingContext = normalizeLeagueContext({
      league: attachment.league,
      draft,
      drafts: [draft],
      picks: [],
      tradedPicks: [],
      rosters: attachment.rosters,
      board: openingBoard,
      userId: USER_ID,
    });

    // Bench slots must be inferred: the mock reports none at all.
    expect(openingContext.roster.value.bench).toBeGreaterThan(0);
    expect(openingContext.draftState.value.userDraftSlot).toBe(OUR_SLOT);

    const plan = planAutomaticFirstSeed(openingContext);
    expect(plan).toBeTruthy();
    const [projectionSource, roomSource] = await Promise.all([
      new FirstSeedProjectionProvider().getSnapshot({
        season: draft.season,
        scoringFormat: plan!.projectionFormat,
      }),
      new FirstSeedDraftRoomRankingProvider().getSnapshot({
        season: draft.season,
        platform: 'sleeper',
        scoringFormat: plan!.roomFormat,
        qbFormat: plan!.qbFormat,
      }),
    ]);
    const projections = mapFirstSeedProjectionSnapshot(projectionSource, players);
    const roomRankings = mapFirstSeedDraftRoomRankingSnapshot(
      roomSource,
      players,
      openingContext,
    );

    /*
     * Replay the real board at each of our selections.
     *
     * The room's picks are the ones that actually happened; only OUR selections
     * are replaced by what the engine now recommends. That keeps the comparison
     * honest - the engine faces the same board the human did.
     */
    const ourNewRoster: { name: string; position: Position; round: number }[] = [];
    const takenByUs = new Set<string>();
    const contradictions: string[] = [];

    for (const ourPick of ourPicks) {
      const roomPicksBefore = ordered.filter(
        (pick) => pick.pick_no < ourPick.pick_no && pick.draft_slot !== OUR_SLOT,
      );
      const ourPicksSoFar = ordered
        .filter((pick) => pick.draft_slot === OUR_SLOT && pick.pick_no < ourPick.pick_no)
        .map((pick, index) => ({
          ...pick,
          player_id: [...takenByUs][index] ?? pick.player_id,
        }));
      const picksBefore = [...roomPicksBefore, ...ourPicksSoFar].sort(
        (a, b) => a.pick_no - b.pick_no,
      );

      const board = deriveDraftBoardState(draft, picksBefore, attachment.rosters, players);
      const context = normalizeLeagueContext({
        league: attachment.league,
        draft,
        drafts: [draft],
        picks: picksBefore,
        tradedPicks: [],
        rosters: attachment.rosters,
        board,
        userId: USER_ID,
      });
      const result = generateDraftRecommendations({
        context,
        picks: picksBefore,
        rosters: attachment.rosters,
        board,
        players,
        projections: projections.records,
        roomRankings,
      });

      const best = result.recommendations[0];
      expect(best, `no recommendation at pick ${ourPick.pick_no}`).toBeTruthy();

      // The contradiction that started this: urgent advice on a player who is
      // overwhelmingly likely to still be there.
      const probability = best.availableNextPickProbability;
      if (
        best.action === 'DRAFT_NOW' &&
        probability !== null &&
        probability >= 90 &&
        !best.insight.exceptionalReason
      ) {
        contradictions.push(
          `pick ${ourPick.pick_no}: ${best.player.name} DRAFT_NOW at ${probability}%`,
        );
      }

      const sleeperId = best.player.externalIds.sleeper!;
      takenByUs.add(sleeperId);
      ourNewRoster.push({
        name: best.player.name,
        position: best.player.position,
        round: ourPick.round,
      });

      if (VERBOSE) {
        const old = ourPick.metadata;
        console.log(
          `R${String(ourPick.round).padStart(2)} pick ${String(ourPick.pick_no).padStart(3)} | ` +
            `then: ${`${old.first_name} ${old.last_name}`.padEnd(20)} ${String(old.position).padEnd(3)} | ` +
            `now: ${best.player.name.padEnd(20)} ${best.player.position.padEnd(3)} ` +
            `${best.action.padEnd(9)} avail=${probability === null ? '  —' : String(probability).padStart(5)}% ` +
            `lineup+=${best.components.marginalStartingValue.toFixed(1).padStart(6)} ` +
            `build=${best.insight.build}`,
        );
      }
    }

    const counts: Record<string, number> = {};
    for (const entry of ourNewRoster) counts[entry.position] = (counts[entry.position] ?? 0) + 1;
    console.log(
      `[regression] then: ${JSON.stringify(ORIGINAL_ROSTER)}  →  now: ${JSON.stringify(counts)}`,
    );

    /* ------------------------------------------------- what must now hold */

    // The failure itself.
    expect(counts.QB ?? 0).toBeLessThanOrEqual(2);
    expect(counts.QB ?? 0).toBeLessThan(ORIGINAL_ROSTER.QB);

    // A legal, startable lineup: 1 QB, 2 RB, 2 WR, 1 TE, 2 FLEX.
    expect(counts.QB ?? 0).toBeGreaterThanOrEqual(1);
    expect(counts.RB ?? 0).toBeGreaterThanOrEqual(2);
    expect(counts.WR ?? 0).toBeGreaterThanOrEqual(2);
    expect(counts.TE ?? 0).toBeGreaterThanOrEqual(1);

    // The original drafted a single receiver across fifteen rounds.
    expect(counts.WR ?? 0).toBeGreaterThan(ORIGINAL_ROSTER.WR);

    // Depth belongs where it can be started.
    expect((counts.RB ?? 0) + (counts.WR ?? 0)).toBeGreaterThanOrEqual(9);

    // And no unexplained contradictions anywhere in the draft.
    expect(contradictions).toEqual([]);

    // Nobody drafted twice.
    expect(new Set(ourNewRoster.map((entry) => entry.name)).size).toBe(ourNewRoster.length);
  }, 300_000);
});
