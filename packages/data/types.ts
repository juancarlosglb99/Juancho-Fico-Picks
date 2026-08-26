import type { LeagueContext, ScoringProfile } from '../engine/context/types';
import type { Position } from '../players/types';
import type {
  AdpFormat,
  MappedProjection,
  ProjectionRecord,
  UnmatchedProjection,
} from '../projections/types';

export type SourceConfidence = 'high' | 'medium' | 'low';
export type DataFreshness = 'fresh' | 'aging' | 'stale';
export type DataMatchLevel = 'exact' | 'approximate' | 'weak';
export type CacheDisposition = 'network' | 'fresh_cache' | 'fallback_cache';

export interface SourceProvenance {
  sourceId: string;
  sourceLabel: string;
  season: string;
  fetchedAt: string;
  sourceUpdatedAt: string | null;
  sourceConfidence: SourceConfidence;
  attributionLabel?: string;
  attributionUrl?: string;
}

export interface ResolutionSummary {
  total: number;
  matched: number;
  directExternalId: number;
  exactCanonical: number;
  normalizedName: number;
  ambiguous: number;
  unresolved: number;
}

export type AdpQbFormat = '1qb' | 'superflex';

export interface AdpSourceContext {
  leagueFormat: AdpFormat;
  qbFormat: AdpQbFormat;
  scoringFormat: ScoringProfile;
  teams: number;
  sampleSize: number | null;
}

export interface RawAdpRecord {
  providerPlayerId?: string;
  sleeperId?: string;
  playerName: string;
  position: Position;
  team: string | null;
  adp: number;
  rank: number;
  sampleSize: number | null;
  standardDeviation: number | null;
}

export interface AdpSourceSnapshot {
  kind: 'adp-source';
  provenance: SourceProvenance;
  context: AdpSourceContext;
  records: RawAdpRecord[];
}

export type PlayerResolutionMethod =
  | 'direct-external-id'
  | 'canonical-team-defense'
  | 'exact-name-position'
  | 'normalized-unique-name';

export interface MappedAdpRecord extends RawAdpRecord {
  playerId: string;
  resolutionMethod: PlayerResolutionMethod;
  resolutionConfidence: 1 | 0.95 | 0.8;
}

export interface UnresolvedAdpRecord extends RawAdpRecord {
  reason: 'ambiguous-name' | 'player-not-found';
}

export interface FormatCompatibility {
  level: DataMatchLevel;
  confidence: SourceConfidence;
  reasons: string[];
}

export interface AdpSnapshot {
  kind: 'adp';
  provenance: SourceProvenance;
  context: AdpSourceContext;
  records: MappedAdpRecord[];
  unresolved: UnresolvedAdpRecord[];
  resolution: ResolutionSummary;
  compatibility: FormatCompatibility;
}

export interface ProjectionSnapshot {
  kind: 'projection';
  provenance: SourceProvenance;
  filename: string;
  scoringFormat: ScoringProfile;
  records: MappedProjection[];
  unmatched: UnmatchedProjection[];
  resolution: ResolutionSummary;
  completeStatLines: number;
}

export interface ProjectionSourceSnapshot {
  kind: 'projection-source';
  provenance: SourceProvenance;
  sheet: string;
  scoringFormat: ScoringProfile;
  records: ProjectionRecord[];
}

export type DraftRoomPlatform = 'sleeper' | 'espn' | 'yahoo' | 'cbs';

export interface DraftRoomRankingContext {
  platform: DraftRoomPlatform;
  scoringFormat: ScoringProfile;
  qbFormat: AdpQbFormat;
  sheet: string;
}

export interface RawDraftRoomRankingRecord {
  sourceRow: number;
  playerName: string;
  position: Position;
  team: string | null;
  rank: number;
  /** Upstream-derived fields retained as provenance, never treated as Juancho ranks. */
  upstreamMarketAdp: number | null;
  upstreamExpertRank: number | null;
  firstSeedValueDelta: number | null;
  firstSeedLandmineScore: number | null;
}

export interface DraftRoomRankingSourceSnapshot {
  kind: 'draft-room-ranking-source';
  provenance: SourceProvenance;
  context: DraftRoomRankingContext;
  records: RawDraftRoomRankingRecord[];
}

export interface MappedDraftRoomRankingRecord extends RawDraftRoomRankingRecord {
  playerId: string;
  resolutionMethod: PlayerResolutionMethod;
  resolutionConfidence: 1 | 0.95 | 0.8;
}

export interface UnresolvedDraftRoomRankingRecord extends RawDraftRoomRankingRecord {
  reason: 'ambiguous-name' | 'player-not-found';
}

export interface DraftRoomRankingSnapshot {
  kind: 'draft-room-ranking';
  provenance: SourceProvenance;
  context: DraftRoomRankingContext;
  records: MappedDraftRoomRankingRecord[];
  unresolved: UnresolvedDraftRoomRankingRecord[];
  resolution: ResolutionSummary;
  compatibility: FormatCompatibility;
}

export type PlayerSignalType =
  | 'injury'
  | 'role'
  | 'depth_chart'
  | 'riser'
  | 'faller'
  | 'value'
  | 'risk'
  | 'market_movement'
  | 'other';

export interface PlayerSignal {
  playerId: string;
  type: PlayerSignalType;
  observedAt: string;
  source: string;
  sourceUrl: string;
  summary: string;
  confidence: SourceConfidence;
}

export interface PlayerSignalSnapshot {
  kind: 'player-signals';
  provenance: SourceProvenance;
  records: PlayerSignal[];
}

export interface PlayerSignalProvider {
  readonly id: string;
  readonly label: string;
  getSnapshot(): Promise<PlayerSignalSnapshot>;
}

export interface ProjectionSnapshotProvider {
  readonly id: string;
  readonly label: string;
  getSnapshot(): Promise<ProjectionSnapshot>;
}

export interface AdpProviderRequest {
  season: string;
  teams: number;
  format: 'standard' | 'half-ppr' | 'ppr' | '2qb';
}

export interface AdpProvider {
  readonly id: string;
  readonly label: string;
  getSnapshot(request: AdpProviderRequest): Promise<AdpSourceSnapshot>;
}

export interface ProjectionConsensusProvider {
  readonly providers: ProjectionSnapshotProvider[];
  getSnapshots(): Promise<ProjectionSnapshot[]>;
}

export interface AdpConsensusProvider {
  readonly providers: AdpProvider[];
  getSnapshots(request: AdpProviderRequest): Promise<AdpSourceSnapshot[]>;
}

export interface AutomaticAdpPlan {
  request: AdpProviderRequest;
  expectedLeagueFormat: AdpFormat;
  notes: string[];
}

export interface DraftDataCompatibilityInput {
  snapshot: AdpSourceSnapshot;
  context: LeagueContext;
  now?: Date;
}
