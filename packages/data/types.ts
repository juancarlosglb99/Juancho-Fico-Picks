import type { LeagueContext, ScoringProfile } from '../engine/context/types';
import type { Position } from '../players/types';
import type {
  AdpFormat,
  MappedProjection,
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
