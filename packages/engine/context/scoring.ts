import type { Position } from '../../players/types';
import type { ProjectionRecord, ProjectionStatLine } from '../../projections/types';
import type { NormalizedScoring } from './types';
import { round } from '../draft/math';

export interface ScoredProjection {
  points: number;
  adjustedForLeagueScoring: boolean;
  source: 'league-scored-stat-line' | 'provider-aggregate';
  limitations: string[];
}

function hasNumbers(stats: ProjectionStatLine, fields: Array<keyof ProjectionStatLine>) {
  return fields.every((field) => typeof stats[field] === 'number');
}

function sufficientStatLine(position: Position, stats?: ProjectionStatLine): boolean {
  if (!stats) return false;
  if (position === 'QB') {
    return hasNumbers(stats, [
      'passingYards',
      'passingTouchdowns',
      'interceptions',
      'rushingYards',
      'rushingTouchdowns',
      'fumblesLost',
    ]);
  }
  if (position === 'RB' || position === 'WR' || position === 'TE') {
    return hasNumbers(stats, [
      'rushingYards',
      'rushingTouchdowns',
      'receptions',
      'receivingYards',
      'receivingTouchdowns',
      'fumblesLost',
    ]);
  }
  return false;
}

export function scoreProjectionForLeague(
  projection: ProjectionRecord,
  scoring: NormalizedScoring,
): ScoredProjection {
  if (!sufficientStatLine(projection.position, projection.stats)) {
    return {
      points: projection.projection,
      adjustedForLeagueScoring: false,
      source: 'provider-aggregate',
      limitations: [
        'The CSV supplies aggregate fantasy points without a complete stat line, so custom scoring cannot be recalculated.',
      ],
    };
  }

  const stats = projection.stats ?? {};
  const receptionValue =
    projection.position === 'TE'
      ? scoring.reception.byPosition.TE
      : projection.position === 'WR'
        ? scoring.reception.byPosition.WR
        : scoring.reception.byPosition.RB;
  const points =
    (stats.passingYards ?? 0) * scoring.passing.yards +
    (stats.passingTouchdowns ?? 0) * scoring.passing.touchdowns +
    (stats.interceptions ?? 0) * scoring.passing.interceptions +
    (stats.rushingYards ?? 0) * scoring.rushing.yards +
    (stats.rushingTouchdowns ?? 0) * scoring.rushing.touchdowns +
    (stats.receptions ?? 0) * receptionValue +
    (stats.receivingYards ?? 0) * scoring.receiving.yards +
    (stats.receivingTouchdowns ?? 0) * scoring.receiving.touchdowns +
    (stats.fumblesLost ?? 0) * (scoring.settings.fum_lost ?? -2);
  const limitations =
    Object.keys(scoring.bonuses).length > 0
      ? [
          `Sleeper scoring rules ${Object.keys(scoring.bonuses).join(', ')} are detected but require matching event-count projections to calculate.`,
        ]
      : [];
  return {
    points: round(points, 1),
    adjustedForLeagueScoring: true,
    source: 'league-scored-stat-line',
    limitations,
  };
}
