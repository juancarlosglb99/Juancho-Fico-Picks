/**
 * Reads a FantasyPros draft-rankings export.
 *
 * The export is one row per player across every position, with the position and
 * its rank fused into a single cell - `K1`, `DST12`, `WR34`. Only the rows this
 * product is allowed to use are returned; everything else is dropped here
 * rather than filtered later, so there is no path by which a FantasyPros
 * receiver ranking could reach the scoring First Seed owns.
 */
// The CSV reader is generic and already tested; it happens to live beside the
// First Seed provider because that was the first source to need it.
import { parseCsv } from '../first-seed/csv';
import type { Position } from '../players/types';
import { SUPPLEMENTAL_POSITIONS } from './types';

export interface RawSupplementalRow {
  sourceName: string;
  team: string | null;
  position: Position;
  positionRank: number;
  overallRank: number;
}

/** `DST12` -> `{ position: 'DEF', rank: 12 }`. Null for anything unsupported. */
export function parsePositionCell(
  cell: string,
): { position: Position; rank: number } | null {
  const match = /^([A-Za-z]+)(\d+)$/.exec(cell.trim());
  if (!match) return null;
  const raw = match[1].toUpperCase();
  const position: Position | null = raw === 'DST' ? 'DEF' : raw === 'K' ? 'K' : null;
  if (position === null) return null;
  return { position, rank: Number(match[2]) };
}

export function parseFantasyProsRankings(input: string): RawSupplementalRow[] {
  const rows = parseCsv(input);
  if (rows.length === 0) return [];

  const header = rows[0].map((cell) => cell.trim().toUpperCase());
  const index = {
    rank: header.indexOf('RK'),
    name: header.indexOf('PLAYER NAME'),
    team: header.indexOf('TEAM'),
    position: header.indexOf('POS'),
  };
  if (index.name === -1 || index.position === -1) return [];

  const parsed: RawSupplementalRow[] = [];
  for (const row of rows.slice(1)) {
    const cell = row[index.position] ?? '';
    const position = parsePositionCell(cell);
    if (!position || !SUPPLEMENTAL_POSITIONS.includes(position.position)) continue;

    const sourceName = (row[index.name] ?? '').trim();
    if (!sourceName) continue;

    parsed.push({
      sourceName,
      team: (row[index.team] ?? '').trim() || null,
      position: position.position,
      positionRank: position.rank,
      overallRank: Number(row[index.rank] ?? '') || position.rank,
    });
  }
  return parsed.sort((a, b) => a.positionRank - b.positionRank);
}
