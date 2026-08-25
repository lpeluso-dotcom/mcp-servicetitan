// ============================================================
// cache.ts — opaque-blob read-through cache keyed by (ns, k).
//
// TWO BACKENDS, ONE API. `cacheGet` / `cachePurgeNamespace` are unchanged in
// shape and semantics; only where the bytes live moves. Which store is used is
// decided per-request by the CACHE_BACKEND var:
//
//   unset | "d1"  → D1 only. Byte-for-byte today's behaviour. THE DEFAULT.
//   "dual"        → write BOTH, read KV first and fall back to D1. Warm-up.
//   "kv"          → KV only. D1 is never touched.
//
// WHY MOVE AT ALL. Three reasons, in order of how much they matter:
//
//   (a) EXPIRY. `idx_mcp_cache_expires` exists but NOTHING EVER DELETES
//       EXPIRED ROWS. `cachePurgeNamespace` is the only DELETE and it deletes
//       by namespace, so expired rows accumulate in D1 forever. That is a real
//       unbounded-growth bug, not a theoretical one. KV expires entries itself.
//   (b) Edge-local reads instead of a round trip to the single-region D1
//       primary — this worker runs under smart placement, but a cache read
//       that must reach the primary is a cache that costs what it saves.
//   (c) Cheaper reads at scale.
//
// WHY KV IS THE RIGHT SHAPE. This is a pure opaque-blob read-through keyed by
// (ns, k) with a millisecond expires_at — exactly KV's model. KV's eventual
// consistency (up to ~60s cross-region write propagation, last-write-wins) is
// ALREADY the semantics a TTL'd read-through cache has: a caller can always be
// handed a value up to `ttlSec` old. Precedent exists in-repo — report
// categories are already KV-cached at 1h (src/resources/catalogs.ts).
//
// THE TTL CLAMP, AND WHY THE ENVELOPE EXISTS. KV rejects an `expirationTtl`
// below 60s, and several call sites cache for less (find_customer: 30s;
// get_customer / list_jobs_today: 60s). So the KV TTL is clamped UP to 60 and
// the REAL expiry is carried inside the stored envelope. KV expiry is then
// only a garbage collector; logical freshness is enforced on read and is never
// looser than the caller asked for.
//
// Every path here is fail-open: any store error falls through to miss().
// ============================================================

import type { Env } from './env';

interface CacheRow {
  value: string;
  expires_at: number;
}

/** What KV stores: the payload plus its true (unclamped) expiry in epoch ms. */
interface KvEnvelope {
  v: unknown;
  e: number;
}

/** KV refuses an expirationTtl below this. See the header note on the clamp. */
const KV_MIN_TTL_SEC = 60;

type Backend = 'd1' | 'dual' | 'kv';

/** Env fields this module reads beyond `DB`. Optional so nothing breaks unbound. */
type CacheEnv = Env & {
  MCP_CACHE?: KVNamespace;
  CACHE_BACKEND?: string;
};

/**
 * Resolves the active backend. Falls back to 'd1' whenever KV is not actually
 * bound, so an env that names a backend it cannot serve degrades instead of
 * failing — the same posture as every other guard in this worker.
 */
function backendFor(env: CacheEnv): Backend {
  if (!env.MCP_CACHE) return 'd1';
  switch ((env.CACHE_BACKEND ?? '').trim().toLowerCase()) {
    case 'kv':
      return 'kv';
    case 'dual':
      return 'dual';
    default:
      return 'd1';
  }
}

/**
 * KV key for a (ns, k) pair. The separator is ':' and namespaces are already
 * colon-delimited ("servicetitan:find_customer"), which keeps prefix purges
 * exact: "servicetitan:get_customer:" cannot match a key under
 * "servicetitan:get_customer_locations".
 */
function kvKey(namespace: string, key: string): string {
  return `${namespace}:${key}`;
}

type Lookup<T> = { hit: true; value: T } | { hit: false };

const MISS: Lookup<never> = { hit: false };

async function kvRead<T>(env: CacheEnv, namespace: string, key: string, now: number): Promise<Lookup<T>> {
  try {
    const raw = await env.MCP_CACHE!.get(kvKey(namespace, key));
    if (raw === null || raw === undefined) return MISS;
    const env_ = JSON.parse(raw) as KvEnvelope;
    // Honour the TRUE expiry, not KV's clamped one.
    if (typeof env_?.e !== 'number' || env_.e <= now) return MISS;
    return { hit: true, value: env_.v as T };
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(`[cache] kv read failed: ${(e as Error).message}`);
    return MISS;
  }
}

async function kvWrite(
  env: CacheEnv,
  namespace: string,
  key: string,
  value: unknown,
  ttlSec: number,
  now: number
): Promise<void> {
  try {
    const envelope: KvEnvelope = { v: value, e: now + ttlSec * 1000 };
    await env.MCP_CACHE!.put(kvKey(namespace, key), JSON.stringify(envelope), {
      expirationTtl: Math.max(KV_MIN_TTL_SEC, Math.ceil(ttlSec)),
    });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(`[cache] kv write failed: ${(e as Error).message}`);
  }
}

async function d1Read<T>(env: CacheEnv, namespace: string, key: string, now: number): Promise<Lookup<T>> {
  try {
    const row = await env.DB.prepare(
      `SELECT value, expires_at FROM mcp_cache WHERE ns = ? AND k = ?`
    )
      .bind(namespace, key)
      .first<CacheRow>();

    if (row && row.expires_at > now) {
      return { hit: true, value: JSON.parse(row.value) as T };
    }
    return MISS;
  } catch (e) {
    // Cache read failure is non-fatal — fall through to miss().
    // eslint-disable-next-line no-console
    console.error(`[cache] read failed: ${(e as Error).message}`);
    return MISS;
  }
}

async function d1Write(
  env: CacheEnv,
  namespace: string,
  key: string,
  value: unknown,
  ttlSec: number,
  now: number
): Promise<void> {
  try {
    await env.DB.prepare(
      `INSERT OR REPLACE INTO mcp_cache (ns, k, value, expires_at) VALUES (?, ?, ?, ?)`
    )
      .bind(namespace, key, JSON.stringify(value), now + ttlSec * 1000)
      .run();
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(`[cache] write failed: ${(e as Error).message}`);
  }
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

  const e = env as CacheEnv;
  const backend = backendFor(e);
  const now = Date.now();

  if (backend !== 'd1') {
    const hit = await kvRead<T>(e, namespace, key, now);
    if (hit.hit) return hit.value;
  }
  if (backend !== 'kv') {
    const hit = await d1Read<T>(e, namespace, key, now);
    if (hit.hit) return hit.value;
  }

  const fresh = await miss();
  const wroteAt = Date.now();

  if (backend !== 'd1') await kvWrite(e, namespace, key, fresh, ttlSec, wroteAt);
  if (backend !== 'kv') await d1Write(e, namespace, key, fresh, ttlSec, wroteAt);

  return fresh;
}

/** Deletes every KV key under `<namespace>:`, paging the list to completion. */
async function kvPurge(env: CacheEnv, namespace: string): Promise<void> {
  try {
    const prefix = `${namespace}:`;
    // List to completion FIRST, then delete. Deleting while paging mutates the
    // very keyspace the cursor is walking, which can skip entries.
    const names: string[] = [];
    let cursor: string | undefined;
    do {
      const page: { keys: { name: string }[]; list_complete: boolean; cursor?: string } =
        await env.MCP_CACHE!.list({ prefix, ...(cursor ? { cursor } : {}) });
      for (const k of page.keys) names.push(k.name);
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);
    await Promise.all(names.map((name) => env.MCP_CACHE!.delete(name)));
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(`[cache] kv purge failed for ${namespace}: ${(e as Error).message}`);
  }
}

/**
 * Manually purge a namespace (all keys). Used for future writes that should
 * invalidate cached reads (e.g., after st_patch_equipment).
 *
 * Purges EVERY store that is bound, regardless of the active backend. During a
 * cutover an over-purge merely costs a cache miss; an under-purge would serve a
 * stale read out of the store the flag is not currently pointing at, which is
 * exactly the bug an invalidation call exists to prevent.
 */
export async function cachePurgeNamespace(env: Env, namespace: string): Promise<void> {
  const e = env as CacheEnv;

  if (e.MCP_CACHE) await kvPurge(e, namespace);

  try {
    await e.DB.prepare(`DELETE FROM mcp_cache WHERE ns = ?`).bind(namespace).run();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[cache] purge failed for ${namespace}: ${(err as Error).message}`);
  }
}
