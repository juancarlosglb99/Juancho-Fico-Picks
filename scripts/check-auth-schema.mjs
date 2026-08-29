#!/usr/bin/env node
/**
 * `npm run db:check` - does the committed schema still satisfy Better Auth?
 *
 * Better Auth's tables are generated, and the published CLI lags the library:
 * generating with `@better-auth/cli@latest` against `better-auth@1.7.2`
 * produced a schema missing `account.issuer`, and sign-up failed at runtime
 * with a Kysely stack trace that named neither.
 *
 * So this asks the INSTALLED library what it would need to add to the live
 * database, and fails if the answer is anything at all. Run it after every
 * `better-auth` upgrade and in the deploy pipeline; a version bump that needs a
 * column becomes a red build rather than a broken login.
 */
import { betterAuth } from 'better-auth';
import { getMigrations } from 'better-auth/db/migration';
import pg from 'pg';
import { databaseTls } from '../packages/db/ssl.mjs';

const url = process.env.DATABASE_URL?.trim();
if (!url) {
  console.error('DATABASE_URL is not set. Nothing to check.');
  process.exit(1);
}

// The one TLS rule, so this cannot be the next copy to drift.
const pool = new pg.Pool({ connectionString: url, ssl: databaseTls(url).ssl });
const auth = betterAuth({
  database: pool,
  secret: 'x'.repeat(48),
  baseURL: process.env.BETTER_AUTH_URL ?? 'http://localhost:3000',
  emailAndPassword: { enabled: true },
});

try {
  const { compileMigrations } = await getMigrations(auth.options);
  const compiled = await compileMigrations();
  await pool.end();

  // An up-to-date database compiles to nothing, which the generator renders as
  // a lone semicolon rather than an empty string.
  const outstanding = compiled.replace(/[\s;]/g, '') === '' ? '' : compiled.trim();

  if (!outstanding) {
    console.log('Auth schema is current: the installed library needs nothing added.');
    process.exit(0);
  }

  console.error('Auth schema is BEHIND the installed better-auth. Missing:\n');
  console.error(outstanding);
  console.error('\nAdd this to a new migration in packages/db/migrations/ and re-run.');
  process.exit(1);
} catch (error) {
  await pool.end().catch(() => {});
  console.error(`Schema check failed: ${error.message}`);
  process.exit(1);
}
