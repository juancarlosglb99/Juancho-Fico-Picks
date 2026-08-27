/**
 * A `DraftBrief` for any pick of any saved mock.
 *
 * The corpus already holds the exact board, projections and player pool each
 * capture faced, which makes it the honest way to inspect what the strategist
 * will actually be given: a brief built here is byte-identical to one built
 * live at that moment of that draft, rather than a hand-written example that
 * quietly omits whatever is inconvenient.
 *
 * Used by the regression tests and by `npm run brief`.
 */
import type { DraftRoomRankingSnapshot, ProjectionSnapshot } from '../../data/types';
import type { CanonicalPlayerMap } from '../../players/types';
import type { SleeperDraft, SleeperLeague, SleeperRoster } from '../../sleeper/types';
import { normalizeLeagueContext } from '../context/normalize';
import { generateDraftRecommendations } from '../draft/recommendations';
import { deriveDraftBoardState } from '../draft/state';
import { buildDraftBrief, type CandidatePoolOptions } from '../strategist/brief';
import type { DraftBrief } from '../strategist/types';
import type { RegressionCase } from './case';

export interface BriefReplayInput {
  regression: RegressionCase;
  projections: ProjectionSnapshot;
  roomRankings: DraftRoomRankingSnapshot | null;
  players: CanonicalPlayerMap;
  league: SleeperLeague;
  draft: SleeperDraft;
  rosters: SleeperRoster[];
  candidatePool?: Partial<CandidatePoolOptions>;
}

/** Every overall pick number our seat owns in a saved case. */
export function ourPickNumbers(regression: RegressionCase): number[] {
  return [...regression.picks]
    .sort((a, b) => a.pick_no - b.pick_no)
    .filter((pick) => pick.draft_slot === regression.userSlot)
    .map((pick) => pick.pick_no);
}

/**
 * The brief as it stood immediately before `overallPick` was made.
 *
 * The room's real selections are kept exactly as they happened - including our
 * own, unlike the strategy replay, because the point here is to reproduce a
 * real board rather than to re-decide it.
 */
export function buildBriefAtPick(
  input: BriefReplayInput,
  overallPick: number,
): DraftBrief | null {
  const { regression, players, league, draft, rosters, projections, roomRankings } = input;
  const picksBefore = [...regression.picks]
    .sort((a, b) => a.pick_no - b.pick_no)
    .filter((pick) => pick.pick_no < overallPick);

  const board = deriveDraftBoardState(draft, picksBefore, rosters, players);
  const context = normalizeLeagueContext({
    league,
    draft,
    drafts: [draft],
    picks: picksBefore,
    tradedPicks: [],
    rosters,
    board,
    userId: regression.userId,
  });
  const result = generateDraftRecommendations({
    context,
    picks: picksBefore,
    rosters,
    board,
    players,
    projections: projections.records,
    roomRankings,
  });

  return buildDraftBrief({
    context,
    board,
    picks: picksBefore,
    rosters,
    players,
    result,
    draftId: regression.draftId,
    rosterViews: null,
    isMock: regression.format.isMock,
    candidatePool: input.candidatePool,
  });
}
