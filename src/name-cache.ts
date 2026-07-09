// ============================================================
// name-cache.ts — Phase 2 Task 2.6
//
// Small, reusable KV-cached name/ID lookup helper. Built for MCP argument
// completions (src/prompts/index.ts) but kept generic (getCached) so future
// name-resolution work (e.g. a technician completion) can reuse it.
//
// Distinct from name-resolver.ts's per-isolate in-memory Map memo — that
// one backs write-time resolveBusinessUnit/resolveTechnician (exact/prefix/
// contains tiering + ambiguity handling for tool args). This one is KV-
// backed (PROXY_STATE) so a cache hit survives across isolates, at the
// cost of a coarser 1800s TTL — appropriate for completion suggestions,
// which don't need write-time freshness guarantees.
//
// D1 source: taylor-ai `business_units` table — bu_id, name, active — the
// SAME table+columns src/name-resolver.ts's resolveBusinessUnit reads via
// readD1 (see KIND_CONFIG.businessUnit there). No separate BU source was
// needed; this worker already has a proven D1-backed BU table.
//
// Resilience: getCached() NEVER throws. A D1/proxy error (or a KV blip on
// either side) degrades to the empty-array default — a completion failure
// must never break the prompt it's attached to.
// ============================================================

import type { Env } from './env';
import { readD1 } from './d1';

export interface NamedEntity {
  id: number;
  name: string;
}

const BU_CACHE_KEY = 'namecache:business_units';
const BU_CACHE_TTL_S = 1800;

/**
 * Generic cache-first loader over PROXY_STATE KV.
 *
 * Flow: KV get -> parse -> return on hit. On miss (or a corrupt/unreadable
 * cache entry), call loader(); on success, best-effort cache the result
 * (a KV put failure is swallowed — the freshly loaded value is still
 * returned, just uncached for next time) and return it. On a loader
 * failure, return `empty` rather than throwing/propagating.
 */
async function getCached<T>(
  env: Env,
  key: string,
  ttlSec: number,
  loader: () => Promise<T>,
  empty: T,
): Promise<T> {
  try {
    const cached = await env.PROXY_STATE.get(key);
    if (cached) {
      try {
        return JSON.parse(cached) as T;
      } catch {
        // Corrupt cache entry — fall through to a fresh load.
      }
    }
  } catch {
    // KV read blip — fall through to a fresh load.
  }

  let fresh: T;
  try {
    fresh = await loader();
  } catch {
    // Source (D1/proxy) error — never throw out of a completion path.
    return empty;
  }

  try {
    await env.PROXY_STATE.put(key, JSON.stringify(fresh), { expirationTtl: ttlSec });
  } catch {
    // KV write blip must not fail the call.
  }

  return fresh;
}

/**
 * Business units, id+name, cached in KV (`namecache:business_units`,
 * 1800s TTL). Source: D1 `business_units` (bu_id AS id, name) WHERE
 * active = 1 — the same table name-resolver.ts's resolveBusinessUnit
 * reads.
 *
 * Never throws: a D1/proxy error resolves to [] so a completion callback
 * built on top of this can never break the prompt it's wired to.
 */
export async function listBusinessUnits(env: Env): Promise<NamedEntity[]> {
  return getCached(
    env,
    BU_CACHE_KEY,
    BU_CACHE_TTL_S,
    async () => {
      const { rows } = await readD1<{ id: number; name: string }>(
        env,
        'SELECT bu_id AS id, name FROM business_units WHERE active = 1',
      );
      return rows.map((r) => ({ id: r.id, name: r.name }));
    },
    [],
  );
}
