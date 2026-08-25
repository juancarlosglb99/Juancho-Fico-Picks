import type { Position } from '../../players/types';
import type { MappedProjection } from '../../projections/types';
import { median, round } from './math';

export interface ProjectionTier {
  tier: number;
  tierSize: number;
  gapAfterTier: number;
}

export function buildProjectionTiers(
  projections: MappedProjection[],
): Map<string, ProjectionTier> {
  const byPosition = new Map<Position, MappedProjection[]>();
  for (const projection of projections) {
    byPosition.set(projection.position, [
      ...(byPosition.get(projection.position) ?? []),
      projection,
    ]);
  }

  const result = new Map<string, ProjectionTier>();
  for (const positionProjections of byPosition.values()) {
    const sorted = [...positionProjections].sort(
      (a, b) => b.projection - a.projection,
    );
    const positiveGaps = sorted
      .slice(0, -1)
      .map((projection, index) =>
        Math.max(0, projection.projection - sorted[index + 1].projection),
      )
      .filter((gap) => gap > 0);
    const threshold = Math.max(2, median(positiveGaps) * 2.25);

    let tier = 1;
    const tierMembers = new Map<number, MappedProjection[]>();
    sorted.forEach((projection, index) => {
      tierMembers.set(tier, [...(tierMembers.get(tier) ?? []), projection]);
      const next = sorted[index + 1];
      if (next && projection.projection - next.projection >= threshold) tier += 1;
    });

    const tierNumbers = [...tierMembers.keys()].sort((a, b) => a - b);
    for (const tierNumber of tierNumbers) {
      const members = tierMembers.get(tierNumber) ?? [];
      const nextTier = tierMembers.get(tierNumber + 1) ?? [];
      const floor = Math.min(...members.map((member) => member.projection));
      const nextCeiling =
        nextTier.length > 0
          ? Math.max(...nextTier.map((member) => member.projection))
          : floor;
      const gapAfterTier = round(Math.max(0, floor - nextCeiling), 1);
      for (const member of members) {
        result.set(member.playerId, {
          tier: tierNumber,
          tierSize: members.length,
          gapAfterTier,
        });
      }
    }
  }

  return result;
}
