/**
 * Whether the database connection needs TLS, decided in one place.
 *
 * This rule lived in two files - the pool and the migration script - and said
 * "loopback needs no TLS, everything else does". That is right for a laptop and
 * right for a managed provider, and wrong for the shape we actually deploy: a
 * Postgres container on a Docker network marked `internal`, with no published
 * port, reached as `db:5432`. It has no certificate and no way to get one, and
 * the traffic never leaves the host - but `db` is not `localhost`, so both
 * copies demanded TLS and the container refused to start.
 *
 * Plain JavaScript and a single definition for the same reason `requirements.mjs`
 * is: `client.ts`, `scripts/migrate.mjs` and the production preflight all have
 * to agree about this, and the way you find out that two copies have drifted is
 * a deploy that will not come up.
 *
 * THE SAFETY PROPERTY. Turning TLS off is explicit and it is written in the
 * connection string, in libpq's own vocabulary (`?sslmode=disable`) rather than
 * in a switch of our own. Doing it to a host that is not on a private network
 * is refused in production, because that is the case where "encrypted" and
 * "not encrypted" is the difference between a private database and a public
 * one.
 */

/** The host from a Postgres URL, lowercased, or null if it cannot be read. */
export function databaseHost(url) {
  if (!url) return null;
  try {
    return new URL(url).hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}

/** The `sslmode` query parameter, if the URL carries one. */
export function databaseSslMode(url) {
  if (!url) return null;
  try {
    return new URL(url).searchParams.get('sslmode')?.trim().toLowerCase() || null;
  } catch {
    return null;
  }
}

/**
 * Is this host unreachable from outside the machine?
 *
 * Two cases, and only two. Loopback is obvious. A single-label hostname - `db`,
 * `postgres` - is a Docker network alias: it resolves only inside a container
 * network, and no managed provider hands out a name without dots in it. An
 * address with dots is treated as public even when it is in a private range,
 * because "10.x is safe" depends on a network topology this code cannot see.
 */
export function isPrivateHost(host) {
  if (!host) return false;
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]') {
    return true;
  }
  return !host.includes('.') && !host.includes(':');
}

/**
 * What TLS settings `pg` should be given, and why.
 *
 * Returns `{ ssl, reason }` where `ssl` is passed straight to `pg` - `undefined`
 * meaning no TLS at all - and `reason` is for a log line, never for a decision.
 *
 * @param {string} url
 * @param {Record<string, string | undefined>} [env]
 */
export function databaseTls(url, env = process.env) {
  const host = databaseHost(url);

  // Written by whoever wrote the connection string. The most explicit signal
  // there is, so it is honoured first.
  if (databaseSslMode(url) === 'disable') {
    return { ssl: undefined, reason: `sslmode=disable in DATABASE_URL (host ${host ?? 'unknown'})` };
  }

  const ca = env.DATABASE_CA_CERT?.trim();
  if (ca) return { ssl: { ca, rejectUnauthorized: true }, reason: 'verified against DATABASE_CA_CERT' };

  /*
   * Opt-in, and named so it cannot be arrived at by accident. Managed providers
   * hand out a CA certificate; using this instead means the connection is
   * encrypted against nobody in particular.
   */
  if (env.DATABASE_SSL_INSECURE === 'true') {
    return { ssl: { rejectUnauthorized: false }, reason: 'DATABASE_SSL_INSECURE (encrypted, unverified)' };
  }

  if (isPrivateHost(host)) {
    return { ssl: undefined, reason: `private host ${host}, no TLS needed` };
  }

  return { ssl: { rejectUnauthorized: true }, reason: 'verified against the system trust store' };
}

/**
 * Everything wrong with how this URL is secured, for the production preflight.
 *
 * One problem, and it is the one that matters: TLS switched off to a host that
 * is not private. Nothing here is a style opinion - a deploy is stopped only
 * when the database traffic would cross a network in the clear.
 *
 * @param {string | undefined} url
 * @returns {{ problems: string[], warnings: string[] }}
 */
export function inspectDatabaseTls(url) {
  const problems = [];
  const warnings = [];
  if (!url) return { problems, warnings };

  const host = databaseHost(url);
  if (databaseSslMode(url) === 'disable' && !isPrivateHost(host)) {
    problems.push(
      `DATABASE_URL sets sslmode=disable for host "${host ?? 'unknown'}", which is not loopback or a container network alias. That would send credentials and every row in the clear.`,
    );
  }
  return { problems, warnings };
}
