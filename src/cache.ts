// ============================================================
// cache.ts — D1 read-through cache via mcp_cache table
// Shared namespace across all mcp-* modules (ns = "servicetitan:...")
// ============================================================

import type { Env } from './env';

interface CacheRow {
  value: string;
  expires_at: number;
}

/**
 * Read-through cache helper. On miss, calls `miss()` and stores the result with the given TTL.
 * Caller passes the namespace + key; the stored value is always a JSON-stringified payload.
 *
 * @param env Cloudflare env
 * @param namespace e.g. "servicetitan:customers"
 * @param key e.g. "page=1&pageSize=50"
 * @param ttlSec seconds until expiry (0 = no cache, always call miss)
 * @param miss factory for fresh value
 */
export async function cacheGet<T>(
  env: Env,
  namespace: string,
  key: string,
  ttlSec: number,
  miss: () => Promise<T>
): Promise<T> {
  if (ttlSec <= 0) {
    return miss();
  }

  try {
    const row = await env.DB.prepare(
      `SELECT value, expires_at FROM mcp_cache WHERE ns = ? AND k = ?`
    )
      .bind(namespace, key)
      .first<CacheRow>();

    const now = Date.now();
    if (row && row.expires_at > now) {
      return JSON.parse(row.value) as T;
    }
  } catch (e) {
    // Cache read failure is non-fatal — fall through to miss().
    // eslint-disable-next-line no-console
    console.error(`[cache] read failed: ${(e as Error).message}`);
  }

  const fresh = await miss();

  try {
    await env.DB.prepare(
      `INSERT OR REPLACE INTO mcp_cache (ns, k, value, expires_at) VALUES (?, ?, ?, ?)`
    )
      .bind(namespace, key, JSON.stringify(fresh), Date.now() + ttlSec * 1000)
      .run();
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(`[cache] write failed: ${(e as Error).message}`);
  }

  return fresh;
}

/**
 * Manually purge a namespace (all keys). Used for future writes that should
 * invalidate cached reads (e.g., after st_patch_equipment).
 */
export async function cachePurgeNamespace(env: Env, namespace: string): Promise<void> {
  try {
    await env.DB.prepare(`DELETE FROM mcp_cache WHERE ns = ?`).bind(namespace).run();
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(`[cache] purge failed for ${namespace}: ${(e as Error).message}`);
  }
}
