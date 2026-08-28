/**
 * Matching a published K/DST board to Sleeper's current players.
 *
 * Two different problems wearing one name. A kicker is a person, matched by
 * name the same way every other source is. A defense is a TEAM, and Sleeper
 * identifies it by abbreviation rather than by anything resembling the string
 * "Houston Texans" - so defenses are matched on the team code, which is exact,
 * and the published name is only ever used for display.
 *
 * Sleeper's eligibility rule applies here too. A ranking source can list a
 * kicker who has since been cut, and the answer is `unresolved` rather than a
 * name on a draft board.
 */
import type { SourceProvenance } from '../data/types';
import { normalizePlayerName } from '../players/player-map';
import type { CanonicalPlayer, CanonicalPlayerMap, Position } from '../players/types';
import type { RawSupplementalRow } from './csv';
import {
  SUPPLEMENTAL_POSITIONS,
  type SupplementalRankingRecord,
  type SupplementalRankingSnapshot,
  type UnresolvedSupplementalRecord,
} from './types';

/**
 * Where the two sources spell a team differently.
 *
 * Deliberately tiny and explicit. A fuzzy team matcher would silently attach a
 * ranking to the wrong defense, which is worse than leaving one unranked.
 */
const TEAM_ALIASES: Record<string, string> = {
  JAC: 'JAX',
  WSH: 'WAS',
  LA: 'LAR',
  OAK: 'LV',
  SD: 'LAC',
  STL: 'LAR',
};

export function normalizeTeam(team: string | null | undefined): string | null {
  if (!team) return null;
  const upper = team.trim().toUpperCase();
  if (!upper) return null;
  return TEAM_ALIASES[upper] ?? upper;
}

export function mapSupplementalRankings({
  rows,
  players,
  provenance,
  season,
}: {
  rows: RawSupplementalRow[];
  players: CanonicalPlayerMap;
  provenance: SourceProvenance;
  season: string;
}): SupplementalRankingSnapshot {
  const records: SupplementalRankingRecord[] = [];
  const unresolved: UnresolvedSupplementalRecord[] = [];
  let directExternalId = 0;
  let exactCanonical = 0;
  let normalizedName = 0;
  let ambiguous = 0;

  for (const row of rows) {
    if (!SUPPLEMENTAL_POSITIONS.includes(row.position)) {
      unresolved.push({ ...row, reason: 'unsupported-position' });
      continue;
    }

    const match =
      row.position === 'DEF'
        ? matchDefense(row, players)
        : matchPlayer(row, players);

    if (match === 'ambiguous') {
      ambiguous += 1;
      unresolved.push({ ...row, reason: 'no-sleeper-match' });
      continue;
    }
    if (!match) {
      unresolved.push({ ...row, reason: 'no-sleeper-match' });
      continue;
    }
    if (!match.player.draftEligible) {
      // Ranked by the source, but Sleeper no longer places him on a team.
      unresolved.push({ ...row, reason: 'ineligible' });
      continue;
    }

    if (match.method === 'team') directExternalId += 1;
    else if (match.method === 'name-and-position') exactCanonical += 1;
    else normalizedName += 1;

    records.push({
      playerId: match.player.id,
      sleeperId: match.player.externalIds.sleeper!,
      sourceName: row.sourceName,
      name: match.player.name,
      team: match.player.team,
      position: row.position,
      positionRank: row.positionRank,
      overallRank: row.overallRank,
    });
  }

  return {
    kind: 'supplemental-ranking',
    provenance,
    season,
    positions: [...SUPPLEMENTAL_POSITIONS],
    records: records.sort(
      (a, b) => a.position.localeCompare(b.position) || a.positionRank - b.positionRank,
    ),
    unresolved,
    resolution: {
      total: rows.length,
      matched: records.length,
      directExternalId,
      exactCanonical,
      normalizedName,
      ambiguous,
      unresolved: unresolved.length,
    },
  };
}

type Match =
  | { player: CanonicalPlayer; method: 'team' | 'name-and-position' | 'name' }
  | 'ambiguous'
  | null;

/** A defense is its team. The abbreviation is exact, so nothing is guessed. */
function matchDefense(row: RawSupplementalRow, players: CanonicalPlayerMap): Match {
  const team = normalizeTeam(row.team);
  if (!team) return null;
  const player = players.bySleeperId.get(team);
  if (player && player.position === 'DEF') return { player, method: 'team' };

  const byTeam = players.players.filter(
    (candidate) => candidate.position === 'DEF' && normalizeTeam(candidate.team) === team,
  );
  if (byTeam.length === 1) return { player: byTeam[0], method: 'team' };
  return byTeam.length > 1 ? 'ambiguous' : null;
}

function matchPlayer(row: RawSupplementalRow, players: CanonicalPlayerMap): Match {
  const key = normalizePlayerName(row.sourceName);
  const team = normalizeTeam(row.team);

  const byNameAndPosition = players.byNameAndPosition.get(`${key}|${row.position}`) ?? [];
  const resolved = disambiguate(byNameAndPosition, team);
  if (resolved) return { player: resolved, method: 'name-and-position' };
  if (byNameAndPosition.length > 1) return 'ambiguous';

  const byName = players.byName.get(key) ?? [];
  const fallback = disambiguate(
    byName.filter((candidate) => candidate.position === row.position),
    team,
  );
  if (fallback) return { player: fallback, method: 'name' };
  return byName.length > 1 ? 'ambiguous' : null;
}

/** The team breaks a tie between two players with the same name. */
function disambiguate(
  candidates: CanonicalPlayer[],
  team: string | null,
): CanonicalPlayer | null {
  if (candidates.length === 1) return candidates[0];
  if (candidates.length === 0 || !team) return null;
  const onTeam = candidates.filter(
    (candidate) => normalizeTeam(candidate.team) === team,
  );
  return onTeam.length === 1 ? onTeam[0] : null;
}

/** Positional rank by canonical id, which is all the engine needs to order. */
export function supplementalRankIndex(
  snapshot: SupplementalRankingSnapshot | null,
): Map<string, SupplementalRankingRecord> {
  const index = new Map<string, SupplementalRankingRecord>();
  for (const record of snapshot?.records ?? []) index.set(record.playerId, record);
  return index;
}

/** Whether this snapshot is allowed to say anything about a position. */
export function coversPosition(
  snapshot: SupplementalRankingSnapshot | null,
  position: Position,
): boolean {
  return Boolean(snapshot?.positions.includes(position));
}
