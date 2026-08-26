import type { Position } from '../../players/types';

export const OPPONENT_MODEL_VERSION = 'market-opponent-2026.1';
export const MONTE_CARLO_MODEL_VERSION = 'draft-continuation-2026.1';

export type OpponentArchetype =
  | 'room_rank_follower'
  | 'market_follower'
  | 'roster_builder'
  | 'positional_runner'
  | 'balanced';

export interface SimulatedPick {
  overallPick: number;
  rosterId: number | null;
  playerId: string;
  position: Position;
  archetype: OpponentArchetype | 'juancho';
}

export interface MockDraftResult {
  modelVersion: string;
  seed: number;
  picks: SimulatedPick[];
  userPlayerIds: string[];
  rosterScore: number;
}

export interface CandidateSimulationResult {
  playerId: string;
  simulations: number;
  availableNextPickProbability: number | null;
  averageRosterScore: number;
  rosterScoreP25: number;
  rosterScoreP75: number;
}

export interface MonteCarloComparison {
  modelVersion: string;
  opponentModelVersion: string;
  simulationsPerCandidate: number;
  candidates: CandidateSimulationResult[];
}
