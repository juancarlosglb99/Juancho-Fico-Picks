/**
 * The supplemental K/DST board, and the boundaries around it.
 *
 * Three properties matter and each has a test: it may only speak about kickers
 * and defenses, it matches defenses by team rather than by name, and a player a
 * ranking source lists but Sleeper no longer places on a team does not become a
 * name on a draft board.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseFantasyProsRankings, parsePositionCell } from '../../packages/fantasy-pros/csv';
import {
  coversPosition,
  mapSupplementalRankings,
  normalizeTeam,
  supplementalRankIndex,
} from '../../packages/fantasy-pros/mapping';
import { buildCanonicalPlayerMap } from '../../packages/players/player-map';
import type { SourceProvenance } from '../../packages/data/types';

const CSV = readFileSync('data/rankings/fantasypros-2026-draft-all.csv', 'utf8');

const provenance: SourceProvenance = {
  sourceId: 'fantasy-pros-draft-rankings',
  sourceLabel: 'FantasyPros expert consensus',
  season: '2026',
  fetchedAt: '2026-08-27T00:00:00.000Z',
  sourceUpdatedAt: null,
  sourceConfidence: 'medium',
};

const players = buildCanonicalPlayerMap({
  DAL: { player_id: 'DAL', first_name: 'Dallas', last_name: 'Cowboys', position: 'DEF', team: 'DAL' },
  JAX: { player_id: 'JAX', first_name: 'Jacksonville', last_name: 'Jaguars', position: 'DEF', team: 'JAX' },
  '11533': { player_id: '11533', full_name: 'Brandon Aubrey', position: 'K', team: 'DAL' },
  '120': { player_id: '120', full_name: 'Adam Vinatieri', position: 'K', team: null, status: 'Injured Reserve' },
  '9221': { player_id: '9221', full_name: 'Jahmyr Gibbs', position: 'RB', team: 'DET' },
});

describe('reading a FantasyPros export', () => {
  it('splits the fused position cell', () => {
    expect(parsePositionCell('K1')).toEqual({ position: 'K', rank: 1 });
    expect(parsePositionCell('DST12')).toEqual({ position: 'DEF', rank: 12 });
    // Everything else is somebody else's board.
    expect(parsePositionCell('WR34')).toBeNull();
    expect(parsePositionCell('QB2')).toBeNull();
    expect(parsePositionCell('')).toBeNull();
    expect(parsePositionCell('K')).toBeNull();
  });

  it('keeps only kickers and defenses out of a 943-row export', () => {
    const rows = parseFantasyProsRankings(CSV);
    expect(rows).toHaveLength(72);
    expect(new Set(rows.map((row) => row.position))).toEqual(new Set(['K', 'DEF']));
    expect(rows.filter((row) => row.position === 'K')).toHaveLength(40);
    expect(rows.filter((row) => row.position === 'DEF')).toHaveLength(32);
  });

  it('carries the published positional rank', () => {
    const rows = parseFantasyProsRankings(CSV);
    const first = rows.find((row) => row.position === 'K' && row.positionRank === 1);
    expect(first?.sourceName).toBe('Brandon Aubrey');
    expect(first?.team).toBe('DAL');
  });
});

describe('mapping it to Sleeper', () => {
  const snapshot = mapSupplementalRankings({
    rows: parseFantasyProsRankings(CSV),
    players,
    provenance,
    season: '2026',
  });

  it('matches a defense by team code, not by team name', () => {
    const dallas = snapshot.records.find((record) => record.sleeperId === 'DAL');
    // FantasyPros publishes "Dallas Cowboys"; Sleeper calls the same entity DAL.
    expect(dallas?.position).toBe('DEF');
    expect(dallas?.positionRank).toBeGreaterThan(0);
  });

  it('reconciles the two spellings of Jacksonville', () => {
    expect(normalizeTeam('JAC')).toBe('JAX');
    expect(normalizeTeam('WSH')).toBe('WAS');
    expect(normalizeTeam(null)).toBeNull();
    expect(snapshot.records.some((record) => record.sleeperId === 'JAX')).toBe(true);
  });

  it('matches a kicker by name and keeps Sleeper as the identity', () => {
    const aubrey = snapshot.records.find((record) => record.sourceName === 'Brandon Aubrey');
    expect(aubrey?.playerId).toBe('jfp:11533');
    expect(aubrey?.positionRank).toBe(1);
    expect(aubrey?.name).toBe('Brandon Aubrey');
  });

  it('refuses a ranked player Sleeper no longer places on a team', () => {
    const withRetired = mapSupplementalRankings({
      rows: [
        { sourceName: 'Adam Vinatieri', team: 'FA', position: 'K', positionRank: 9, overallRank: 300 },
      ],
      players,
      provenance,
      season: '2026',
    });
    expect(withRetired.records).toHaveLength(0);
    expect(withRetired.unresolved[0]).toMatchObject({ reason: 'ineligible' });
  });

  it('reports an unmatched name rather than guessing at one', () => {
    const unknown = mapSupplementalRankings({
      rows: [
        { sourceName: 'Nobody At All', team: 'DAL', position: 'K', positionRank: 1, overallRank: 1 },
      ],
      players,
      provenance,
      season: '2026',
    });
    expect(unknown.records).toHaveLength(0);
    expect(unknown.unresolved[0]).toMatchObject({ reason: 'no-sleeper-match' });
  });

  it('declares the only positions it is allowed to order', () => {
    expect(snapshot.positions).toEqual(['K', 'DEF']);
    expect(coversPosition(snapshot, 'K')).toBe(true);
    expect(coversPosition(snapshot, 'DEF')).toBe(true);
    // The guard that keeps this board away from the scoring First Seed owns.
    expect(coversPosition(snapshot, 'WR')).toBe(false);
    expect(coversPosition(snapshot, 'RB')).toBe(false);
    expect(coversPosition(null, 'K')).toBe(false);
  });

  it('indexes by canonical id, which is what the engine orders by', () => {
    const index = supplementalRankIndex(snapshot);
    expect(index.get('jfp:11533')?.positionRank).toBe(1);
    expect(index.get('jfp:9221')).toBeUndefined();
  });
});
