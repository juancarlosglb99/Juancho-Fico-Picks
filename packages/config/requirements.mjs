/**
 * What this application needs to run, and what happens without each thing.
 *
 * Plain JavaScript, and the single definition: the TypeScript runtime module
 * imports it for the health endpoint and the diagnostics panel, and
 * `scripts/preflight.mjs` imports it to refuse to start a production container.
 * Two copies of this list would eventually disagree about which variable is
 * mandatory, and the way you would find out is a production deploy that came up
 * as an unsecured single-user application.
 *
 * `secret: true` means the value must be an encrypted variable on the platform
 * and must never appear in a log line, a response body, or a client bundle.
 */

import {
  databaseHost,
  databaseSslMode,
  inspectDatabaseTls,
  isPrivateHost,
} from '../db/ssl.mjs';

/** @typedef {{ name: string, secret: boolean, requiredInProduction: boolean, why: string }} Requirement */

/** @type {Requirement[]} */
export const REQUIREMENTS = [
  {
    name: 'DATABASE_URL',
    secret: true,
    requiredInProduction: true,
    why: 'Accounts, entitlements and AI usage accounting. Without it there is nowhere to record who may spend money.',
  },
  {
    name: 'BETTER_AUTH_SECRET',
    secret: true,
    requiredInProduction: true,
    why: 'Signs session cookies. A missing or short secret means sessions cannot be trusted.',
  },
  {
    name: 'BETTER_AUTH_URL',
    secret: false,
    requiredInProduction: true,
    why: 'The origin the app is served from. Decides cookie security and the links in any email.',
  },
  {
    name: 'ANTHROPIC_API_KEY',
    secret: true,
    requiredInProduction: false,
    why: 'The AI strategist. Optional: without it the deterministic engine carries the draft and the strategist reports itself unconfigured.',
  },
  {
    name: 'DATABASE_CA_CERT',
    secret: true,
    requiredInProduction: false,
    why: "The managed database's CA certificate. With it, TLS verification stays on.",
  },
  {
    name: 'JUANCHO_STRATEGIST_MODEL',
    secret: false,
    requiredInProduction: false,
    why: 'Which model the strategist uses. Defaults to the current production model.',
  },
  {
    name: 'DATABASE_POOL_MAX',
    secret: false,
    requiredInProduction: false,
    why: 'Connections per container. Several instances share one database ceiling.',
  },
  {
    name: 'AI_KILL_SWITCH',
    secret: false,
    requiredInProduction: false,
    why: 'Set to "true" to refuse every strategist request. The deterministic engine is unaffected.',
  },
  {
    name: 'AI_DAILY_SPEND_LIMIT_USD',
    secret: false,
    requiredInProduction: false,
    why: 'Estimated dollars the whole deployment may spend in a UTC day. Lowers the built-in default; never raises it.',
  },
  {
    name: 'AI_MONTHLY_SPEND_LIMIT_USD',
    secret: false,
    requiredInProduction: false,
    why: 'Estimated dollars the whole deployment may spend in a UTC month. Lowers the built-in default; never raises it.',
  },
  {
    name: 'AI_MAX_DRAFT_SPEND_USD',
    secret: false,
    requiredInProduction: false,
    why: 'Estimated dollars one draft may spend. Lowers the built-in default; never raises it.',
  },
  {
    name: 'AI_MAX_CALLS_PER_DRAFT',
    secret: false,
    requiredInProduction: false,
    why: 'Strategist calls allowed in one draft. Lowers the built-in default; never raises it.',
  },
  {
    name: 'AI_MAX_REPAIRS_PER_DRAFT',
    secret: false,
    requiredInProduction: false,
    why: 'Repair attempts allowed in one draft. Lowers the built-in default; never raises it.',
  },
];

/** What we know about the database URL, without ever reading its credentials. */
function describeDatabase(url) {
  return {
    host: databaseHost(url),
    isPrivateHost: isPrivateHost(databaseHost(url)),
    sslMode: databaseSslMode(url),
  };
}

/** Minimum length for a signing secret worth having. */
export const MIN_SECRET_LENGTH = 32;

/**
 * Everything wrong with this environment.
 *
 * `problems` are fatal in production and the container must not start;
 * `warnings` are worth saying and are not.
 *
 * The env parameter is a plain bag of strings rather than `process.env`: a test
 * that describes a HALF-configured environment - the entire point of this
 * function - should not have to satisfy a type that insists on `NODE_ENV`.
 *
 * @param {Record<string, string | undefined>} [env]
 * @param {{ production: boolean }} [options]
 * @returns {{ problems: string[], warnings: string[] }}
 */
export function inspectEnvironment(env = process.env, options = { production: false }) {
  const { production } = options;
  const problems = [];
  const warnings = [];
  const value = (name) => env[name]?.trim() || '';

  for (const requirement of REQUIREMENTS) {
    if (!requirement.requiredInProduction || value(requirement.name)) continue;
    const message = `${requirement.name} is not set. ${requirement.why}`;
    if (production) problems.push(message);
    else warnings.push(message);
  }

  const secret = value('BETTER_AUTH_SECRET');
  if (secret && secret.length < MIN_SECRET_LENGTH) {
    problems.push(
      `BETTER_AUTH_SECRET is ${secret.length} characters; it must be at least ${MIN_SECRET_LENGTH}.`,
    );
  }

  const url = value('BETTER_AUTH_URL');
  if (production && url && !url.startsWith('https://')) {
    problems.push(
      `BETTER_AUTH_URL is "${url}". Production must be https, or session cookies will not be marked Secure.`,
    );
  }

  /*
   * The two switches that would quietly turn a production deployment into
   * something it should never be. Ignoring them in production is not enough -
   * finding them set means somebody believes they are doing something, and the
   * deploy should stop and say so.
   */
  if (production && value('AI_ALLOW_WITHOUT_ACCOUNTS') === 'true') {
    problems.push(
      'AI_ALLOW_WITHOUT_ACCOUNTS is set in production. That switch exists for local work only: it authorises AI spending with no account behind it.',
    );
  }
  if (production && value('DATABASE_SSL_INSECURE') === 'true') {
    problems.push(
      'DATABASE_SSL_INSECURE is set in production. Supply DATABASE_CA_CERT instead so the connection is verified rather than merely encrypted.',
    );
  }

  const database = value('DATABASE_URL');
  /*
   * Whether the database is somewhere only this machine can reach. The rule is
   * in `packages/db/ssl.mjs` because the pool and the migration script apply
   * exactly the same one, and a preflight that disagreed with them would either
   * pass a deploy that cannot connect or stop one that can.
   */
  const { host, isPrivateHost, sslMode } = describeDatabase(database);
  const privateDatabase = isPrivateHost;

  // TLS switched off to something that is NOT on a private network. The only
  // database problem worth stopping a deploy for.
  problems.push(...inspectDatabaseTls(database).problems);

  if (production && database && !privateDatabase && sslMode !== 'disable' && !value('DATABASE_CA_CERT')) {
    warnings.push(
      'DATABASE_CA_CERT is not set. The connection will be verified against the system trust store, which a managed provider may not be in.',
    );
  }
  if (production && privateDatabase && host !== 'localhost' && host !== '127.0.0.1') {
    warnings.push(
      `DATABASE_URL points at "${host}", a container network alias, so the connection is not encrypted. That is correct for a database with no published port on the same host, and wrong for anything else.`,
    );
  }

  /*
   * Not a problem - it is a deliberate switch, and the deploy should succeed
   * with it on. It is said out loud because "the AI stopped working" and "we
   * turned the AI off" look identical from a draft room.
   */
  if (value('AI_KILL_SWITCH') === 'true') {
    warnings.push(
      'AI_KILL_SWITCH is set. Every strategist request will be refused; the deterministic engine is unaffected.',
    );
  }

  if (!value('ANTHROPIC_API_KEY')) {
    warnings.push(
      'ANTHROPIC_API_KEY is not set. The AI strategist will report itself unconfigured; nothing else is affected.',
    );
  }

  return { problems, warnings };
}
