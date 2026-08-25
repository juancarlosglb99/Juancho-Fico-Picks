import { describe, expect, it } from 'vitest';
import { deriveDraftBoardState } from '../../packages/engine/draft/state';
import { buildCanonicalPlayerMap } from '../../packages/players/player-map';
import type {
  SleeperDraft,
  SleeperDraftPick,
  SleeperRoster,
} from '../../packages/sleeper/types';

const draft: SleeperDraft = {
  draft_id: 'draft-1',
  league_id: 'league-1',
  status: 'drafting',
  type: 'snake',
  season: '2026',
  start_time: null,
  last_picked: null,
  settings: { teams: 4, rounds: 10 },
  metadata: {},
  draft_order: null,
  slot_to_roster_id: null,
};

const players = buildCanonicalPlayerMap({
  '100': { player_id: '100', full_name: 'Player One', position: 'WR' },
  '200': { player_id: '200', full_name: 'Player Two', position: 'RB' },
  '300': { player_id: '300', full_name: 'Player Three', position: 'QB' },
});

describe('draft board state', () => {
  it('subtracts drafted and already-rostered players from availability', () => {
    const picks: SleeperDraftPick[] = [
      {
        player_id: '100',
        picked_by: 'user-1',
        roster_id: '1',
        round: 1,
        draft_slot: 1,
        pick_no: 1,
        metadata: {},
      },
    ];
    const rosters: SleeperRoster[] = [
      {
        roster_id: 1,
        owner_id: 'user-1',
        players: ['200'],
        starters: [],
        reserve: [],
        settings: null,
      },
    ];

    const board = deriveDraftBoardState(draft, picks, rosters, players);

    expect(board.availablePlayers.map((player) => player.id)).toEqual(['jfp:300']);
    expect(board.picksMade).toBe(1);
    expect(board.currentOverallPick).toBe(2);
    expect(board.currentRound).toBe(1);
    expect(board.pickInRound).toBe(2);
  });

  it('advances the round after a complete set of team picks', () => {
    const picks = Array.from({ length: 4 }, (_, index) => ({
      player_id: String(500 + index),
      picked_by: `user-${index}`,
      roster_id: String(index + 1),
      round: 1,
      draft_slot: index + 1,
      pick_no: index + 1,
      metadata: {},
    }));

    const board = deriveDraftBoardState(draft, picks, [], players);
    expect(board.currentOverallPick).toBe(5);
    expect(board.currentRound).toBe(2);
    expect(board.pickInRound).toBe(1);
  });
});
