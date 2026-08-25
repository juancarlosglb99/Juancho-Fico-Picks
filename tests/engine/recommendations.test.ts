import { describe, expect, it } from 'vitest';
import { generateDraftRecommendations } from '../../packages/engine/draft/recommendations';
import { deriveDraftBoardState } from '../../packages/engine/draft/state';
import { DRAFT_SCORE_WEIGHTS } from '../../packages/engine/draft/types';
import { buildCanonicalPlayerMap } from '../../packages/players/player-map';
import type { MappedProjection } from '../../packages/projections/types';
import type {
  SleeperDraft,
  SleeperDraftPick,
  SleeperRoster,
} from '../../packages/sleeper/types';

const rawPlayers = {
  '1': { player_id: '1', full_name: 'Roster Running Back', position: 'RB' },
  '2': { player_id: '2', full_name: 'Other Quarterback', position: 'QB' },
  '3': { player_id: '3', full_name: 'Other Receiver', position: 'WR' },
  '4': { player_id: '4', full_name: 'Other Tight End', position: 'TE' },
  '100': { player_id: '100', full_name: 'Elite Receiver', position: 'WR', team: 'ATL' },
  '101': { player_id: '101', full_name: 'Second Receiver', position: 'WR', team: 'DET' },
  '102': { player_id: '102', full_name: 'Replacement Receiver', position: 'WR', team: 'SEA' },
  '200': { player_id: '200', full_name: 'Strong Running Back', position: 'RB', team: 'BUF' },
  '201': { player_id: '201', full_name: 'Second Running Back', position: 'RB', team: 'GB' },
  '202': { player_id: '202', full_name: 'Replacement Running Back', position: 'RB', team: 'ARI' },
} as const;

const players = buildCanonicalPlayerMap(rawPlayers);

const draft: SleeperDraft = {
  draft_id: 'draft-1',
  league_id: 'league-1',
  status: 'drafting',
  type: 'snake',
  season: '2026',
  start_time: null,
  last_picked: null,
  settings: {
    teams: 4,
    rounds: 10,
    slots_qb: 1,
    slots_rb: 2,
    slots_wr: 2,
    slots_te: 1,
    slots_flex: 1,
  },
  metadata: {},
  draft_order: { 'user-1': 1, 'user-2': 2, 'user-3': 3, 'user-4': 4 },
  slot_to_roster_id: { '1': 1, '2': 2, '3': 3, '4': 4 },
};

const picks: SleeperDraftPick[] = [
  ['1', 'user-1', '1', 'RB'],
  ['2', 'user-2', '2', 'QB'],
  ['3', 'user-3', '3', 'WR'],
  ['4', 'user-4', '4', 'TE'],
].map(([playerId, userId, rosterId, position], index) => ({
  player_id: playerId,
  picked_by: userId,
  roster_id: rosterId,
  round: 1,
  draft_slot: index + 1,
  pick_no: index + 1,
  metadata: { position },
}));

const rosters: SleeperRoster[] = [1, 2, 3, 4].map((rosterId) => ({
  roster_id: rosterId,
  owner_id: `user-${rosterId}`,
  players: rosterId === 1 ? ['1'] : [String(rosterId)],
  starters: [],
  reserve: [],
  settings: null,
}));

function projection(
  sleeperId: string,
  playerName: string,
  position: 'WR' | 'RB',
  points: number,
  adp: number,
  rank: number,
): MappedProjection {
  return {
    sourceRow: rank + 1,
    playerName,
    sleeperId,
    playerId: `jfp:${sleeperId}`,
    position,
    projection: points,
    adp,
    rank,
    matchMethod: 'sleeper-id',
    matchConfidence: 1,
  };
}

const projections = [
  projection('100', 'Elite Receiver', 'WR', 310, 5, 1),
  projection('101', 'Second Receiver', 'WR', 255, 18, 5),
  projection('102', 'Replacement Receiver', 'WR', 205, 50, 20),
  projection('200', 'Strong Running Back', 'RB', 260, 30, 8),
  projection('201', 'Second Running Back', 'RB', 235, 36, 12),
  projection('202', 'Replacement Running Back', 'RB', 200, 55, 24),
];

describe('draft recommendation engine', () => {
  const board = deriveDraftBoardState(draft, picks, rosters, players);
  const result = generateDraftRecommendations({
    draft,
    picks,
    rosters,
    board,
    players,
    projections,
    userId: 'user-1',
  });

  it('finds the user next at the turn of the snake draft', () => {
    expect(result.userDraftSlot).toBe(1);
    expect(result.nextUserPick).toBe(8);
    expect(result.picksUntilNextUserPick).toBe(3);
  });

  it('ranks the elite, urgent receiver first and marks it draft now', () => {
    expect(result.recommendations[0].player.name).toBe('Elite Receiver');
    expect(result.recommendations[0].action).toBe('DRAFT_NOW');
    expect(result.recommendations[0].availableNextPickProbability).toBeLessThan(
      result.recommendations.find((item) => item.player.name === 'Strong Running Back')!
        .availableNextPickProbability,
    );
  });

  it('normalizes every component and applies the published weights', () => {
    const recommendation = result.recommendations[0];
    for (const component of Object.values(recommendation.components)) {
      expect(component).toBeGreaterThanOrEqual(0);
      expect(component).toBeLessThanOrEqual(100);
    }
    const weighted =
      recommendation.components.vorp * DRAFT_SCORE_WEIGHTS.vorp +
      recommendation.components.nextPickRisk * DRAFT_SCORE_WEIGHTS.nextPickRisk +
      recommendation.components.tierUrgency * DRAFT_SCORE_WEIGHTS.tierUrgency +
      recommendation.components.projection * DRAFT_SCORE_WEIGHTS.projection +
      recommendation.components.rosterFit * DRAFT_SCORE_WEIGHTS.rosterFit +
      recommendation.components.adpValue * DRAFT_SCORE_WEIGHTS.adpValue +
      recommendation.components.scarcity * DRAFT_SCORE_WEIGHTS.scarcity;
    expect(recommendation.score).toBeCloseTo(weighted, 1);
  });
});
