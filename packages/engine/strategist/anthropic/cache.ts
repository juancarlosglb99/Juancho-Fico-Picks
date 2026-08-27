/**
 * Answers kept on disk, so re-running an evaluation is free.
 *
 * Evaluating three mocks end to end is 45 API calls, and the whole point of the
 * harness is to be run repeatedly while the playbook is tuned. A cache turns
 * that from a recurring bill into a one-off one.
 *
 * The key is everything that could change the answer: the model, the playbook
 * version, and the exact payload the model was sent. Editing the system prompt
 * therefore invalidates every stored answer rather than silently mixing
 * responses from two different strategists into one report - which would be
 * worse than paying for the calls again.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { StrategistCallResult } from './client';
import { PLAYBOOK_VERSION } from './playbook';
import { SUBMIT_RECOMMENDATION_TOOL } from './schema';

/**
 * A fingerprint of the response contract.
 *
 * Without it, tightening the schema would make every stored answer look
 * MALFORMED rather than simply out of date - the entries would still be served,
 * fail the new validation, and be reported as the model misbehaving. They did
 * not misbehave; they answered a different question. A schema change should be
 * a clean cache miss.
 */
const SCHEMA_FINGERPRINT = createHash('sha256')
  .update(JSON.stringify(SUBMIT_RECOMMENDATION_TOOL))
  .digest('hex')
  .slice(0, 12);

const here = dirname(fileURLToPath(import.meta.url));
export const CACHE_DIRECTORY = join(
  here,
  '..',
  '..',
  '..',
  '..',
  'data',
  'regression',
  'strategist-cache',
);

export interface CachedCall extends StrategistCallResult {
  cachedAt: string;
  key: string;
  /** What the answer is about, so a cache file is readable on its own. */
  label: string;
}

export function cacheKey({ model, payload }: { model: string; payload: unknown }): string {
  const hash = createHash('sha256');
  hash.update(`${model} v${PLAYBOOK_VERSION} schema:${SCHEMA_FINGERPRINT} `);
  hash.update(JSON.stringify(payload));
  return hash.digest('hex').slice(0, 32);
}

export function readCached(key: string): CachedCall | null {
  const path = join(CACHE_DIRECTORY, `${key}.json`);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8')) as CachedCall;
}

export function writeCached(
  key: string,
  label: string,
  result: StrategistCallResult,
  now: string,
): CachedCall {
  mkdirSync(CACHE_DIRECTORY, { recursive: true });
  const entry: CachedCall = { ...result, cachedAt: now, key, label };
  // A failed call is never cached: the next run should retry it, not replay
  // the same error forever.
  if (result.error === null) {
    writeFileSync(
      join(CACHE_DIRECTORY, `${key}.json`),
      `${JSON.stringify(entry, null, 2)}\n`,
      'utf8',
    );
  }
  return entry;
}

export function listCached(): CachedCall[] {
  if (!existsSync(CACHE_DIRECTORY)) return [];
  return readdirSync(CACHE_DIRECTORY)
    .filter((name) => name.endsWith('.json'))
    .map((name) => JSON.parse(readFileSync(join(CACHE_DIRECTORY, name), 'utf8')) as CachedCall);
}
