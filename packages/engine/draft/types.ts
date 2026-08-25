import type { CanonicalPlayer } from '../../players/types';

export interface DraftBoardState {
  teams: number;
  rounds: number;
  picksMade: number;
  currentOverallPick: number;
  currentRound: number;
  pickInRound: number;
  draftedSleeperIds: Set<string>;
  unavailableSleeperIds: Set<string>;
  availablePlayers: CanonicalPlayer[];
}
