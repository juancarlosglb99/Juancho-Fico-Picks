import type { CacheDisposition } from './types';

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

interface CacheEnvelope<T> {
  schemaVersion: 1;
  savedAt: string;
  value: T;
}

export interface LastGoodResult<T> {
  value: T;
  disposition: CacheDisposition;
  savedAt: string;
  refreshError: string | null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'The source refresh failed.';
}

function parseEnvelope<T>(
  serialized: string | null,
  validate: (value: unknown) => value is T,
): CacheEnvelope<T> | null {
  if (!serialized) return null;
  try {
    const parsed = JSON.parse(serialized) as Partial<CacheEnvelope<unknown>>;
    if (
      parsed.schemaVersion !== 1 ||
      typeof parsed.savedAt !== 'string' ||
      !validate(parsed.value)
    ) {
      return null;
    }
    return parsed as CacheEnvelope<T>;
  } catch {
    return null;
  }
}

export function readLastGood<T>({
  storage,
  key,
  validate,
}: {
  storage: KeyValueStore;
  key: string;
  validate: (value: unknown) => value is T;
}): CacheEnvelope<T> | null {
  const serialized = storage.getItem(key);
  const envelope = parseEnvelope(serialized, validate);
  if (!envelope && serialized) storage.removeItem(key);
  return envelope;
}

export function writeLastGood<T>({
  storage,
  key,
  value,
  savedAt,
}: {
  storage: KeyValueStore;
  key: string;
  value: T;
  savedAt: Date;
}) {
  const envelope: CacheEnvelope<T> = {
    schemaVersion: 1,
    savedAt: savedAt.toISOString(),
    value,
  };
  storage.setItem(key, JSON.stringify(envelope));
}

export async function loadWithLastGood<T>({
  storage,
  key,
  validate,
  fetchFresh,
  refreshIntervalMs,
  now = new Date(),
  forceRefresh = false,
}: {
  storage: KeyValueStore;
  key: string;
  validate: (value: unknown) => value is T;
  fetchFresh: () => Promise<T>;
  refreshIntervalMs: number;
  now?: Date;
  forceRefresh?: boolean;
}): Promise<LastGoodResult<T>> {
  const cached = readLastGood({ storage, key, validate });
  const cachedAge = cached ? now.getTime() - Date.parse(cached.savedAt) : Infinity;
  if (!forceRefresh && cached && cachedAge >= 0 && cachedAge < refreshIntervalMs) {
    return {
      value: cached.value,
      disposition: 'fresh_cache',
      savedAt: cached.savedAt,
      refreshError: null,
    };
  }

  try {
    const fresh = await fetchFresh();
    if (!validate(fresh)) throw new Error('The source returned an invalid dataset.');
    writeLastGood({ storage, key, value: fresh, savedAt: now });
    return {
      value: fresh,
      disposition: 'network',
      savedAt: now.toISOString(),
      refreshError: null,
    };
  } catch (error) {
    if (!cached) throw error;
    return {
      value: cached.value,
      disposition: 'fallback_cache',
      savedAt: cached.savedAt,
      refreshError: errorMessage(error),
    };
  }
}
