import { normalizeLeagueContext } from '../../packages/engine/context/normalize';
import type { LeagueContextOverrides } from '../../packages/engine/context/types';
import { deriveDraftBoardState } from '../../packages/engine/draft/state';
import { buildCanonicalPlayerMap } from '../../packages/players/player-map';
import type { CanonicalPlayerMap, Position } from '../../packages/players/types';
import type { AdpFormat, MappedProjection } from '../../packages/projections/types';
import type {
  SleeperDraft,
  SleeperDraftPick,
  SleeperLeague,
  SleeperPlayersResponse,
  SleeperRoster,
  SleeperTradedPick,
} from '../../packages/sleeper/types';

export function makeLeague({
  teams = 12,
  type = 0,
  rosterPositions = [
    'QB',
    'RB',
    'RB',
    'WR',
    'WR',
    'TE',
    'FLEX',
    'BN',
    'BN',
    'BN',
    'BN',
    'BN',
    'BN',
  ],
  scoring = {
    rec: 0,
    pass_yd: 0.04,
    pass_td: 4,
    pass_int: -2,
    rush_yd: 0.1,
    rush_td: 6,
    rec_yd: 0.1,
    rec_td: 6,
  },
  settings = {},
}: {
  teams?: number;
  type?: number;
  rosterPositions?: string[];
  scoring?: Record<string, number> | null;
  settings?: Record<string, number | null>;
} = {}): SleeperLeague {
  return {
    league_id: 'league-1',
    name: 'Synthetic League',
    season: '2026',
    status: 'pre_draft',
    total_rosters: teams,
    draft_id: 'draft-1',
    avatar: null,
    scoring_settings: scoring,
    roster_positions: rosterPositions,
    settings: { type, num_teams: teams, best_ball: 0, ...settings },
    previous_league_id: type === 2 ? 'previous-league' : null,
  };
}

export function makeDraft({
  teams = 12,
  rounds = 16,
  type = 'snake',
  name = 'Synthetic Draft',
  settings = {},
}: {
  teams?: number;
  rounds?: number;
  type?: string;
  name?: string;
  settings?: Record<string, number>;
} = {}): SleeperDraft {
  const draftOrder = Object.fromEntries(
    Array.from({ length: teams }, (_, index) => [`user-${index + 1}`, index + 1]),
  );
  const slotToRoster = Object.fromEntries(
    Array.from({ length: teams }, (_, index) => [String(index + 1), index + 1]),
  );
  return {
    draft_id: 'draft-1',
    league_id: 'league-1',
    status: 'drafting',
    type,
    season: '2026',
    start_time: null,
    last_picked: null,
    settings: {
      teams,
      rounds,
      slots_qb: 1,
      slots_rb: 2,
      slots_wr: 2,
      slots_te: 1,
      slots_flex: 1,
      slots_bn: 6,
      ...settings,
    },
    metadata: { name },
    draft_order: draftOrder,
    slot_to_roster_id: slotToRoster,
  };
}

export function makeRosters(
  teams = 12,
  playersByRoster: Record<number, string[]> = {},
): SleeperRoster[] {
  return Array.from({ length: teams }, (_, index) => {
    const rosterId = index + 1;
    return {
      roster_id: rosterId,
      owner_id: `user-${rosterId}`,
      players: playersByRoster[rosterId] ?? [],
      starters: [],
      reserve: [],
      settings: null,
    };
  });
}

export function makePlayerPool(countPerPosition = 40): CanonicalPlayerMap {
  const raw: SleeperPlayersResponse = {};
  const positions: Position[] = ['QB', 'RB', 'WR', 'TE'];
  let id = 1;
  for (const position of positions) {
    for (let index = 0; index < countPerPosition; index += 1) {
      raw[String(id)] = {
        player_id: String(id),
        full_name: `${position} Player ${index + 1}`,
        position,
        team: 'TST',
        years_exp: index < 4 ? 0 : 3,
        age: index < 4 ? 22 : 26,
      };
      id += 1;
    }
  }
  return buildCanonicalPlayerMap(raw);
}

export function makeProjections(
  players: CanonicalPlayerMap,
  adpFormat: AdpFormat = 'redraft_1qb',
  projectionScoring = 'standard',
): MappedProjection[] {
  const base: Record<Position, number> = {
    QB: 380,
    RB: 330,
    WR: 320,
    TE: 275,
    K: 150,
    DEF: 150,
    DL: 150,
    LB: 150,
    DB: 150,
    UNKNOWN: 0,
  };
  const decline: Record<Position, number> = {
    QB: 7,
    RB: 5,
    WR: 4.5,
    TE: 5,
    K: 2,
    DEF: 2,
    DL: 2,
    LB: 2,
    DB: 2,
    UNKNOWN: 0,
  };
  const positionIndex = new Map<Position, number>();
  return players.players.map((player, overallIndex) => {
    const index = positionIndex.get(player.position) ?? 0;
    positionIndex.set(player.position, index + 1);
    return {
      sourceRow: overallIndex + 2,
      playerName: player.name,
      sleeperId: player.externalIds.sleeper,
      playerId: player.id,
      position: player.position,
      projection: base[player.position] - decline[player.position] * index,
      adp: overallIndex + 1,
      rank: overallIndex + 1,
      adpFormat,
      projectionScoring,
      matchMethod: 'sleeper-id',
      matchConfidence: 1,
    };
  });
}

export function makeContext({
  league,
  draft,
  drafts,
  picks = [],
  tradedPicks = [],
  rosters,
  players,
  overrides,
  userId = 'user-1',
}: {
  league: SleeperLeague;
  draft: SleeperDraft;
  drafts?: SleeperDraft[];
  picks?: SleeperDraftPick[];
  tradedPicks?: SleeperTradedPick[];
  rosters: SleeperRoster[];
  players: CanonicalPlayerMap;
  overrides?: LeagueContextOverrides;
  userId?: string;
}) {
  const board = deriveDraftBoardState(draft, picks, rosters, players);
  return {
    board,
    context: normalizeLeagueContext({
      league,
      draft,
      drafts: drafts ?? [draft],
      picks,
      tradedPicks,
      rosters,
      board,
      userId,
      overrides,
    }),
  };
}
