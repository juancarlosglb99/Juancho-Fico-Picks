/**
 * What the running application knows about its own schema.
 *
 * Read-only. APPLYING migrations is `scripts/migrate.mjs`, which is plain
 * JavaScript so the production container can run it before the server starts
 * without shipping a TypeScript runner. Both read the same `.sql` files and the
 * same `schema_migration` table, so there is one source of truth and one
 * record of what has been done to the database.
 */
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPool } from './client';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

export interface AppliedMigration {
  name: string;
  appliedAt: Date;
}

export function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql'))
    .sort();
}

/** Which migrations the connected database has, for the health endpoint. */
export async function appliedMigrations(): Promise<AppliedMigration[]> {
  const pool = getPool();
  const { rows } = await pool.query<{ name: string; applied_at: Date }>(
    `select name, applied_at from schema_migration order by name`,
  );
  return rows.map((row) => ({ name: row.name, appliedAt: row.applied_at }));
}

/** True when every migration on disk has been applied. */
export async function schemaUpToDate(): Promise<boolean> {
  try {
    const applied = new Set((await appliedMigrations()).map((entry) => entry.name));
    return migrationFiles().every((name) => applied.has(name));
  } catch {
    return false;
  }
}
