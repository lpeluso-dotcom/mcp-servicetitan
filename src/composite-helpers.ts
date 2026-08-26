// ============================================================
// composite-helpers.ts — F3 fanout helper for L5 composites.
//
// Wraps Promise.allSettled around an array of named fetches and
// extracts JSON, returning a structured result with explicit
// per-call failure reporting:
//
//   { results: {name: data | null}, partial: bool, failures: [...] }
//
// Replaces the inline `extract` pattern in customer_snapshot and
// job_closeout_report which mixed { error: msg } into result data
// with no top-level partial-failure signal.
// ============================================================

import type { Env } from './env';
import { rewriteTenantPlaceholders } from './tenant';
import { guardedStFetch } from './rate-limit-guard';

/**
 * Extract the `data` payload from a servicetitan-proxy/ST response shape, falling back
 * to the root object only when there is no `data` key (vs taking the wrapper
 * literally when `data` is undefined or null — the latter is a shape leak).
 */
export function extractStData<T = unknown>(json: unknown): T {
  if (json !== null && typeof json === 'object' && 'data' in json) {
    return (json as { data: T }).data;
  }
  return json as T;
}

/**
 * Build a fetch promise to servicetitan-proxy's `/api/st/read` proxy with a
 * URL-encoded ST endpoint. Used by composite fanouts; single-fetch tools
 * still inline the URL (migrating them is a v1.2 mechanical pass).
 */
export function stRead(
  env: Env,
  headers: Record<string, string>,
  endpoint: string,
  signal?: AbortSignal
): Promise<Response> {
  // Resolve the /tenant/000000000/ placeholder at the call site (authoritative;
  // the withTenantRewrite ST_PROXY wrapper was unreliable and has been retired).
  // No-op when the caller already interpolated the real env.ST_TENANT_ID.
  const url = `https://servicetitan-proxy/api/st/read?endpoint=${encodeURIComponent(rewriteTenantPlaceholders(env, endpoint))}`;
  return env.ST_PROXY.fetch(url, signal ? { headers, signal } : { headers });
}

export interface FanoutFailure {
  call: string;
  error_class: string;
  message: string;
}

export interface FanoutResult<T = unknown> {
  results: Record<string, T | null>;
  partial: boolean;
  failures: FanoutFailure[];
}

export interface NamedCall {
  name: string;
  promise: Promise<Response>;
}

function tagged(name: string, message: string): Error {
  const err = new Error(message);
  err.name = name;
  return err;
}

/**
 * Fan out a set of fetches in parallel and collect results, attributing
 * any failure to the responsible call by name. JSON parsing happens
 * inside the promise chain so the parses interleave instead of
 * serializing in a post-allSettled loop, and parse errors land in the
 * same rejection path as network/HTTP failures (collapses three branches
 * to one). JSON extraction follows the servicetitan-proxy shape via extractStData.
 */
export async function gatherFetches(calls: NamedCall[]): Promise<FanoutResult> {
  const settled = await Promise.allSettled(
    calls.map(async (c) => {
      const resp = await c.promise;
      if (!resp.ok) {
        throw tagged('HTTPError', `${resp.status} ${resp.statusText || ''}`.trim());
      }
      try {
        const json = await resp.json<unknown>();
        return extractStData(json);
      } catch (e) {
        throw tagged('JSONParseError', e instanceof Error ? e.message : String(e));
      }
    })
  );

  const results: Record<string, unknown> = {};
  const failures: FanoutFailure[] = [];
  for (let i = 0; i < settled.length; i++) {
    const name = calls[i].name;
    const res = settled[i];
    if (res.status === 'fulfilled') {
      results[name] = res.value;
    } else {
      results[name] = null;
      const err = res.reason instanceof Error ? res.reason : new Error(String(res.reason));
      failures.push({
        call: name,
        error_class: err.name || 'Error',
        message: err.message || String(res.reason),
      });
    }
  }

  return { results, partial: failures.length > 0, failures };
}

/** Like extractStData, but also reports ST's top-level `hasMore` flag. */
function extractStPage<T = unknown>(json: unknown): { data: T; hasMore: boolean } {
  if (json !== null && typeof json === 'object') {
    const obj = json as { data?: T; hasMore?: boolean };
    if ('data' in obj) return { data: obj.data as T, hasMore: obj.hasMore === true };
  }
  return { data: json as T, hasMore: false };
}

/**
 * A `stRead` routed through `guardedStFetch`, so a composite fanout consults the
 * ST family rate limiter instead of firing raw parallel calls that ignore the
 * cap (F-11). The family is parsed from the (tenant-resolved) endpoint by
 * guardedStFetch, matching the gate every single-fetch read already uses.
 */
export function stReadGuarded(
  env: Env,
  headers: Record<string, string>,
  endpoint: string,
  signal?: AbortSignal,
): Promise<Response> {
  return guardedStFetch(env, rewriteTenantPlaceholders(env, endpoint), () =>
    stRead(env, headers, endpoint, signal),
  );
}

/**
 * gatherFetches + per-arm truncation disclosure. `results` is byte-identical to
 * gatherFetches (the `.data` arrays); `truncated` names every arm whose ST
 * response carried `hasMore: true`, so a caller can DISCLOSE an incomplete
 * answer (and decline to cache it) instead of serving page one as if it were
 * the whole set (F-11). A FAILED arm never appears in `truncated` — only a
 * successful arm can be observed to have more pages.
 */
export async function gatherFetchesWithTruncation(
  calls: NamedCall[],
): Promise<FanoutResult & { truncated: string[] }> {
  const settled = await Promise.allSettled(
    calls.map(async (c) => {
      const resp = await c.promise;
      if (!resp.ok) {
        throw tagged('HTTPError', `${resp.status} ${resp.statusText || ''}`.trim());
      }
      try {
        return extractStPage(await resp.json<unknown>());
      } catch (e) {
        throw tagged('JSONParseError', e instanceof Error ? e.message : String(e));
      }
    }),
  );

  const results: Record<string, unknown> = {};
  const failures: FanoutFailure[] = [];
  const truncated: string[] = [];
  for (let i = 0; i < settled.length; i++) {
    const name = calls[i].name;
    const res = settled[i];
    if (res.status === 'fulfilled') {
      results[name] = res.value.data;
      if (res.value.hasMore) truncated.push(name);
    } else {
      results[name] = null;
      const err = res.reason instanceof Error ? res.reason : new Error(String(res.reason));
      failures.push({
        call: name,
        error_class: err.name || 'Error',
        message: err.message || String(res.reason),
      });
    }
  }

  return { results, partial: failures.length > 0, failures, truncated };
}

// Re-export the v1.4 paginated read helper so composite authors only need
// to import from this module to get the full live-read toolkit.
export { pagedStRead } from './paged-st-read';
export type { PagedReadOptions, PagedReadResult, PagedReadFailure } from './paged-st-read';
