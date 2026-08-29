/**
 * What the running application knows about its own schema.
 *
 * Read-only. APPLYING migrations is `scripts/migrate.mjs`, which is plain
 * JavaScript so the production container can run it before the server starts
 * without shipping a TypeScript runner. Both read the same `.sql` files and the
 * same `schema_migration` table, so there is one source of truth and one
 * record of what has been done to the database.
 */
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPool } from './client';

/**
 * Where the `.sql` files are, which is not the same place in every build.
 *
 * In the source tree they sit beside this module. In the standalone production
 * output this module is bundled, `import.meta.url` points inside the bundle,
 * and the migrations are copied to their own directory - so the container sets
 * `MIGRATIONS_DIR` and this falls back through the candidates otherwise.
 *
 * Getting this wrong was not loud. `readdirSync` on a missing directory throws,
 * the health check caught it - but an EMPTY list does not throw, and
 * `[].every(...)` is `true`, so the check cheerfully reported the schema as
 * current while unable to see a single migration. That is the exact failure it
 * exists to catch, so the answer is now three-valued.
 */
function migrationsDirectory(): string | null {
  const configured = process.env.MIGRATIONS_DIR?.trim();
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    ...(configured ? [resolve(configured)] : []),
    join(here, 'migrations'),
    resolve(process.cwd(), 'migrations'),
    resolve(process.cwd(), 'packages/db/migrations'),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

export interface AppliedMigration {
  name: string;
  appliedAt: Date;
}

/** Null when the directory cannot be found at all, which is not the same as none. */
export function migrationFiles(): string[] | null {
  const directory = migrationsDirectory();
  if (!directory) return null;
  const files = readdirSync(directory)
    .filter((name) => name.endsWith('.sql'))
    .sort();
  return files.length > 0 ? files : null;
}

/** Which migrations the connected database has, for the health endpoint. */
export async function appliedMigrations(): Promise<AppliedMigration[]> {
  const pool = getPool();
  const { rows } = await pool.query<{ name: string; applied_at: Date }>(
    `select name, applied_at from schema_migration order by name`,
  );
  return rows.map((row) => ({ name: row.name, appliedAt: row.applied_at }));
}

export type SchemaStatus = 'current' | 'behind' | 'unreachable' | 'unknown';

/**
 * Whether the connected database has every migration this build ships.
 *
 * `unknown` means the migration files could not be found, which is a real and
 * distinct answer: it says nothing about the database and must never be
 * reported as "current".
 */
export async function schemaStatus(): Promise<SchemaStatus> {
  const files = migrationFiles();
  if (!files) return 'unknown';
  try {
    const applied = new Set((await appliedMigrations()).map((entry) => entry.name));
    return files.every((name) => applied.has(name)) ? 'current' : 'behind';
  } catch {
    return 'unreachable';
  }
}
