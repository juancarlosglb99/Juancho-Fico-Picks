/**
 * When the database connection needs TLS, and when it already does not.
 *
 * This rule was duplicated in the pool and the migration script and said
 * "loopback needs no TLS, everything else does". Correct on a laptop, correct
 * against a managed provider, and wrong for the shape actually deployed: a
 * Postgres container on an internal Docker network with no published port,
 * reached as `db:5432`. It has no certificate and cannot get one, so the
 * container refused to start - which is how the gap was found.
 *
 * The cases below are the ones that matter, and the last group is the point:
 * switching TLS off has to be impossible to do by accident to a host that is
 * actually reachable.
 */
import { describe, expect, it } from 'vitest';
import {
  databaseHost,
  databaseSslMode,
  databaseTls,
  inspectDatabaseTls,
  isPrivateHost,
} from '../../packages/db/ssl.mjs';

const MANAGED = 'postgres://u:p@db-postgresql-nyc3-1.k.db.ondigitalocean.com:25060/defaultdb';
const CONTAINER = 'postgres://u:p@db:5432/juancho';
const LOOPBACK = 'postgres://u:p@localhost:5432/juancho';

describe('reading a connection string', () => {
  it('finds the host without touching the credentials', () => {
    expect(databaseHost(CONTAINER)).toBe('db');
    expect(databaseHost(LOOPBACK)).toBe('localhost');
    expect(databaseHost('not a url')).toBeNull();
  });

  it('finds sslmode when it is there, and nothing when it is not', () => {
    expect(databaseSslMode(`${CONTAINER}?sslmode=disable`)).toBe('disable');
    expect(databaseSslMode(`${MANAGED}?sslmode=require`)).toBe('require');
    expect(databaseSslMode(CONTAINER)).toBeNull();
  });
});

describe('which hosts are unreachable from outside the machine', () => {
  it('counts loopback and a container network alias', () => {
    for (const host of ['localhost', '127.0.0.1', '::1', 'db', 'postgres']) {
      expect(isPrivateHost(host), host).toBe(true);
    }
  });

  it('counts nothing with a dot in it, however private the range looks', () => {
    // "10.x is safe" depends on a network topology this code cannot see.
    for (const host of ['db-postgresql-nyc3-1.k.db.ondigitalocean.com', '10.0.0.5', '165.227.84.41']) {
      expect(isPrivateHost(host), host).toBe(false);
    }
  });
});

describe('what pg is told', () => {
  it('asks for no TLS to a container on the internal network', () => {
    expect(databaseTls(CONTAINER, {}).ssl).toBeUndefined();
  });

  it('asks for no TLS over loopback', () => {
    expect(databaseTls(LOOPBACK, {}).ssl).toBeUndefined();
  });

  it('verifies against the system trust store by default anywhere else', () => {
    expect(databaseTls(MANAGED, {}).ssl).toEqual({ rejectUnauthorized: true });
  });

  it('verifies against a supplied CA when there is one', () => {
    const ssl = databaseTls(MANAGED, { DATABASE_CA_CERT: '-----BEGIN CERTIFICATE-----' }).ssl;
    expect(ssl).toEqual({ ca: '-----BEGIN CERTIFICATE-----', rejectUnauthorized: true });
  });

  it('only stops verifying when asked for by name', () => {
    expect(databaseTls(MANAGED, { DATABASE_SSL_INSECURE: 'true' }).ssl).toEqual({
      rejectUnauthorized: false,
    });
    // Anything short of exactly "true" is not asking.
    expect(databaseTls(MANAGED, { DATABASE_SSL_INSECURE: '1' }).ssl).toEqual({
      rejectUnauthorized: true,
    });
  });

  it('lets the connection string have the last word', () => {
    // The most explicit signal there is: somebody wrote it into the URL.
    expect(databaseTls(`${MANAGED}?sslmode=disable`, {}).ssl).toBeUndefined();
  });
});

describe('what a production deploy is stopped for', () => {
  it('is nothing, for the shapes we actually run', () => {
    for (const url of [CONTAINER, LOOPBACK, MANAGED, `${MANAGED}?sslmode=require`]) {
      expect(inspectDatabaseTls(url).problems, url).toEqual([]);
    }
  });

  it('is TLS switched off to a host that is genuinely reachable', () => {
    const problems = inspectDatabaseTls(`${MANAGED}?sslmode=disable`).problems;
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('sslmode=disable');
    expect(problems[0]).toContain('in the clear');
  });

  it('is not TLS switched off to a container, which never leaves the host', () => {
    expect(inspectDatabaseTls(`${CONTAINER}?sslmode=disable`).problems).toEqual([]);
  });
});
