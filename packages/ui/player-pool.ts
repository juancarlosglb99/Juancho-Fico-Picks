/**
 * The available-player table.
 *
 * Every column here is a number the engine already computed for its own
 * purposes; nothing is calculated for display. That is deliberate - the table
 * and the recommendation must never be able to disagree about a player, and the
 * only way to guarantee that is for both to read the same accessor.
 *
 * What it deliberately does NOT show is the fifteen-field model inspector. A
 * drafter with forty seconds needs rank, points, tier, whether the player
 * survives, and whether he fits; the rest belongs in the drawer, one click away.
 */
import type { DraftRecommendationResult } from '../engine/draft/types';
import type { NeedLevel } from '../engine/draft/roster-state';
import type { Confidence } from '../engine/context/types';
import type { Position } from '../players/types';

export type PoolFilter = 'ALL' | 'QB' | 'RB' | 'WR' | 'TE' | 'FLEX' | 'K' | 'DEF';

export type PoolSort =
  | 'engine'
  | 'first_seed'
  | 'projection'
  | 'survival'
  | 'name';

const FLEX_POSITIONS: Position[] = ['RB', 'WR', 'TE'];

export interface PoolRow {
  playerId: string;
  name: string;
  position: Position;
  team: string | null;
  /** First Seed's published rank for this exact format, when it ranks him. */
  firstSeedRank: number | null;
  /**
   * What a screen shows in the rank column.
   *
   * `#12` from First Seed's overall board, `K4` from the supplemental
   * positional board, or `Unranked` where a kicker exists in Sleeper and on no
   * expert board at all. The two are different units and are never mixed.
   */
  expertRank: { label: string; source: string } | null;
  /** First Seed's projection recalculated for this league's scoring. */
  projectedPoints: number;
  tier: number | null;
  playersRemainingInTier: number;
  survival: number | null;
  survivalConfidence: Confidence;
  /** Juancho's own board position across the whole projected pool. */
  juanchoRank: number | null;
  /** Where the engine ranked him among its recommendations, 1-based. */
  engineRank: number | null;
  /** Whether this player fills something our roster still needs. */
  fit: {
    need: NeedLevel;
    openStartingSlots: number;
    drafted: number;
  };
  /** Set when First Seed's own rank and projection contradict each other. */
  hasDataWarning: boolean;
}

export interface PoolQuery {
  search: string;
  filter: PoolFilter;
  sort: PoolSort;
}

export const DEFAULT_POOL_QUERY: PoolQuery = {
  search: '',
  filter: 'ALL',
  sort: 'engine',
};

/**
 * Every available, projected player - not the shortlist.
 *
 * The engine only fully plans thirty or forty candidates, but it can describe
 * any of them, so the table covers the whole board and the shortlist simply
 * shows up as an `engineRank`.
 */
export function buildPlayerPool(result: DraftRecommendationResult): PoolRow[] {
  const internals = result.internals;
  if (!internals) return [];

  const engineRankById = new Map<string, number>();
  result.recommendations.forEach((recommendation, index) => {
    engineRankById.set(recommendation.player.id, index + 1);
  });

  const rows: PoolRow[] = [];
  for (const candidate of internals.candidatePool) {
    const player = internals.playerOf(candidate.playerId);
    if (!player) continue;
    const survival = internals.survivalOf(candidate.playerId);
    const positionState = internals.rosterState.byPosition[candidate.position];

    rows.push({
      playerId: candidate.playerId,
      name: player.name,
      position: candidate.position,
      team: player.team ?? null,
      firstSeedRank: internals.firstSeedOf(candidate.playerId)?.rank ?? null,
      expertRank: describeExpertRank(internals, candidate.playerId, candidate.position),
      projectedPoints: candidate.projection,
      tier: internals.tierOf(candidate.playerId)?.tier ?? null,
      playersRemainingInTier: internals.playersRemainingInTier(candidate.playerId),
      // Only ever a figure that was actually estimated. See `SurvivalEstimate`.
      survival: survival.modeled ? survival.value : null,
      survivalConfidence: survival.confidence,
      juanchoRank: internals.juanchoBoardRankOf(candidate.playerId) ?? null,
      engineRank: engineRankById.get(candidate.playerId) ?? null,
      fit: {
        need: positionState?.depthNeed ?? 'none',
        openStartingSlots: positionState?.openStartingSlots ?? 0,
        drafted: positionState?.drafted ?? 0,
      },
      hasDataWarning: internals.dataWarningOf(candidate.playerId) !== undefined,
    });
  }
  return rows;
}

function describeExpertRank(
  internals: NonNullable<DraftRecommendationResult['internals']>,
  playerId: string,
  position: Position,
): PoolRow['expertRank'] {
  const firstSeed = internals.firstSeedOf(playerId)?.rank ?? null;
  if (firstSeed !== null) return { label: `${firstSeed}`, source: 'First Seed' };

  const supplemental = internals.supplementalRankOf(playerId);
  if (supplemental) {
    const label = position === 'DEF' ? 'DST' : position;
    return { label: `${label}${supplemental.positionRank}`, source: 'FantasyPros' };
  }
  if (position === 'K' || position === 'DEF') {
    return { label: 'Unranked', source: 'no expert board covers this player' };
  }
  return null;
}

export function filterPool(rows: PoolRow[], query: PoolQuery): PoolRow[] {
  const needle = query.search.trim().toLowerCase();
  const matched = rows.filter((row) => {
    if (!matchesFilter(row.position, query.filter)) return false;
    if (!needle) return true;
    return (
      row.name.toLowerCase().includes(needle) ||
      (row.team ?? '').toLowerCase().includes(needle) ||
      row.position.toLowerCase() === needle
    );
  });
  return sortPool(matched, query.sort);
}

function matchesFilter(position: Position, filter: PoolFilter): boolean {
  if (filter === 'ALL') return true;
  if (filter === 'FLEX') return FLEX_POSITIONS.includes(position);
  return position === filter;
}

export function sortPool(rows: PoolRow[], sort: PoolSort): PoolRow[] {
  const sorted = [...rows];
  switch (sort) {
    case 'first_seed':
      // Unranked is not rank zero. A player First Seed does not rank sorts last.
      sorted.sort((a, b) => rankOf(a.firstSeedRank) - rankOf(b.firstSeedRank));
      break;
    case 'projection':
      sorted.sort((a, b) => b.projectedPoints - a.projectedPoints);
      break;
    case 'survival':
      // Least likely to survive first: that is the order a drafter is asking
      // about when he sorts by this column at all.
      sorted.sort((a, b) => survivalOf(a) - survivalOf(b));
      break;
    case 'name':
      sorted.sort((a, b) => a.name.localeCompare(b.name));
      break;
    case 'engine':
    default:
      /*
       * The engine's shortlist first, in its own order, then the rest of the
       * board by First Seed. Anything else buries the recommendation's
       * alternatives under two hundred players nobody is considering.
       */
      sorted.sort((a, b) => {
        const engineGap = rankOf(a.engineRank) - rankOf(b.engineRank);
        if (engineGap !== 0) return engineGap;
        return rankOf(a.firstSeedRank) - rankOf(b.firstSeedRank);
      });
      break;
  }
  return sorted;
}

function rankOf(rank: number | null): number {
  return rank === null ? Number.MAX_SAFE_INTEGER : rank;
}

function survivalOf(row: PoolRow): number {
  return row.survival === null ? Number.MAX_SAFE_INTEGER : row.survival;
}

/** How many rows a filter would show, for the counts on the filter chips. */
export function countByFilter(rows: PoolRow[]): Record<PoolFilter, number> {
  const counts: Record<PoolFilter, number> = {
    ALL: rows.length,
    QB: 0,
    RB: 0,
    WR: 0,
    TE: 0,
    FLEX: 0,
    K: 0,
    DEF: 0,
  };
  for (const row of rows) {
    if (row.position in counts) {
      counts[row.position as PoolFilter] += 1;
    }
    if (FLEX_POSITIONS.includes(row.position)) counts.FLEX += 1;
  }
  return counts;
}
