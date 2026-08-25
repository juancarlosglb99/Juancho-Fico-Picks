export type Position =
  | 'QB'
  | 'RB'
  | 'WR'
  | 'TE'
  | 'K'
  | 'DEF'
  | 'DL'
  | 'LB'
  | 'DB'
  | 'UNKNOWN';

export interface CanonicalPlayer {
  id: string;
  name: string;
  normalizedName: string;
  position: Position;
  team: string | null;
  status: string | null;
  externalIds: {
    sleeper?: string;
    gsis?: string;
    espn?: string;
    pfr?: string;
  };
}

export interface CanonicalPlayerMap {
  players: CanonicalPlayer[];
  byId: Map<string, CanonicalPlayer>;
  bySleeperId: Map<string, CanonicalPlayer>;
  byNameAndPosition: Map<string, CanonicalPlayer[]>;
  byName: Map<string, CanonicalPlayer[]>;
}
