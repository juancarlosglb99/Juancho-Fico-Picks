import type { Position } from '../players/types';

export interface ProjectionRecord {
  sourceRow: number;
  playerName: string;
  sleeperId?: string;
  position: Position;
  projection: number;
  adp: number;
  rank: number;
}

export interface MappedProjection extends ProjectionRecord {
  playerId: string;
  matchMethod: 'sleeper-id' | 'name-position' | 'unique-name';
  matchConfidence: 1 | 0.95 | 0.8;
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
