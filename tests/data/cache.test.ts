import { describe, expect, it, vi } from 'vitest';
import {
  loadWithLastGood,
  readLastGood,
  writeLastGood,
  type KeyValueStore,
} from '../../packages/data/cache';

class MemoryStore implements KeyValueStore {
  private readonly values = new Map<string, string>();

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }

  removeItem(key: string) {
    this.values.delete(key);
  }
}

interface Dataset {
  rows: number[];
}

const valid = (value: unknown): value is Dataset =>
  !!value &&
  typeof value === 'object' &&
  Array.isArray((value as Dataset).rows) &&
  (value as Dataset).rows.length > 0;

describe('last-known-good cache', () => {
  it('uses a fresh valid cache without calling the source', async () => {
    const storage = new MemoryStore();
    writeLastGood({
      storage,
      key: 'dataset',
      value: { rows: [1] },
      savedAt: new Date('2026-08-25T08:00:00Z'),
    });
    const fetchFresh = vi.fn(async () => ({ rows: [2] }));

    const result = await loadWithLastGood({
      storage,
      key: 'dataset',
      validate: valid,
      fetchFresh,
      refreshIntervalMs: 12 * 60 * 60 * 1000,
      now: new Date('2026-08-25T12:00:00Z'),
    });

    expect(result.disposition).toBe('fresh_cache');
    expect(result.value.rows).toEqual([1]);
    expect(fetchFresh).not.toHaveBeenCalled();
  });

  it('replaces an expired cache only after a valid refresh', async () => {
    const storage = new MemoryStore();
    writeLastGood({
      storage,
      key: 'dataset',
      value: { rows: [1] },
      savedAt: new Date('2026-08-24T00:00:00Z'),
    });

    const result = await loadWithLastGood({
      storage,
      key: 'dataset',
      validate: valid,
      fetchFresh: async () => ({ rows: [2, 3] }),
      refreshIntervalMs: 12 * 60 * 60 * 1000,
      now: new Date('2026-08-25T12:00:00Z'),
    });

    expect(result.disposition).toBe('network');
    expect(result.value.rows).toEqual([2, 3]);
    expect(readLastGood({ storage, key: 'dataset', validate: valid })?.value.rows).toEqual([
      2,
      3,
    ]);
  });

  it.each([
    ['network error', async () => Promise.reject(new Error('source unavailable'))],
    ['empty dataset', async () => ({ rows: [] })],
  ])('preserves a valid cache after a %s', async (_label, fetchFresh) => {
    const storage = new MemoryStore();
    writeLastGood({
      storage,
      key: 'dataset',
      value: { rows: [7] },
      savedAt: new Date('2026-08-20T00:00:00Z'),
    });

    const result = await loadWithLastGood({
      storage,
      key: 'dataset',
      validate: valid,
      fetchFresh,
      refreshIntervalMs: 1,
      now: new Date('2026-08-25T12:00:00Z'),
      forceRefresh: true,
    });

    expect(result.disposition).toBe('fallback_cache');
    expect(result.value.rows).toEqual([7]);
    expect(result.refreshError).toBeTruthy();
    expect(readLastGood({ storage, key: 'dataset', validate: valid })?.value.rows).toEqual([
      7,
    ]);
  });

  it('rejects an invalid refresh when no valid cache exists', async () => {
    const storage = new MemoryStore();
    await expect(
      loadWithLastGood({
        storage,
        key: 'dataset',
        validate: valid,
        fetchFresh: async () => ({ rows: [] }),
        refreshIntervalMs: 1,
      }),
    ).rejects.toThrow('invalid dataset');
    expect(storage.getItem('dataset')).toBeNull();
  });

  it('removes a malformed cache envelope instead of treating it as last-known-good', () => {
    const storage = new MemoryStore();
    storage.setItem('dataset', '{not-json');
    expect(readLastGood({ storage, key: 'dataset', validate: valid })).toBeNull();
    expect(storage.getItem('dataset')).toBeNull();
  });
});
