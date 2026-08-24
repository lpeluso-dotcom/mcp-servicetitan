// ============================================================
// name-resolver.ts — v1.4 BU + technician name → ID resolver.
//
// Looks up business_units / technicians via the shared readD1 helper
// (src/d1.ts → servicetitan-proxy /api/sql/read, the proven D1-read path)
// and memoizes the index in-process behind a short TTL. Tier match: exact >
// prefix > contains; first tier with one or more hits resolves.
//
// Asymmetric ambiguity:
//   - read mode: ambiguous → return first by ascending id with
//     ambiguous=true (caller surfaces _warnings).
//   - write mode: ambiguous → throw McpError('validation_error')
//     so callers can never silently address the wrong record.
//
// Numeric inputs pass through with no D1 hit.
//
// MIRROR FRESHNESS. This is the highest-traffic mirror reader in the worker:
// every `*Name` argument on every tool resolves through here. It used to read
// the mirror with a raw readD1 and disclose nothing, so a frozen roster
// surfaced as a confident "technicianName not found" — which a caller reads
// as "no such tech", not "the mirror is broken". Resolutions now carry a
// `mirror` stamp (src/mirror-freshness.ts), and a MISS against a mirror that
// cannot prove its sync is alive says so in the error text. A miss against a
// PROVEN-fresh mirror stays a plain miss: hedging every typo is the cry-wolf
// failure that trains callers to ignore the disclosure.
// ============================================================

import type { Env } from './env';
import { readD1 } from './d1';
import { McpError } from './errors';
import { stampMirrorFreshness, fetchTableMax, type FreshnessStamp } from './mirror-freshness';

export interface ResolutionResult {
  id: number;
  resolved: 'numeric' | 'exact' | 'prefix' | 'contains';
  ambiguous: boolean;
  candidates?: { id: number; name: string }[];
  /**
   * Freshness of the mirror table this resolution came out of. Absent for
   * `resolved: 'numeric'` — a numeric pass-through never reads the mirror,
   * so there is nothing to disclose.
   */
  mirror?: FreshnessStamp;
}

interface IndexRow {
  id: number;
  name: string;
}

type Mode = 'read' | 'write';
type Kind = 'businessUnit' | 'technician';

const KIND_CONFIG: Record<Kind, { sql: string; label: string; table: string }> = {
  businessUnit: {
    sql: 'SELECT bu_id AS id, name FROM business_units WHERE active = 1',
    label: 'businessUnitName',
    table: 'business_units',
  },
  technician: {
    sql: 'SELECT tech_id AS id, name FROM technicians WHERE active = 1',
    label: 'technicianName',
    table: 'technicians',
  },
};

/**
 * Lifetime of the per-isolate index memo.
 *
 * The previous rationale was "Workers isolates are short-lived enough that
 * staleness is bounded by isolate replacement (~minutes)". That is an
 * assumption, not a guarantee — a hot isolate serving steady traffic lives
 * far longer, and nothing in the platform contract caps it. Combined with
 * the `WHERE active = 1` filter in KIND_CONFIG, an untimed memo means a
 * technician deactivated in ServiceTitan stays resolvable, and (worse) one
 * newly ACTIVATED stays invisible, for the isolate's entire life.
 *
 * 5 minutes: short enough that a roster change lands within one coffee
 * break, long enough that the index load stays amortised across the burst
 * of `*Name` lookups a single composite tool fires.
 */
export const RESOLVER_INDEX_TTL_MS = 5 * 60 * 1000;

interface LoadedIndex {
  rows: IndexRow[];
  /** Table-level MAX(synced_at) captured with the rows; backs the stamp. */
  tableMax: Record<string, unknown>;
}

interface CacheEntry {
  /** When the load was STARTED — the TTL measures data age, not idle time. */
  fetchedAt: number;
  value: Promise<LoadedIndex>;
}

// Per-isolate memo, one entry per Kind. Size is bounded by the Kind union
// (2), so no eviction policy beyond the TTL is needed.
const indexCache = new Map<Kind, CacheEntry>();

export function _clearResolverCache(): void {
  indexCache.clear();
}

async function loadIndex(env: Env, kind: Kind): Promise<LoadedIndex> {
  const startedAt = Date.now();
  const cached = indexCache.get(kind);
  if (cached && startedAt - cached.fetchedAt < RESOLVER_INDEX_TTL_MS) return cached.value;

  const { sql, table } = KIND_CONFIG[kind];

  const promise = (async (): Promise<LoadedIndex> => {
    try {
      // fetchTableMax never rejects (it degrades to {}), so it is safe to
      // race alongside the index read — one extra round trip per LOAD, i.e.
      // at most once per TTL per kind, not once per resolution.
      const [{ rows }, tableMax] = await Promise.all([
        readD1<IndexRow>(env, sql),
        fetchTableMax(env, [table]),
      ]);
      return { rows, tableMax };
    } catch (e) {
      // Preserve the upstream_error contract callers rely on, regardless of
      // whether readD1 threw on non-2xx or a { success: false } body.
      throw new McpError('upstream_error', `name-resolver: ${(e as Error).message}`);
    }
  })();

  indexCache.set(kind, { fetchedAt: startedAt, value: promise });
  try {
    return await promise;
  } catch (e) {
    // Don't poison the cache with a failed lookup — but only evict OUR
    // entry, never a newer one a concurrent caller has since installed.
    if (indexCache.get(kind)?.value === promise) indexCache.delete(kind);
    throw e;
  }
}

function tryParseNumeric(input: number | string): number | null {
  if (typeof input === 'number' && Number.isFinite(input)) return input;
  if (typeof input === 'string' && /^\d+$/.test(input.trim())) return parseInt(input.trim(), 10);
  return null;
}

function matchTier(rows: IndexRow[], query: string): { tier: 'exact' | 'prefix' | 'contains'; hits: IndexRow[] } | null {
  const q = query.trim().toLowerCase();
  if (!q) return null;
  const exact = rows.filter((r) => r.name.toLowerCase() === q);
  if (exact.length > 0) return { tier: 'exact', hits: exact };
  const prefix = rows.filter((r) => r.name.toLowerCase().startsWith(q));
  if (prefix.length > 0) return { tier: 'prefix', hits: prefix };
  const contains = rows.filter((r) => r.name.toLowerCase().includes(q));
  if (contains.length > 0) return { tier: 'contains', hits: contains };
  return null;
}

async function resolveByName(env: Env, kind: Kind, input: number | string, mode: Mode): Promise<ResolutionResult> {
  const numeric = tryParseNumeric(input);
  if (numeric !== null) {
    return { id: numeric, resolved: 'numeric', ambiguous: false };
  }

  const { label, table } = KIND_CONFIG[kind];
  const { rows, tableMax } = await loadIndex(env, kind);
  const mirror = stampMirrorFreshness(rows, { table, tableMax });

  const match = matchTier(rows, String(input));
  if (!match) {
    // A miss is a claim about the MIRROR, not about ServiceTitan. Say so —
    // but only when the mirror cannot prove itself, so a plain typo against
    // a healthy mirror still gets a plain, readable error.
    const hedge =
      mirror._freshness === 'fresh'
        ? ''
        : ` (this is a miss in the taylor-ai D1 mirror \`${table}\`, whose freshness is ` +
          `${mirror._freshness} — it does NOT prove the record is absent from ServiceTitan. ` +
          `${mirror._warning ?? ''})`;
    throw new McpError('validation_error', `${label} not found: ${input}${hedge}`);
  }

  const sortedHits = [...match.hits].sort((a, b) => a.id - b.id);
  const ambiguous = sortedHits.length > 1;

  if (ambiguous && mode === 'write') {
    const candidatePreview = sortedHits.map((h) => `${h.id}:${h.name}`).join(', ');
    throw new McpError(
      'validation_error',
      `${label} ambiguous: "${input}" matches [${candidatePreview}]; pass numeric ID instead`
    );
  }

  return {
    id: sortedHits[0].id,
    resolved: match.tier,
    ambiguous,
    candidates: ambiguous ? sortedHits : undefined,
    mirror,
  };
}

export function resolveBusinessUnit(env: Env, input: number | string, mode: Mode): Promise<ResolutionResult> {
  return resolveByName(env, 'businessUnit', input, mode);
}

export function resolveTechnician(env: Env, input: number | string, mode: Mode): Promise<ResolutionResult> {
  return resolveByName(env, 'technician', input, mode);
}
