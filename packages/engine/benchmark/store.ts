/**
 * Reads and writes the regression corpus on disk.
 *
 * Layout:
 *
 *   data/regression/mocks/<draftId>.json         one per draft, small
 *   data/regression/snapshots/<ref>.json         the pinned First Seed data
 *
 * The split exists because every mock drafted in the same week faces the same
 * projections. Inlining them made one case 300KB and a season of drafting would
 * have put fifteen megabytes of duplicated JSON into the repository.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DraftRoomRankingSnapshot, ProjectionSnapshot } from '../../data/types';
import type { SleeperPlayersResponse } from '../../sleeper/types';
import type { RegressionCase } from './case';

const here = dirname(fileURLToPath(import.meta.url));
export const REGRESSION_ROOT = join(here, '..', '..', '..', 'data', 'regression');
export const CASE_DIRECTORY = join(REGRESSION_ROOT, 'mocks');
export const SNAPSHOT_DIRECTORY = join(REGRESSION_ROOT, 'snapshots');

/**
 * A stable, human-readable key for a snapshot.
 *
 * Built from what actually determines the contents - the source date and the
 * format - so two captures of the same weekly data collapse onto one file, and
 * the filename says what it holds.
 */
export function snapshotRef(
  kind: 'projections' | 'room' | 'players',
  parts: (string | null | undefined)[],
): string {
  const cleaned = parts
    .filter((part): part is string => Boolean(part))
    .map((part) => part.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase());
  return `${kind}-${cleaned.join('-')}`;
}

export function writeSnapshot(ref: string, snapshot: unknown): void {
  mkdirSync(SNAPSHOT_DIRECTORY, { recursive: true });
  const path = join(SNAPSHOT_DIRECTORY, `${ref}.json`);
  // Written once and reused; rewriting identical data would only churn git.
  if (existsSync(path)) return;
  writeFileSync(path, `${JSON.stringify(snapshot)}\n`, 'utf8');
}

export function readProjectionSnapshot(ref: string): ProjectionSnapshot {
  return readSnapshot<ProjectionSnapshot>(ref);
}

export function readRoomSnapshot(ref: string): DraftRoomRankingSnapshot {
  return readSnapshot<DraftRoomRankingSnapshot>(ref);
}

export function readPlayerSnapshot(ref: string): SleeperPlayersResponse {
  return readSnapshot<SleeperPlayersResponse>(ref);
}

/**
 * Trims Sleeper's player list to what a draft actually needs.
 *
 * The raw response is several megabytes of biography. Only the fields the
 * canonical map reads are kept, for positions that can be drafted.
 */
export function trimPlayersForSnapshot(
  raw: SleeperPlayersResponse,
): SleeperPlayersResponse {
  const draftable = new Set(['QB', 'RB', 'WR', 'TE', 'K', 'DEF', 'DST', 'PK']);
  const trimmed: SleeperPlayersResponse = {};
  for (const [sleeperId, player] of Object.entries(raw)) {
    const position = player?.position ?? player?.fantasy_positions?.[0];
    if (!position || !draftable.has(String(position).toUpperCase())) continue;
    trimmed[sleeperId] = {
      player_id: player.player_id,
      full_name: player.full_name,
      first_name: player.first_name,
      last_name: player.last_name,
      position: player.position,
      team: player.team ?? null,
      years_exp: player.years_exp ?? null,
      age: player.age ?? null,
      status: player.status ?? null,
    } as typeof player;
  }
  return trimmed;
}

function readSnapshot<T>(ref: string): T {
  const path = join(SNAPSHOT_DIRECTORY, `${ref}.json`);
  if (!existsSync(path)) {
    throw new Error(
      `Regression snapshot "${ref}" is missing. The case that references it cannot be replayed.`,
    );
  }
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

export function writeCase(regression: RegressionCase): string {
  mkdirSync(CASE_DIRECTORY, { recursive: true });
  const path = join(CASE_DIRECTORY, `${regression.draftId}.json`);
  writeFileSync(path, `${JSON.stringify(regression, null, 2)}\n`, 'utf8');
  return path;
}

/** Every saved case, oldest capture first so reports read chronologically. */
export function listCases(): RegressionCase[] {
  if (!existsSync(CASE_DIRECTORY)) return [];
  return readdirSync(CASE_DIRECTORY)
    .filter((name) => name.endsWith('.json'))
    .map((name) => JSON.parse(readFileSync(join(CASE_DIRECTORY, name), 'utf8')) as RegressionCase)
    .sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
}
