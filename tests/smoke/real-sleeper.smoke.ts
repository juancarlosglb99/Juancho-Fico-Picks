import { describe, expect, it } from 'vitest';
import { normalizeLeagueContext } from '../../packages/engine/context/normalize';
import type { LeagueType } from '../../packages/engine/context/types';
import { deriveDraftBoardState } from '../../packages/engine/draft/state';
import { buildCanonicalPlayerMap } from '../../packages/players/player-map';
import { sleeperClient } from '../../packages/sleeper/client';

const realLeagueCases = [
  { label: 'redraft 3RR', leagueId: '1388280410047275008', expected: 'redraft' },
  { label: 'keeper', leagueId: '1394072892865527808', expected: 'keeper' },
  { label: 'dynasty rookie supplemental', leagueId: '1312115646644912128', expected: 'dynasty' },
] satisfies Array<{ label: string; leagueId: string; expected: LeagueType }>;

describe('real Sleeper payload normalization', () => {
  it.each(realLeagueCases)('normalizes a public $label league', async ({ leagueId, expected }) => {
    const [league, drafts, rosters] = await Promise.all([
      sleeperClient.getLeague(leagueId),
      sleeperClient.getLeagueDrafts(leagueId),
      sleeperClient.getRosters(leagueId),
    ]);
    const draft = drafts.find((candidate) => candidate.draft_id === league.draft_id) ?? drafts[0];
    expect(draft, `Expected league ${leagueId} to expose at least one draft`).toBeDefined();

    const [picks, tradedPicks] = await Promise.all([
      sleeperClient.getDraftPicks(draft.draft_id),
      sleeperClient.getDraftTradedPicks(draft.draft_id),
    ]);
    const playerMap = buildCanonicalPlayerMap({});
    const board = deriveDraftBoardState(draft, picks, rosters, playerMap);
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

    expect(context.leagueType.value).toBe(expected);
    expect(context.leagueType.source).toBe('league.settings.type');
    expect(context.roster.value.totalStarterSpots).toBeGreaterThan(0);
    expect(context.draftState.value.draftedPlayerIds).toHaveLength(picks.length);

    if (expected === 'redraft') expect(context.draftType.value).toBe('3rr');
    if (expected === 'keeper') expect(context.keeperSettings.value.rulesFullyKnown).toBe(false);
    if (expected === 'dynasty') expect(context.draftContext.value).toBe('rookie_supplemental');
  });
});
