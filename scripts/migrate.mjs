#!/usr/bin/env node
/**
 * `npm run db:migrate` - apply every migration that has not been applied.
 *
 * Plain JavaScript on purpose. This is the one piece of the project that has to
 * run inside the production container before the server starts, and a
 * TypeScript runner in a production image is a dependency bought for one
 * command. It needs `pg` and the filesystem, both of which are already there.
 *
 * Forward-only, and safe to run on every deploy: an advisory lock covers two
 * containers starting at once, applied migrations are recorded and skipped, and
 * a failure exits non-zero so a release stops rather than serving against a
 * half-built schema.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(here, '..', 'packages', 'db', 'migrations');
/** Any 64-bit constant; it only has to be the same in every instance. */
const ADVISORY_LOCK_KEY = '8531202612004771';

const url = process.env.DATABASE_URL?.trim();
if (!url) {
  console.error('DATABASE_URL is not set. Nothing to migrate.');
  process.exit(1);
}

function tls() {
  const ca = process.env.DATABASE_CA_CERT?.trim();
  if (ca) return { ca, rejectUnauthorized: true };
  if (process.env.DATABASE_SSL_INSECURE === 'true') return { rejectUnauthorized: false };
  return /@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(url)
    ? undefined
    : { rejectUnauthorized: true };
}

const client = new pg.Client({ connectionString: url, ssl: tls() });

async function main() {
  await client.connect();
  await client.query('select pg_advisory_lock($1)', [ADVISORY_LOCK_KEY]);
  await client.query(`
    create table if not exists schema_migration (
      name text primary key,
      applied_at timestamptz not null default now()
    )
  `);

  const done = new Set(
    (await client.query('select name from schema_migration')).rows.map((row) => row.name),
  );
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql'))
    .sort();

  let applied = 0;
  for (const name of files) {
    if (done.has(name)) continue;
    console.log(`  applying ${name}`);
    // Each migration is its own transaction, so a failure leaves the ones
    // before it applied rather than rolling back a season of schema history.
    await client.query('begin');
    try {
      await client.query(readFileSync(join(MIGRATIONS_DIR, name), 'utf8'));
      await client.query('insert into schema_migration (name) values ($1)', [name]);
      await client.query('commit');
      applied += 1;
    } catch (error) {
      await client.query('rollback').catch(() => {});
      throw new Error(`Migration ${name} failed: ${error.message}`);
    }
  }

  if (applied === 0) console.log('  nothing to apply; schema is current');
  console.log(`\nSchema is at ${files.length} migration${files.length === 1 ? '' : 's'}.`);
}

main()
  .then(async () => {
    await client.query('select pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY]).catch(() => {});
    await client.end();
  })
  .catch(async (error) => {
    console.error(`\nMigration failed: ${error.message}`);
    await client.end().catch(() => {});
    process.exit(1);
  });
