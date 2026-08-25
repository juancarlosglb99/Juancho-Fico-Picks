import type { SleeperPlayerRaw, SleeperPlayersResponse } from '../sleeper/types';
import type { CanonicalPlayer, CanonicalPlayerMap, Position } from './types';

const POSITIONS = new Set<Position>([
  'QB',
  'RB',
  'WR',
  'TE',
  'K',
  'DEF',
  'DL',
  'LB',
  'DB',
]);

export function normalizePlayerName(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\b(jr|sr|ii|iii|iv|v)\b\.?/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

export function normalizePosition(position?: string | null): Position {
  if (!position) return 'UNKNOWN';
  const upper = position.toUpperCase() as Position;
  if (upper === 'DST') return 'DEF';
  if (upper === 'PK') return 'K';
  return POSITIONS.has(upper) ? upper : 'UNKNOWN';
}

function canonicalizeSleeperPlayer(
  sleeperId: string,
  raw: SleeperPlayerRaw,
): CanonicalPlayer | null {
  const name =
    raw.full_name?.trim() ||
    [raw.first_name, raw.last_name].filter(Boolean).join(' ').trim();
  if (!name) return null;

  const position = normalizePosition(raw.position ?? raw.fantasy_positions?.[0]);
  const externalIds: CanonicalPlayer['externalIds'] = { sleeper: sleeperId };
  if (raw.gsis_id) externalIds.gsis = String(raw.gsis_id);
  if (raw.espn_id) externalIds.espn = String(raw.espn_id);
  if (raw.pfr_id) externalIds.pfr = String(raw.pfr_id);

  return {
    id: `jfp:${sleeperId}`,
    name,
    normalizedName: normalizePlayerName(name),
    position,
    team: raw.team ?? null,
    status: raw.status ?? null,
    age: raw.age ?? null,
    yearsExperience: raw.years_exp ?? null,
    externalIds,
  };
}

function addToIndex(
  map: Map<string, CanonicalPlayer[]>,
  key: string,
  player: CanonicalPlayer,
) {
  map.set(key, [...(map.get(key) ?? []), player]);
}

export function buildCanonicalPlayerMap(
  response: SleeperPlayersResponse,
): CanonicalPlayerMap {
  const players = Object.entries(response)
    .map(([sleeperId, raw]) => canonicalizeSleeperPlayer(sleeperId, raw))
    .filter((player): player is CanonicalPlayer => player !== null)
    .sort((a, b) => a.name.localeCompare(b.name));

  const byId = new Map<string, CanonicalPlayer>();
  const bySleeperId = new Map<string, CanonicalPlayer>();
  const byNameAndPosition = new Map<string, CanonicalPlayer[]>();
  const byName = new Map<string, CanonicalPlayer[]>();

  for (const player of players) {
    byId.set(player.id, player);
    if (player.externalIds.sleeper) {
      bySleeperId.set(player.externalIds.sleeper, player);
    }
    addToIndex(byName, player.normalizedName, player);
    addToIndex(
      byNameAndPosition,
      `${player.normalizedName}|${player.position}`,
      player,
    );
  }

  return { players, byId, bySleeperId, byNameAndPosition, byName };
}
