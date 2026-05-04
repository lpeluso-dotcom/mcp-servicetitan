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
  const url = `https://servicetitan-proxy/api/st/read?endpoint=${encodeURIComponent(endpoint)}`;
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
