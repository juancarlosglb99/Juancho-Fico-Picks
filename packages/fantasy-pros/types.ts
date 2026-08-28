/**
 * A supplemental ranking source, deliberately narrow.
 *
 * First Seed publishes quarterbacks, backs, receivers and tight ends and
 * nothing else, which left kickers and defenses with no ordering at all - the
 * engine offered whichever six happened to sort first alphabetically, so it
 * recommended the same kicker in every draft forever.
 *
 * This exists to supply that missing order, and ONLY that. The type carries the
 * positions the source is allowed to speak about so the restriction is enforced
 * rather than remembered: a FantasyPros receiver ranking must never reach the
 * scoring that First Seed owns, because blending two boards is precisely the
 * kind of quiet averaging this codebase keeps First Seed and Juancho apart to
 * avoid.
 *
 * There are no projections here, because the file has none. A rank is an
 * ordering; inventing points from it would be manufacturing evidence.
 */
import type { ResolutionSummary, SourceProvenance } from '../data/types';
import type { Position } from '../players/types';

/** The only positions a supplemental source is permitted to cover. */
export const SUPPLEMENTAL_POSITIONS: Position[] = ['K', 'DEF'];

export interface SupplementalRankingRecord {
  /** Canonical id, once mapped to Sleeper's current player universe. */
  playerId: string;
  sleeperId: string;
  /** The name as the source publishes it, kept for attribution and debugging. */
  sourceName: string;
  /** The name Sleeper uses, which is what a screen shows. */
  name: string;
  team: string | null;
  position: Position;
  /** Rank within the position, 1-based: `K1` is 1. */
  positionRank: number;
  /** Rank across the source's whole board. */
  overallRank: number;
}

export interface UnresolvedSupplementalRecord {
  sourceName: string;
  team: string | null;
  position: string;
  reason: 'no-sleeper-match' | 'ineligible' | 'unsupported-position';
}

export interface SupplementalRankingSnapshot {
  kind: 'supplemental-ranking';
  provenance: SourceProvenance;
  season: string;
  /** Which positions this snapshot is allowed to order. */
  positions: Position[];
  records: SupplementalRankingRecord[];
  unresolved: UnresolvedSupplementalRecord[];
  resolution: ResolutionSummary;
}

export function isSupplementalRankingSnapshot(
  value: unknown,
): value is SupplementalRankingSnapshot {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<SupplementalRankingSnapshot>;
  return (
    candidate.kind === 'supplemental-ranking' &&
    Array.isArray(candidate.records) &&
    Array.isArray(candidate.positions)
  );
}
