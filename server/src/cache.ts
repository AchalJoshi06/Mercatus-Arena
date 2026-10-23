/**
 * Simple in-memory TTL cache for hot read endpoints.
 * Invalidated on trade execution and engine state transitions.
 */

interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

const store = new Map<string, CacheEntry<unknown>>();

export function cacheGet<T>(key: string): T | undefined {
  const entry = store.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    store.delete(key);
    return undefined;
  }
  return entry.data as T;
}

export function cacheSet<T>(key: string, data: T, ttlMs: number): void {
  store.set(key, { data, expiresAt: Date.now() + ttlMs });
}

export function cacheInvalidateAll(): void {
  store.clear();
}

/**
 * Convenience wrapper: returns cached data if fresh, otherwise calls fetcher,
 * stores the result, and returns it.
 */
export async function cached<T>(
  key: string,
  ttlMs: number,
  fetcher: () => T | Promise<T>,
): Promise<T> {
  const hit = cacheGet<T>(key);
  if (hit !== undefined) return hit;
  const data = await fetcher();
  cacheSet(key, data, ttlMs);
  return data;
}
