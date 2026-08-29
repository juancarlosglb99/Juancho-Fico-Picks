/**
 * One real board, built once, for the UI derivations to read.
 *
 * The point is that nothing here is a hand-written mock of an engine result.
 * `generateDraftRecommendations` and `buildDraftBrief` are the real ones, so a
 * UI module that reads a field the engine stopped producing fails here rather
 * than on a draft clock.
 */
import { generateDraftRecommendations } from '../../packages/engine/draft/recommendations';
import { buildDraftBrief } from '../../packages/engine/strategist/brief';
import type { DraftBrief } from '../../packages/engine/strategist/types';
import type { DraftRecommendationResult } from '../../packages/engine/draft/types';
import type { SleeperDraft, SleeperDraftPick } from '../../packages/sleeper/types';
import {
  makeContext,
  makeDraft,
  makeLeague,
  makePlayerPool,
  makeProjections,
  makeRoomRankings,
  makeRosters,
} from '../engine/fixtures';

const players = makePlayerPool(48);

export function makePicks({
  count,
  teams = 12,
  players: pool = players,
}: {
  count: number;
  teams?: number;
  players?: typeof players;
}): SleeperDraftPick[] {
  const ordered = pool.players;
  const picks: SleeperDraftPick[] = [];
  for (let index = 0; index < count; index += 1) {
    const overall = index + 1;
    const round = Math.floor(index / teams) + 1;
    const pickInRound = (index % teams) + 1;
    const slot = round % 2 === 0 ? teams + 1 - pickInRound : pickInRound;
    const player = ordered[index];
    picks.push({
      player_id: player.externalIds.sleeper ?? player.id,
      picked_by: `user-${slot}`,
      roster_id: String(slot),
      round,
      draft_slot: slot,
      pick_no: overall,
      metadata: {
        first_name: player.name.split(' ')[0],
        last_name: player.name.split(' ').slice(1).join(' '),
        position: player.position,
        team: player.team ?? 'TST',
      },
    });
  }
  return picks;
}

export interface UiScenario {
  draft: SleeperDraft;
  picks: SleeperDraftPick[];
  players: typeof players;
  board: ReturnType<typeof makeContext>['board'];
  context: ReturnType<typeof makeContext>['context'];
  result: DraftRecommendationResult;
  brief: DraftBrief;
}

export function scenario({
  picksMade = 14,
  teams = 12,
  rounds = 15,
  userId = 'user-3',
  draftType = 'snake',
}: {
  picksMade?: number;
  teams?: number;
  rounds?: number;
  userId?: string;
  draftType?: string;
} = {}): UiScenario {
  const league = makeLeague({ teams });
  const draft = makeDraft({ teams, rounds, type: draftType });
  const picks = makePicks({ count: picksMade, teams });
  const rosters = makeRosters(teams);
  const { context, board } = makeContext({
    league,
    draft,
    picks,
    rosters,
    players,
    userId,
  });
  const projections = makeProjections(players);
  const result = generateDraftRecommendations({
    context,
    picks,
    rosters,
    board,
    players,
    projections,
    roomRankings: makeRoomRankings(projections),
  });
  const brief = buildDraftBrief({
    context,
    board,
    picks,
    rosters,
    players,
    result,
    draftId: draft.draft_id,
    isMock: false,
  })!;
  return { draft, picks, players, board, context, result, brief };
}
