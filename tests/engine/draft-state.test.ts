import { describe, expect, it } from 'vitest';
import { deriveDraftBoardState } from '../../packages/engine/draft/state';
import { buildCanonicalPlayerMap } from '../../packages/players/player-map';
import {
  ANY_KNOWN_PLAYER,
  SLEEPER_TEAM_ASSIGNMENT,
} from '../../packages/players/eligibility';
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

// A team is what makes a player selectable, so every fixture player has one.
const players = buildCanonicalPlayerMap({
  '100': { player_id: '100', full_name: 'Player One', position: 'WR', team: 'TST' },
  '200': { player_id: '200', full_name: 'Player Two', position: 'RB', team: 'TST' },
  '300': { player_id: '300', full_name: 'Player Three', position: 'QB', team: 'TST' },
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

  /**
   * The rule that keeps a kicker who retired in 2019 off a 2026 board.
   *
   * Sleeper's player endpoint is an archive: it returns everyone it has ever
   * known, marks all of them `active: true`, and sets `status: "Active"` on
   * players who left the league years ago. Only the team assignment tracks
   * reality.
   */
  it('offers only players Sleeper currently places on an NFL team', () => {
    const withRetired = buildCanonicalPlayerMap({
      '100': { player_id: '100', full_name: 'Current Starter', position: 'WR', team: 'TST' },
      // Retired, and Sleeper still says Active. This is the Tom Brady shape.
      '900': { player_id: '900', full_name: 'Retired Star', position: 'QB', team: null, status: 'Active' },
      // Retired, and Sleeper says Injured Reserve. This is the Vinatieri shape.
      '901': { player_id: '901', full_name: 'Retired Kicker', position: 'K', team: null, status: 'Injured Reserve' },
      // On a roster and hurt, which is a completely different thing.
      '902': { player_id: '902', full_name: 'Hurt Starter', position: 'RB', team: 'TST', status: 'Injured Reserve' },
      // A team defense: Sleeper gives these an abbreviation and no status.
      '903': { player_id: 'TST', full_name: 'Test Defense', position: 'DEF', team: 'TST' },
      '904': { player_id: '904', full_name: 'Empty Team', position: 'TE', team: '  ' },
    });

    const board = deriveDraftBoardState(draft, [], [], withRetired);
    const available = board.availablePlayers.map((player) => player.name).sort();
    expect(available).toEqual(['Current Starter', 'Hurt Starter', 'Test Defense']);

    /*
     * The retired players are still KNOWN, because another team's pick has to
     * render a name. They are simply not selectable.
     */
    expect(withRetired.bySleeperId.get('901')?.name).toBe('Retired Kicker');
    expect(withRetired.bySleeperId.get('901')?.draftEligible).toBe(false);
    expect(withRetired.bySleeperId.get('902')?.draftEligible).toBe(true);
  });

  /**
   * The rule is a policy, not a definition: Sleeper can change how it maintains
   * any of these fields, so swapping it must be a one-line act rather than a
   * search through mapping code.
   */
  it('takes the eligibility rule as an argument, so it can be replaced', () => {
    const raw = {
      '100': { player_id: '100', full_name: 'Current Starter', position: 'WR', team: 'TST' },
      '901': { player_id: '901', full_name: 'Retired Kicker', position: 'K', team: null },
    };
    expect(SLEEPER_TEAM_ASSIGNMENT.id).toBe('sleeper-team-assignment-2026.1');

    const today = buildCanonicalPlayerMap(raw, SLEEPER_TEAM_ASSIGNMENT);
    expect(deriveDraftBoardState(draft, [], [], today).availablePlayers).toHaveLength(1);

    // Replaying a board captured under an older rule must not depend on today's.
    const historical = buildCanonicalPlayerMap(raw, ANY_KNOWN_PLAYER);
    expect(deriveDraftBoardState(draft, [], [], historical).availablePlayers).toHaveLength(2);
  });

  it('keeps a drafted but ineligible player resolvable, so the board can name him', () => {
    const withRetired = buildCanonicalPlayerMap({
      '901': { player_id: '901', full_name: 'Retired Kicker', position: 'K', team: null },
      '100': { player_id: '100', full_name: 'Current Starter', position: 'WR', team: 'TST' },
    });
    const picks: SleeperDraftPick[] = [
      {
        player_id: '901',
        picked_by: 'user-1',
        roster_id: '1',
        round: 1,
        draft_slot: 1,
        pick_no: 1,
        metadata: { first_name: 'Retired', last_name: 'Kicker' },
      },
    ];
    const board = deriveDraftBoardState(draft, picks, [], withRetired);
    expect(board.unavailableSleeperIds.has('901')).toBe(true);
    expect(board.availablePlayers.map((player) => player.name)).toEqual(['Current Starter']);
    expect(withRetired.bySleeperId.get('901')?.name).toBe('Retired Kicker');
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
