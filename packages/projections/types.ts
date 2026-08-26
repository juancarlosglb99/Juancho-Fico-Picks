import type { Position } from '../players/types';

export type AdpFormat =
  | 'redraft_1qb'
  | 'redraft_superflex'
  | 'dynasty_startup'
  | 'dynasty_rookie'
  | 'unknown';

export interface ProjectionStatLine {
  passingYards?: number;
  passingTouchdowns?: number;
  interceptions?: number;
  rushingYards?: number;
  rushingTouchdowns?: number;
  receptions?: number;
  receivingYards?: number;
  receivingTouchdowns?: number;
  fumblesLost?: number;
}

export interface ProjectionRecord {
  sourceRow: number;
  playerName: string;
  sleeperId?: string;
  position: Position;
  team?: string | null;
  projection: number;
  /** Legacy CSV fields are accepted, but automatic market/ranking providers win. */
  adp?: number;
  rank?: number;
  adpFormat?: AdpFormat;
  projectionScoring?: string;
  stats?: ProjectionStatLine;
}

export interface MappedProjection extends ProjectionRecord {
  playerId: string;
  matchMethod: 'sleeper-id' | 'name-position' | 'unique-name';
  matchConfidence: 1 | 0.95 | 0.8;
  projectionSource?: string;
  projectionFetchedAt?: string;
  projectionSourceUpdatedAt?: string | null;
  projectionSourceConfidence?: 'high' | 'medium' | 'low';
  adpSource?: string;
  adpFetchedAt?: string;
  adpSourceUpdatedAt?: string | null;
  adpTeams?: number;
  adpScoringFormat?: string;
  adpSampleSize?: number | null;
  adpSourceConfidence?: 'high' | 'medium' | 'low';
  adpMatchLevel?: 'exact' | 'approximate' | 'weak';
  adpMatchReasons?: string[];
}

export interface UnmatchedProjection extends ProjectionRecord {
  reason: 'player-not-found' | 'ambiguous-name';
}

export interface ProjectionMappingResult {
  mapped: MappedProjection[];
  unmatched: UnmatchedProjection[];
}

export interface ProjectionProvider {
  readonly id: string;
  readonly label: string;
  getRecords(): Promise<ProjectionRecord[]>;
}

export class ProjectionCsvError extends Error {
  constructor(
    message: string,
    readonly row?: number,
  ) {
    super(message);
    this.name = 'ProjectionCsvError';
  }
}
