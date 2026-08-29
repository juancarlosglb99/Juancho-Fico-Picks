/**
 * Measures the real cost of turning a Sleeper pick into advice.
 *
 * Two things are timed against the live API rather than a fixture, because both
 * are dominated by conditions no fixture reproduces:
 *
 *   the round trip  - what one poll actually costs, network included
 *   the thinking    - rebuilding the board, context and recommendations
 *
 * Together with the polling interval those are the whole of reaction time, so
 * this is the check that the one-second budget is real:
 *
 *     expected pick-to-advice = half the poll interval   (average wait)
 *                             + one round trip
 *                             + one rebuild
 *
 *     npm run test:smoke
 */
import { describe, expect, it } from 'vitest';
import { FirstSeedDraftRoomRankingProvider, FirstSeedProjectionProvider } from '../../packages/first-seed/providers';
import { planAutomaticFirstSeed } from '../../packages/first-seed/automatic';
import {
  mapFirstSeedDraftRoomRankingSnapshot,
  mapFirstSeedProjectionSnapshot,
} from '../../packages/first-seed/mapping';
import { buildCanonicalPlayerMap } from '../../packages/players/player-map';
import { buildDraftAttachment } from '../../packages/sleeper/attachment';
import { sleeperClient } from '../../packages/sleeper/client';
import { normalizeLeagueContext } from '../../packages/engine/context/normalize';
import { generateDraftRecommendations } from '../../packages/engine/draft/recommendations';
import { deriveDraftBoardState } from '../../packages/engine/draft/state';
import { SYNC_INTERVALS } from '../../packages/sleeper/live-sync';
import { LATENCY_BUDGET_MS, measure } from '../../packages/engine/perf/latency';

/** The completed mock that started all of this; any real draft works. */
const DRAFT_ID = process.env.SLEEPER_LATENCY_DRAFT_ID?.trim() || '1398412036827783168';

describe('reaction time against the live API', () => {
  it('turns a pick into a recommendation well inside one second', async () => {
    const rawPlayers = await sleeperClient.getActivePlayers();
    const players = buildCanonicalPlayerMap(rawPlayers);

    /* ------------------------------------------- what one poll really costs */
    const roundTrips: number[] = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const started = Date.now();
      // The steady-state poll: the draft and its picks. Traded picks are read
      // occasionally rather than every time, so they are not in this path.
      await Promise.all([
        sleeperClient.getDraft(DRAFT_ID),
        sleeperClient.getDraftPicks(DRAFT_ID),
      ]);
      roundTrips.push(Date.now() - started);
    }
    const roundTrip = median(roundTrips);

    /* --------------------------------------------- what one rebuild costs */
    const [draft, allPicks] = await Promise.all([
      sleeperClient.getDraft(DRAFT_ID),
      sleeperClient.getDraftPicks(DRAFT_ID),
    ]);
    const league = draft.league_id ? await sleeperClient.getLeague(draft.league_id) : null;
    const rosters = draft.league_id ? await sleeperClient.getRosters(draft.league_id) : null;
    const attachment = buildDraftAttachment({ draft, league, rosters });
    const ordered = [...allPicks].sort((a, b) => a.pick_no - b.pick_no);
    const userId =
      Object.keys(draft.draft_order ?? {})[0] ??
      attachment.rosters.find((roster) => roster.owner_id)?.owner_id ??
      '';

    const opening = deriveDraftBoardState(draft, [], attachment.rosters, players);
    const openingContext = normalizeLeagueContext({
      league: attachment.league,
      draft,
      drafts: [draft],
      picks: [],
      tradedPicks: [],
      rosters: attachment.rosters,
      board: opening,
      userId,
    });
    const plan = planAutomaticFirstSeed(openingContext)!;
    const [projectionSource, roomSource] = await Promise.all([
      new FirstSeedProjectionProvider().getSnapshot({
        season: draft.season,
        scoringFormat: plan.projectionFormat,
      }),
      new FirstSeedDraftRoomRankingProvider().getSnapshot({
        season: draft.season,
        platform: 'sleeper',
        scoringFormat: plan.roomFormat,
        qbFormat: plan.qbFormat,
      }),
    ]);
    const projections = mapFirstSeedProjectionSnapshot(projectionSource, players);
    const roomRankings = mapFirstSeedDraftRoomRankingSnapshot(roomSource, players, openingContext);

    // Sample the rebuild across the draft: an empty board and a nearly full one
    // are the cheap and expensive ends of the same operation.
    const rebuilds: number[] = [];
    const checkpoints = [0, 0.25, 0.5, 0.75].map((share) =>
      Math.floor(ordered.length * share),
    );
    for (const upTo of checkpoints) {
      const picksBefore = ordered.slice(0, upTo);
      const { ms } = measure(() => {
        const board = deriveDraftBoardState(draft, picksBefore, attachment.rosters, players);
        const context = normalizeLeagueContext({
          league: attachment.league,
          draft,
          drafts: [draft],
          picks: picksBefore,
          tradedPicks: [],
          rosters: attachment.rosters,
          board,
          userId,
        });
        return generateDraftRecommendations({
          context,
          picks: picksBefore,
          rosters: attachment.rosters,
          board,
          players,
          projections: projections.records,
          roomRankings,
        });
      });
      rebuilds.push(ms);
    }

    const slowestRebuild = Math.max(...rebuilds);
    const averageWait = SYNC_INTERVALS.drafting / 2;
    const expectedTypical = averageWait + roundTrip + median(rebuilds);
    const expectedWorst = SYNC_INTERVALS.drafting + Math.max(...roundTrips) + slowestRebuild;

    console.log(
      `[latency] poll interval ${SYNC_INTERVALS.drafting}ms · round trip ${roundTrip}ms ` +
        `(worst ${Math.max(...roundTrips)}ms) · rebuild ${median(rebuilds).toFixed(1)}ms ` +
        `(worst ${slowestRebuild.toFixed(1)}ms)`,
    );
    console.log(
      `[latency] expected pick-to-advice: typical ${Math.round(expectedTypical)}ms · ` +
        `worst case ${Math.round(expectedWorst)}ms · budget ${LATENCY_BUDGET_MS}ms`,
    );

    // Our own share of the budget must be small enough that polling and the
    // network decide the outcome, not the engine.
    expect(slowestRebuild).toBeLessThan(200);

    // And the typical case has to actually meet the target.
    expect(expectedTypical).toBeLessThan(LATENCY_BUDGET_MS);

    // The worst case is reported rather than asserted tightly: it is dominated
    // by one network round trip, and failing a build because somebody's wifi
    // hiccuped would teach us nothing. A wide bound still catches a real
    // collapse.
    expect(expectedWorst).toBeLessThan(LATENCY_BUDGET_MS * 2);
  }, 300_000);
});

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}
