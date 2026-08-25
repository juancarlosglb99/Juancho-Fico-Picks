export type SleeperLeagueStatus =
  | 'pre_draft'
  | 'drafting'
  | 'in_season'
  | 'complete';

export interface SleeperUser {
  user_id: string;
  username: string | null;
  display_name: string | null;
  avatar: string | null;
}

export interface SleeperNflState {
  season: string;
  league_season: string;
  display_week: number;
  week: number;
  season_type: string;
}

export interface SleeperLeague {
  league_id: string;
  name: string;
  season: string;
  status: SleeperLeagueStatus;
  total_rosters: number;
  draft_id: string | null;
  avatar: string | null;
  scoring_settings: Record<string, number> | null;
  roster_positions: string[];
  settings: Record<string, number | null>;
  metadata?: Record<string, string | null> | null;
  previous_league_id?: string | null;
}

export interface SleeperRoster {
  roster_id: number;
  owner_id: string | null;
  players: string[] | null;
  starters: string[] | null;
  reserve: string[] | null;
  settings: {
    wins?: number;
    losses?: number;
    ties?: number;
    fpts?: number;
    fpts_decimal?: number;
    waiver_position?: number;
    waiver_budget_used?: number;
    total_moves?: number;
  } | null;
}

export interface SleeperLeagueUser {
  user_id: string;
  username: string | null;
  display_name: string | null;
  avatar: string | null;
  metadata: {
    team_name?: string;
  } | null;
}

export interface SleeperDraft {
  draft_id: string;
  league_id: string | null;
  status: 'pre_draft' | 'drafting' | 'paused' | 'complete';
  type: 'snake' | 'linear' | 'auction' | string;
  season: string;
  start_time: number | null;
  last_picked: number | null;
  settings: {
    teams?: number;
    rounds?: number;
    pick_timer?: number;
    slots_qb?: number;
    slots_rb?: number;
    slots_wr?: number;
    slots_te?: number;
    slots_flex?: number;
    slots_wrrb_flex?: number;
    slots_super_flex?: number;
    slots_bn?: number;
    slots_k?: number;
    slots_def?: number;
    player_type?: number;
    reversal_round?: number;
    [key: string]: number | undefined;
  };
  metadata: {
    name?: string;
    description?: string;
    scoring_type?: string;
    league_type?: string;
    [key: string]: string | undefined;
  };
  draft_order: Record<string, number> | null;
  slot_to_roster_id: Record<string, number> | null;
}

export interface SleeperDraftPick {
  player_id: string;
  picked_by: string;
  roster_id: string;
  round: number;
  draft_slot: number;
  pick_no: number;
  metadata: {
    first_name?: string;
    last_name?: string;
    position?: string;
    team?: string;
  };
  is_keeper?: boolean | null;
  draft_id?: string;
}

export interface SleeperTradedPick {
  season: string;
  round: number;
  roster_id: number;
  previous_owner_id: number;
  owner_id: number;
  draft_id?: string;
}

export interface SleeperPlayerRaw {
  player_id: string;
  full_name?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  position?: string | null;
  fantasy_positions?: string[] | null;
  team?: string | null;
  status?: string | null;
  search_rank?: number | null;
  age?: number | null;
  years_exp?: number | null;
  gsis_id?: string | null;
  espn_id?: string | number | null;
  pfr_id?: string | null;
}

export type SleeperPlayersResponse = Record<string, SleeperPlayerRaw>;

export interface LeagueRosterView {
  roster: SleeperRoster;
  owner: SleeperLeagueUser | null;
  displayName: string;
  teamName: string;
}
