/**
 * What the container refuses to start without.
 *
 * These are the rules that decide whether a production deploy comes up, and the
 * failure they exist to prevent is the quiet one: with no DATABASE_URL this
 * application serves a perfectly functional draft room with no accounts and no
 * authorisation. Correct on a laptop. An unsecured public application on the
 * internet.
 *
 * The same module is imported by `scripts/preflight.mjs` and by the health
 * endpoint, so what is asserted here is what both of them do.
 */
import { describe, expect, it } from 'vitest';
import { inspectEnvironment, REQUIREMENTS } from '../../packages/config/requirements.mjs';
import { inspectRuntime, runtimeUsable, type Environment } from '../../packages/config/runtime';

/** A complete production environment, as `process.env` would present it. */
const COMPLETE: Environment = {
  DATABASE_URL: 'postgres://user:pass@db.example.com:25060/app',
  BETTER_AUTH_SECRET: 'a'.repeat(48),
  BETTER_AUTH_URL: 'https://picks.example.com',
  DATABASE_CA_CERT: '-----BEGIN CERTIFICATE-----',
  ANTHROPIC_API_KEY: 'sk-ant-something',
};

const production = (env: Environment) => inspectEnvironment(env, { production: true });

describe('starting a production container', () => {
  it('is allowed when everything mandatory is present', () => {
    const { problems } = production(COMPLETE);
    expect(problems).toEqual([]);
  });

  it('refuses without a database, and says what is lost', () => {
    const { problems } = production({ ...COMPLETE, DATABASE_URL: '' });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('DATABASE_URL');
    expect(problems[0]).toContain('who may spend money');
  });

  it('refuses without a signing secret, or with a short one', () => {
    expect(production({ ...COMPLETE, BETTER_AUTH_SECRET: '' }).problems[0]).toContain(
      'BETTER_AUTH_SECRET',
    );
    const short = production({ ...COMPLETE, BETTER_AUTH_SECRET: 'too-short' }).problems;
    expect(short[0]).toContain('at least 32');
  });

  it('refuses to serve production over http', () => {
    // Session cookies would not be marked Secure.
    const { problems } = production({ ...COMPLETE, BETTER_AUTH_URL: 'http://picks.example.com' });
    expect(problems[0]).toContain('https');
  });

  it('refuses the two switches that would make it unsafe', () => {
    expect(
      production({ ...COMPLETE, AI_ALLOW_WITHOUT_ACCOUNTS: 'true' }).problems[0],
    ).toContain('AI_ALLOW_WITHOUT_ACCOUNTS');
    expect(production({ ...COMPLETE, DATABASE_SSL_INSECURE: 'true' }).problems[0]).toContain(
      'DATABASE_SSL_INSECURE',
    );
  });

  it('warns rather than refuses about the things that only degrade it', () => {
    const noKey = production({ ...COMPLETE, ANTHROPIC_API_KEY: '' });
    expect(noKey.problems).toEqual([]);
    expect(noKey.warnings.some((warning) => warning.includes('ANTHROPIC_API_KEY'))).toBe(true);

    const noCa = production({ ...COMPLETE, DATABASE_CA_CERT: '' });
    expect(noCa.problems).toEqual([]);
    expect(noCa.warnings.some((warning) => warning.includes('DATABASE_CA_CERT'))).toBe(true);
  });

  it('does not warn about a CA for a local database', () => {
    const local = production({
      ...COMPLETE,
      DATABASE_URL: 'postgres://me@localhost:5432/dev',
      DATABASE_CA_CERT: '',
    });
    expect(local.warnings.some((warning) => warning.includes('DATABASE_CA_CERT'))).toBe(false);
  });
});

describe('development is allowed to be incomplete', () => {
  it('turns every mandatory absence into a warning', () => {
    const empty = inspectEnvironment({}, { production: false });
    expect(empty.problems).toEqual([]);
    expect(empty.warnings.length).toBeGreaterThan(0);
  });

  it('still refuses a signing secret that is too short to sign anything', () => {
    // Length is a property of the value, not of the environment it is used in.
    const short = inspectEnvironment({ BETTER_AUTH_SECRET: 'nope' }, { production: false });
    expect(short.problems[0]).toContain('at least 32');
  });
});

describe('what the running app reports about itself', () => {
  it('reports presence and never a value', () => {
    const report = inspectRuntime({ ...COMPLETE, NODE_ENV: 'production' });
    expect(report.production).toBe(true);
    expect(report.present.DATABASE_URL).toBe(true);
    expect(report.present.ANTHROPIC_API_KEY).toBe(true);
    // The one property that matters: a secret must not leak into a health
    // response, a log line, or a diagnostics panel.
    const serialised = JSON.stringify(report);
    for (const value of Object.values(COMPLETE)) {
      expect(serialised).not.toContain(String(value));
    }
  });

  it('agrees with the preflight about whether it may serve', () => {
    expect(runtimeUsable({ ...COMPLETE, NODE_ENV: 'production' })).toBe(true);
    expect(runtimeUsable({ ...COMPLETE, NODE_ENV: 'production', DATABASE_URL: '' })).toBe(false);
  });

  it('marks every secret in the requirement list as one', () => {
    const secrets = REQUIREMENTS.filter((requirement) => requirement.secret).map(
      (requirement) => requirement.name,
    );
    // DEPLOYMENT.md tells the operator to encrypt exactly these.
    expect(secrets).toEqual(
      expect.arrayContaining([
        'DATABASE_URL',
        'BETTER_AUTH_SECRET',
        'ANTHROPIC_API_KEY',
        'DATABASE_CA_CERT',
      ]),
    );
    expect(secrets).not.toContain('BETTER_AUTH_URL');
  });
});
