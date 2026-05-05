// ============================================================
// name-resolver.ts — v1.4 BU + technician name → ID resolver.
//
// Looks up business_units / technicians via the upstream proxy's queryD1 RPC
// (read-router.queryD1 contract) and memoizes the index in-process
// for the lifetime of the worker isolate. Tier match: exact >
// prefix > contains; first tier with one or more hits resolves.
//
// Asymmetric ambiguity:
//   - read mode: ambiguous → return first by ascending id with
//     ambiguous=true (caller surfaces _warnings).
//   - write mode: ambiguous → throw McpError('validation_error')
//     so callers can never silently address the wrong record.
//
// Numeric inputs pass through with no D1 hit.
// ============================================================

import type { Env } from './env';
import { authHeaders, newCorrelationId } from './auth';
import { McpError } from './errors';

export interface ResolutionResult {
  id: number;
  resolved: 'numeric' | 'exact' | 'prefix' | 'contains';
  ambiguous: boolean;
  candidates?: { id: number; name: string }[];
}

interface IndexRow {
  id: number;
  name: string;
}

type Mode = 'read' | 'write';
type Kind = 'businessUnit' | 'technician';

const KIND_CONFIG: Record<Kind, { sql: string; label: string }> = {
  businessUnit: {
    sql: 'SELECT bu_id AS id, name FROM business_units WHERE active = 1',
    label: 'businessUnitName',
  },
  technician: {
    sql: 'SELECT tech_id AS id, name FROM technicians WHERE active = 1',
    label: 'technicianName',
  },
};

// Per-isolate memo. Workers isolates are short-lived enough that staleness is
// bounded by isolate replacement (~minutes); 7-day BU sync makes this safe.
const indexCache = new Map<Kind, Promise<IndexRow[]>>();

export function _clearResolverCache(): void {
  indexCache.clear();
}

async function loadIndex(env: Env, kind: Kind): Promise<IndexRow[]> {
  const cached = indexCache.get(kind);
  if (cached) return cached;

  const promise = (async () => {
    const { sql } = KIND_CONFIG[kind];
    const resp = await env.ST_PROXY.fetch('https://servicetitan-proxy/internal/query-d1', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...authHeaders(env, newCorrelationId(), 'mcp-servicetitan-name-resolver'),
      },
      body: JSON.stringify({ sql, params: [] }),
    });
    if (!resp.ok) {
      throw new McpError('upstream_error', `name-resolver: queryD1 failed: ${resp.status}`);
    }
    const data = await resp.json<{ rows: IndexRow[]; updatedAt: number | null }>();
    return data.rows ?? [];
  })();

  indexCache.set(kind, promise);
  try {
    return await promise;
  } catch (e) {
    indexCache.delete(kind); // don't poison the cache with a failed lookup
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

  const { label } = KIND_CONFIG[kind];
  const rows = await loadIndex(env, kind);
  const match = matchTier(rows, String(input));
  if (!match) {
    throw new McpError('validation_error', `${label} not found: ${input}`);
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
  };
}

export function resolveBusinessUnit(env: Env, input: number | string, mode: Mode): Promise<ResolutionResult> {
  return resolveByName(env, 'businessUnit', input, mode);
}

export function resolveTechnician(env: Env, input: number | string, mode: Mode): Promise<ResolutionResult> {
  return resolveByName(env, 'technician', input, mode);
}
