import type { Position } from '../players/types';

export type DynastyValueFormat = 'startup' | 'rookie_supplemental';

export interface DynastyValueRecord {
  playerName: string;
  sleeperId?: string;
  position: Position;
  value: number;
  format: DynastyValueFormat;
  age?: number;
  horizonYears?: number;
  sourceLabel: string;
}

export interface DynastyValueProvider {
  readonly id: string;
  readonly label: string;
  readonly formats: DynastyValueFormat[];
  getValues(): Promise<DynastyValueRecord[]>;
}

export class DynastyValueUnavailableError extends Error {
  constructor(message = 'A legitimate dynasty value source has not been configured.') {
    super(message);
    this.name = 'DynastyValueUnavailableError';
  }
}
