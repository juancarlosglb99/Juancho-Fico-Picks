import { describe, expect, it } from 'vitest';
import {
  FirstSeedDraftRoomRankingProvider,
  FirstSeedProjectionProvider,
} from '../../packages/first-seed/providers';
import { FantasyFootballCalculatorAdpProvider } from '../../packages/adp/providers/fantasy-football-calculator';
import { mapAdpSnapshot, planAutomaticAdp } from '../../packages/adp/automatic';
import { composeProjectionAndAdp } from '../../packages/data/projections';
import { normalizeLeagueContext } from '../../packages/engine/context/normalize';
import { generateDraftRecommendations } from '../../packages/engine/draft/recommendations';
import { deriveDraftBoardState } from '../../packages/engine/draft/state';
import { planAutomaticFirstSeed } from '../../packages/first-seed/automatic';
import {
  mapFirstSeedDraftRoomRankingSnapshot,
  mapFirstSeedProjectionSnapshot,
} from '../../packages/first-seed/mapping';
import { buildCanonicalPlayerMap } from '../../packages/players/player-map';
import { sleeperClient } from '../../packages/sleeper/client';

describe('live First Seed structured sheets', () => {
  it.each(['standard', 'half_ppr', 'full_ppr'] as const)(
    'loads 2026 %s aggregate projections',
    async (scoringFormat) => {
      const snapshot = await new FirstSeedProjectionProvider().getSnapshot({
        season: '2026',
        scoringFormat,
      });
      expect(snapshot.records.length).toBeGreaterThanOrEqual(100);
      expect(snapshot.provenance.sourceUpdatedAt).toMatch(/^2026-/);
      expect(snapshot.records.every((record) => record.projection >= 0)).toBe(true);
    },
  );

  it.each([
    { scoringFormat: 'standard' as const, qbFormat: '1qb' as const },
    { scoringFormat: 'half_ppr' as const, qbFormat: '1qb' as const },
    { scoringFormat: 'full_ppr' as const, qbFormat: '1qb' as const },
    { scoringFormat: 'full_ppr' as const, qbFormat: 'superflex' as const },
  ])('loads Sleeper $scoringFormat/$qbFormat room rank', async ({ scoringFormat, qbFormat }) => {
    const snapshot = await new FirstSeedDraftRoomRankingProvider().getSnapshot({
      season: '2026',
      platform: 'sleeper',
      scoringFormat,
      qbFormat,
    });
    expect(snapshot.records.length).toBeGreaterThanOrEqual(80);
    expect(snapshot.provenance.sourceUpdatedAt).toMatch(/^2026-/);
    expect(snapshot.records.every((record) => record.rank > 0)).toBe(true);
  });

  it('runs a public supported Sleeper redraft league to recommendations with zero CSV input', async () => {
    const league = await sleeperClient.getLeague('1388280410047275008');
    const [drafts, rosters, rawPlayers] = await Promise.all([
      sleeperClient.getLeagueDrafts(league.league_id),
      sleeperClient.getRosters(league.league_id),
      sleeperClient.getActivePlayers(),
    ]);
    const draft = drafts.find((candidate) => candidate.draft_id === league.draft_id) ?? drafts[0];
    const [picks, tradedPicks] = await Promise.all([
      sleeperClient.getDraftPicks(draft.draft_id),
      sleeperClient.getDraftTradedPicks(draft.draft_id),
    ]);
    const players = buildCanonicalPlayerMap(rawPlayers);
    const board = deriveDraftBoardState(draft, picks, rosters, players);
    const context = normalizeLeagueContext({
      league,
      draft,
      drafts,
      picks,
      tradedPicks,
      rosters,
      board,
      userId: rosters.find((roster) => roster.owner_id)?.owner_id ?? '',
    });
    const firstSeedPlan = planAutomaticFirstSeed(context)!;
    const adpPlan = planAutomaticAdp(context, draft.season)!;
    expect(firstSeedPlan).toBeTruthy();
    expect(adpPlan).toBeTruthy();
    const [projectionSource, roomSource, adpSource] = await Promise.all([
      new FirstSeedProjectionProvider().getSnapshot({
        season: draft.season,
        scoringFormat: firstSeedPlan.projectionFormat,
      }),
      new FirstSeedDraftRoomRankingProvider().getSnapshot({
        season: draft.season,
        platform: 'sleeper',
        scoringFormat: firstSeedPlan.roomFormat,
        qbFormat: firstSeedPlan.qbFormat,
      }),
      new FantasyFootballCalculatorAdpProvider().getSnapshot(adpPlan.request),
    ]);
    const projections = mapFirstSeedProjectionSnapshot(projectionSource, players);
    const roomRankings = mapFirstSeedDraftRoomRankingSnapshot(roomSource, players, context);
    const adp = mapAdpSnapshot(adpSource, players, context);
    const result = generateDraftRecommendations({
      context,
      picks,
      rosters,
      board,
      players,
      projections: composeProjectionAndAdp(projections, adp),
      roomRankings,
    });

    expect(projections.resolution.matched).toBeGreaterThanOrEqual(200);
    expect(roomRankings.resolution.matched).toBeGreaterThanOrEqual(180);
    expect(adp.resolution.matched).toBeGreaterThanOrEqual(80);
    expect(result.recommendations.length).toBeGreaterThan(0);
    expect(result.recommendations[0].projection.projectionSource).toContain('First Seed');
    expect(result.recommendations.some((recommendation) => recommendation.draftRoomRank !== null))
      .toBe(true);
    expect(result.recommendations.some((recommendation) => recommendation.marketAdp !== null))
      .toBe(true);
  });
});
