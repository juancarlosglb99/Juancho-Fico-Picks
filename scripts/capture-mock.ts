/**
 * Freezes a real Sleeper draft into a permanent regression case.
 *
 *     npm run capture -- <draft link or id> <your sleeper username>
 *
 * Run this after every mock. It records the whole board, the format, the
 * engine's recommendation and strategy state at each of your selections, what
 * you actually took, and the finished roster - together with the projection and
 * draft-room snapshots that were live at the time, so the case replays
 * identically forever.
 *
 * Cases land in `data/regression/mocks/` and are picked up automatically by
 * `npm test`.
 */
import { FirstSeedDraftRoomRankingProvider, FirstSeedProjectionProvider } from '../packages/first-seed/providers';
import { planAutomaticFirstSeed } from '../packages/first-seed/automatic';
import {
  mapFirstSeedDraftRoomRankingSnapshot,
  mapFirstSeedProjectionSnapshot,
} from '../packages/first-seed/mapping';
import { buildCanonicalPlayerMap } from '../packages/players/player-map';
import { buildDraftAttachment, isMockDraft } from '../packages/sleeper/attachment';
import { extractSleeperDraftId } from '../packages/sleeper/draft-ref';
import { sleeperClient } from '../packages/sleeper/client';
import { normalizeLeagueContext } from '../packages/engine/context/normalize';
import { deriveDraftBoardState } from '../packages/engine/draft/state';
import {
  REGRESSION_CASE_VERSION,
  replayRegressionCase,
  type RegressionCase,
} from '../packages/engine/benchmark/case';
import {
  snapshotRef,
  trimPlayersForSnapshot,
  writeCase,
  writeSnapshot,
} from '../packages/engine/benchmark/store';

export async function captureMock(
  draftRef: string,
  username: string,
): Promise<{ path: string; regression: RegressionCase }> {
  const draftId = extractSleeperDraftId(draftRef);
  if (!draftId) throw new Error(`"${draftRef}" is not a Sleeper draft link or id.`);

  const user = await sleeperClient.getUser(username);
  if (!user) throw new Error(`Sleeper does not know the username "${username}".`);

  const [draft, picks, rawPlayers] = await Promise.all([
    sleeperClient.getDraft(draftId),
    sleeperClient.getDraftPicks(draftId),
    sleeperClient.getActivePlayers(),
  ]);
  const players = buildCanonicalPlayerMap(rawPlayers);

  const mock = isMockDraft(draft);
  const league = mock || !draft.league_id ? null : await sleeperClient.getLeague(draft.league_id);
  const rosters = mock || !draft.league_id ? null : await sleeperClient.getRosters(draft.league_id);
  const attachment = buildDraftAttachment({ draft, league, rosters });

  // Which seat was ours? The draft order maps user id to slot.
  const userSlot = draft.draft_order?.[user.user_id] ?? null;
  if (userSlot === null) {
    throw new Error(
      `${username} does not appear in this draft's order, so there is no seat to replay.`,
    );
  }

  const board = deriveDraftBoardState(draft, [], attachment.rosters, players);
  const context = normalizeLeagueContext({
    league: attachment.league,
    draft,
    drafts: [draft],
    picks: [],
    tradedPicks: [],
    rosters: attachment.rosters,
    board,
    userId: user.user_id,
  });

  const plan = planAutomaticFirstSeed(context);
  if (!plan) {
    throw new Error(
      'This format has no automatic First Seed selection, so the case cannot be pinned to a data snapshot.',
    );
  }
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
  const roomRankings = mapFirstSeedDraftRoomRankingSnapshot(roomSource, players, context);

  // Pin the source data by reference so drafts from the same week share a file.
  const projectionsRef = snapshotRef('projections', [
    draft.season,
    plan.projectionFormat,
    projectionSource.provenance.sourceUpdatedAt?.slice(0, 10),
  ]);
  const roomRankingsRef = snapshotRef('room', [
    draft.season,
    'sleeper',
    plan.roomFormat,
    plan.qbFormat,
    roomSource.provenance.sourceUpdatedAt?.slice(0, 10),
  ]);
  // The player pool decides who is available, so it is pinned too. Keyed by the
  // projection date rather than a hash, because Sleeper's roster of active
  // players moves slowly and week-to-week reuse is the point.
  const playersRef = snapshotRef('players', [
    draft.season,
    projectionSource.provenance.sourceUpdatedAt?.slice(0, 10),
  ]);
  writeSnapshot(projectionsRef, projections);
  writeSnapshot(roomRankingsRef, roomRankings);
  writeSnapshot(playersRef, trimPlayersForSnapshot(rawPlayers));

  const ordered = [...picks].sort((a, b) => a.pick_no - b.pick_no);
  const ours = ordered.filter((pick) => pick.draft_slot === userSlot);

  const skeleton: RegressionCase = {
    version: REGRESSION_CASE_VERSION,
    capturedAt: new Date().toISOString(),
    draftId,
    draftUrl: `https://sleeper.com/draft/nfl/${draftId}`,
    userId: user.user_id,
    username: user.username ?? username,
    userSlot,
    format: {
      teams: context.teams.value,
      rounds: draft.settings.rounds ?? 0,
      scoringProfile: context.scoring.value.profile,
      qbFormat: plan.qbFormat,
      draftType: context.draftType.value,
      leagueType: context.leagueType.value,
      isMock: mock,
      rosterSlots: {
        QB: context.roster.value.QB,
        RB: context.roster.value.RB,
        WR: context.roster.value.WR,
        TE: context.roster.value.TE,
        FLEX: context.roster.value.FLEX,
        SUPER_FLEX: context.roster.value.SUPER_FLEX,
        K: context.roster.value.K,
        DEF: context.roster.value.DEF,
        bench: context.roster.value.bench,
      },
    },
    picks: ordered,
    actualRoster: ours.map((pick) => ({
      overallPick: pick.pick_no,
      round: pick.round,
      name: `${pick.metadata.first_name ?? ''} ${pick.metadata.last_name ?? ''}`.trim(),
      position: pick.metadata.position ?? 'UNKNOWN',
    })),
    projectionsRef,
    roomRankingsRef,
    playersRef,
    // Filled in by the replay below.
    baseline: { decisions: [], finalRoster: [], quality: {} as never },
  };

  const replay = replayRegressionCase({
    regression: skeleton,
    projections,
    roomRankings,
    players,
    league: attachment.league,
    draft,
    rosters: attachment.rosters,
  });

  const regression: RegressionCase = {
    ...skeleton,
    baseline: {
      decisions: replay.decisions,
      finalRoster: replay.finalRoster,
      quality: {
        ...replay.quality.roster,
        totalRegret: replay.quality.totalRegret,
        meanRegret: replay.quality.meanRegret,
      },
    },
  };

  return { path: writeCase(regression), regression };
}
