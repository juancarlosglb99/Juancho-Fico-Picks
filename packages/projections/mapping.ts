import { normalizePlayerName } from '../players/player-map';
import type { CanonicalPlayer, CanonicalPlayerMap } from '../players/types';
import type {
  MappedProjection,
  ProjectionMappingResult,
  ProjectionRecord,
  UnmatchedProjection,
} from './types';

function mapped(
  record: ProjectionRecord,
  player: CanonicalPlayer,
  method: MappedProjection['matchMethod'],
): MappedProjection {
  const confidence =
    method === 'sleeper-id' ? 1 : method === 'name-position' ? 0.95 : 0.8;
  return {
    ...record,
    playerId: player.id,
    matchMethod: method,
    matchConfidence: confidence,
  };
}

export function mapProjectionRecords(
  records: ProjectionRecord[],
  playerMap: CanonicalPlayerMap,
): ProjectionMappingResult {
  const result: ProjectionMappingResult = { mapped: [], unmatched: [] };

  for (const record of records) {
    if (record.sleeperId) {
      const player = playerMap.bySleeperId.get(record.sleeperId);
      if (player) {
        result.mapped.push(mapped(record, player, 'sleeper-id'));
        continue;
      }
    }

    const normalizedName = normalizePlayerName(record.playerName);
    const positionMatches = playerMap.byNameAndPosition.get(
      `${normalizedName}|${record.position}`,
    );
    if (positionMatches?.length === 1) {
      result.mapped.push(mapped(record, positionMatches[0], 'name-position'));
      continue;
    }

    const nameMatches = playerMap.byName.get(normalizedName);
    if (nameMatches?.length === 1) {
      result.mapped.push(mapped(record, nameMatches[0], 'unique-name'));
      continue;
    }

    const reason: UnmatchedProjection['reason'] =
      nameMatches && nameMatches.length > 1
        ? 'ambiguous-name'
        : 'player-not-found';
    result.unmatched.push({ ...record, reason });
  }

  return result;
}
