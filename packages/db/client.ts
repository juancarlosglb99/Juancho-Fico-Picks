/**
 * The one Postgres pool, created lazily and shared.
 *
 * Two things this file is careful about, both of which bite in production
 * rather than in development.
 *
 * POOLING. A managed Postgres has a hard connection ceiling, and App Platform
 * runs several instances of the same container. A pool per module import would
 * multiply straight through that ceiling, so there is exactly one, it is capped
 * well below the smallest managed plan, and it is created on first use rather
 * than at import time - which is what lets the app boot, serve a draft and run
 * its tests with no database at all.
 *
 * TLS. DigitalOcean terminates Postgres with a certificate signed by their own
 * CA. Passing `ssl: true` without that CA fails to verify; the usual answer
 * found in tutorials is `rejectUnauthorized: false`, which turns the encryption
 * into decoration. So the CA is read from configuration when supplied and
 * verification stays ON, and the unverified mode has to be asked for by name.
 * The whole decision - including when TLS is not needed at all - is in
 * `ssl.mjs`, shared with the migration script and the preflight.
 */
import { Pool, type PoolClient, type PoolConfig } from 'pg';
import { databaseTls } from './ssl.mjs';

/** Comfortably under the 22 a DigitalOcean dev database allows, per instance. */
const MAX_CONNECTIONS = Number(process.env.DATABASE_POOL_MAX ?? 8);
const IDLE_TIMEOUT_MS = 30_000;
const CONNECTION_TIMEOUT_MS = 10_000;

let pool: Pool | null = null;

export function databaseUrl(): string | null {
  const url = process.env.DATABASE_URL?.trim();
  return url ? url : null;
}

/** Whether accounts are available at all. Everything else keys off this. */
export function databaseConfigured(): boolean {
  return databaseUrl() !== null;
}

/**
 * The rule itself lives in `ssl.mjs`, which the migration script and the
 * production preflight also import - so a container that refuses to start and
 * a pool that will not connect can never disagree about why.
 */
function tlsOptions(): PoolConfig['ssl'] {
  return databaseTls(databaseUrl() ?? '').ssl as PoolConfig['ssl'];
}

export function getPool(): Pool {
  const url = databaseUrl();
  if (!url) {
    throw new Error(
      'DATABASE_URL is not set. Accounts, entitlements and usage accounting are unavailable.',
    );
  }
  if (!pool) {
    pool = new Pool({
      connectionString: url,
      max: MAX_CONNECTIONS,
      idleTimeoutMillis: IDLE_TIMEOUT_MS,
      connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
      ssl: tlsOptions(),
      application_name: 'juancho-fico-picks',
    });
    /*
     * A pooled client can die between checkouts - a failover, an idle timeout at
     * the far end. `pg` emits that on the pool, and an unhandled 'error' event
     * takes the process down with it, which would turn a transient database
     * blip into an outage of a draft screen that does not need the database.
     */
    pool.on('error', (error) => {
      console.error('[db] idle client error', error.message);
    });
  }
  return pool;
}

export async function query<T extends Record<string, unknown>>(
  text: string,
  values: unknown[] = [],
): Promise<T[]> {
  const result = await getPool().query<T>(text, values);
  return result.rows;
}

export async function queryOne<T extends Record<string, unknown>>(
  text: string,
  values: unknown[] = [],
): Promise<T | null> {
  const rows = await query<T>(text, values);
  return rows[0] ?? null;
}

/**
 * A transaction, released whatever happens.
 *
 * Used where a decision and its side effect must not come apart: spending a
 * credit and recording what it bought is one act, and a crash between them
 * either bills for nothing or gives away an answer.
 */
export async function transaction<T>(
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('begin');
    const result = await run(client);
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/** For the health endpoint: is the database actually reachable? */
export async function databaseReachable(): Promise<boolean> {
  if (!databaseConfigured()) return false;
  try {
    await query('select 1');
    return true;
  } catch {
    return false;
  }
}

/** Closes the pool. For graceful shutdown and for test teardown. */
export async function closePool(): Promise<void> {
  const existing = pool;
  pool = null;
  await existing?.end();
}
