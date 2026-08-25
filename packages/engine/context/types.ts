import type { Position } from '../../players/types';
import type { SleeperTradedPick } from '../../sleeper/types';
import type { NormalizedDraftType } from '../draft/next-pick-probability';

export type Confidence = 'high' | 'medium' | 'low';

export interface ContextValue<T> {
  value: T;
  source: string;
  confidence: Confidence;
}

export type LeagueType = 'redraft' | 'keeper' | 'dynasty' | 'unknown';
export type DraftContext =
  | 'startup'
  | 'rookie_supplemental'
  | 'veteran_all_player'
  | 'unknown';
export type LineupType = 'classic' | 'best_ball' | 'unknown';
export type ScoringProfile =
  | 'standard'
  | 'half_ppr'
  | 'full_ppr'
  | 'custom'
  | 'unknown';

export interface RosterConfiguration {
  QB: number;
  RB: number;
  WR: number;
  TE: number;
  FLEX: number;
  SUPER_FLEX: number;
  K: number;
  DEF: number;
  bench: number;
  taxi: number;
  IR: number;
  idp: Record<string, number>;
  unknown: Record<string, number>;
  totalStarterSpots: number;
}

export interface NormalizedScoring {
  settings: Record<string, number>;
  profile: ScoringProfile;
  reception: {
    base: number;
    byPosition: Record<'RB' | 'WR' | 'TE', number>;
  };
  passing: {
    yards: number;
    touchdowns: number;
    interceptions: number;
  };
  rushing: { yards: number; touchdowns: number };
  receiving: { yards: number; touchdowns: number };
  tePremium: number;
  bonuses: Record<string, number>;
}

export interface KeeperSettings {
  detected: boolean;
  rulesFullyKnown: boolean;
  numberOfKeepers: number | null;
  acquisitionCost: string | null;
  roundPenalty: number | null;
  maxYearsRetained: number | null;
  escalatingCost: string | null;
  auctionKeeperPrice: number | null;
  otherRules: string | null;
}

export interface DraftSelectionContext {
  overallPick: number;
  round: number;
  draftSlot: number;
  originalRosterId: number | null;
  ownerRosterId: number | null;
}

export interface NormalizedDraftState {
  rounds: number;
  currentPick: number;
  currentRound: number;
  userDraftSlot: number | null;
  userRosterId: number | null;
  currentSelection: DraftSelectionContext | null;
  isUserOnClock: boolean;
  nextUserPick: number | null;
  picksBeforeNextSelection: number | null;
  interveningSelections: DraftSelectionContext[];
  draftedPlayerIds: string[];
  keeperPlayerIds: string[];
  tradedPicks: SleeperTradedPick[];
  slotToRosterId: Record<string, number>;
}

export interface LeagueContext {
  leagueType: ContextValue<LeagueType>;
  draftContext: ContextValue<DraftContext>;
  draftType: ContextValue<NormalizedDraftType>;
  lineupType: ContextValue<LineupType>;
  teams: ContextValue<number>;
  roster: ContextValue<RosterConfiguration>;
  scoring: ContextValue<NormalizedScoring>;
  keeperSettings: ContextValue<KeeperSettings>;
  draftState: ContextValue<NormalizedDraftState>;
  warnings: string[];
}

export interface LeagueContextOverrides {
  leagueType?: LeagueType;
  draftContext?: DraftContext;
  draftType?: NormalizedDraftType;
  lineupType?: LineupType;
  keeperSettings?: Partial<KeeperSettings>;
}

export type StarterPosition = Extract<Position, 'QB' | 'RB' | 'WR' | 'TE' | 'K' | 'DEF'>;
