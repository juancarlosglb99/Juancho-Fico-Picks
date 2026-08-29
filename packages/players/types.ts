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
  /**
   * Whether this player can be selected in a draft happening now.
   *
   * Sleeper's player endpoint is a permanent archive, not a current roster: it
   * returns every player it has ever known, and neither of the two fields that
   * look like they answer this question actually does. See
   * `isCurrentNflPlayer` for what does.
   *
   * Kept on the player rather than applied by deleting him, because a draft
   * board still has to render the name of somebody another team selected.
   */
  draftEligible: boolean;
  age: number | null;
  yearsExperience: number | null;
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
