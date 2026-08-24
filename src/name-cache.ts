// ============================================================
// name-cache.ts — Phase 2 Task 2.6
//
// Small, reusable KV-cached name/ID lookup helper. Built for MCP argument
// completions (src/prompts/index.ts) but kept generic (getCached) so future
// name-resolution work (e.g. a technician completion) can reuse it. Also
// backs the `mcp-st://catalog/business-units` resource.
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
//
// MIRROR FRESHNESS (workstream D item 2). The loader also captures the
// table's MAX(synced_at) and caches it ALONGSIDE the rows, so:
//   - `listBusinessUnits()` keeps its plain-array contract for completions,
//     where a caveat has nowhere to render (a completion list is a list of
//     strings), and
//   - `listBusinessUnitsStamped()` returns the same rows in a disclosable
//     envelope for callers that can show one (the catalog resource).
// The verdict is recomputed from the cached MAX on every call, so a cached
// catalog AGES honestly instead of freezing a 'fresh' verdict for the whole
// TTL — and a cache hit still costs zero D1 round trips.
// ============================================================

import type { Env } from './env';
import { readD1 } from './d1';
import { stampMirrorFreshness, fetchTableMax, type FreshnessStamp } from './mirror-freshness';

export interface NamedEntity {
  id: number;
  name: string;
}

const BU_TABLE = 'business_units';

/**
 * `:v2` because the cached VALUE shape changed from `NamedEntity[]` to
 * `{ rows, tableMax }`. A live `:v1` entry would otherwise deserialize into
 * an array and blow up the reader mid-TTL; a new key lets the old one expire
 * on its own.
 */
export const BU_CACHE_KEY = 'namecache:business_units:v2';
const BU_CACHE_TTL_S = 1800;

/**
 * Rows as stored.
 *
 * `synced_at` is typed but NOT selected. Unlike `technicians` and
 * `pb_categories` — whose columns are pinned in this repo (see the header of
 * src/resources/catalogs.ts) — nothing here documents the shape of taylor-ai's
 * `business_units`, so `SELECT synced_at` could be a hard "no such column"
 * failure that empties every businessUnitId completion. The table-level probe
 * carries the freshness verdict instead: `fetchTableMax` swallows its own
 * failure and returns `{}`, which degrades the stamp to `unknown` + a warning
 * rather than breaking the read. If `business_units.synced_at` is ever
 * confirmed, adding it to the SELECT below is a one-line upgrade that buys
 * `_rows_synced_hours`.
 */
interface BuRow extends NamedEntity {
  synced_at?: string | null;
}

interface BuCacheEntry {
  rows: BuRow[];
  /** Table-level MAX(synced_at) as of the load, per fetchTableMax's contract. */
  tableMax: Record<string, unknown>;
}

const EMPTY_BU_ENTRY: BuCacheEntry = { rows: [], tableMax: {} };

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
 * The single cached load both public helpers share: rows + the table's
 * MAX(synced_at) captured at the same moment.
 *
 * Never throws — a D1 failure resolves to `{ rows: [], tableMax: {} }`,
 * which downstream stamps as `_freshness: 'unknown'` with a warning rather
 * than as an authoritative empty roster.
 */
async function loadBusinessUnits(env: Env): Promise<BuCacheEntry> {
  return getCached<BuCacheEntry>(
    env,
    BU_CACHE_KEY,
    BU_CACHE_TTL_S,
    async () => {
      // fetchTableMax never rejects (it degrades to {}), so racing it with
      // the row read cannot turn a healthy load into a failed one.
      const [{ rows }, tableMax] = await Promise.all([
        readD1<BuRow>(env, 'SELECT bu_id AS id, name FROM business_units WHERE active = 1'),
        fetchTableMax(env, [BU_TABLE]),
      ]);
      return { rows, tableMax };
    },
    EMPTY_BU_ENTRY,
  );
}

/**
 * Business units, id+name, cached in KV (`namecache:business_units:v2`,
 * 1800s TTL). Source: D1 `business_units` (bu_id AS id, name) WHERE
 * active = 1 — the same table name-resolver.ts's resolveBusinessUnit
 * reads.
 *
 * Never throws: a D1/proxy error resolves to [] so a completion callback
 * built on top of this can never break the prompt it's wired to. Use
 * `listBusinessUnitsStamped` instead anywhere the caller can actually
 * SHOW a freshness caveat.
 */
export async function listBusinessUnits(env: Env): Promise<NamedEntity[]> {
  const { rows } = await loadBusinessUnits(env);
  return rows.map((r) => ({ id: r.id, name: r.name }));
}

export interface StampedBusinessUnits extends FreshnessStamp {
  business_units: NamedEntity[];
  count: number;
}

/**
 * The same rows as `listBusinessUnits`, in a disclosable envelope. Shares
 * the KV entry, so calling both costs one D1 load, not two.
 *
 * Never throws, for the same reason the plain list doesn't: the callers are
 * a browsable MCP resource and (potentially) a prompt, neither of which
 * should be able to fail on a mirror blip.
 */
export async function listBusinessUnitsStamped(env: Env): Promise<StampedBusinessUnits> {
  const { rows, tableMax } = await loadBusinessUnits(env);
  return {
    business_units: rows.map((r) => ({ id: r.id, name: r.name })),
    count: rows.length,
    ...stampMirrorFreshness(rows, { table: BU_TABLE, tableMax }),
  };
}
