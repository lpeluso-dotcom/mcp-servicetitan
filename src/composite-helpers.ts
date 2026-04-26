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

/**
 * Fan out a set of fetches in parallel and collect results, attributing
 * any failure to the responsible call by name. JSON extraction follows
 * the existing taylor-ai shape: prefer `data` wrapper, fall back to root.
 */
export async function gatherFetches(calls: NamedCall[]): Promise<FanoutResult> {
  const settled = await Promise.allSettled(calls.map((c) => c.promise));
  const results: Record<string, unknown> = {};
  const failures: FanoutFailure[] = [];

  for (let i = 0; i < settled.length; i++) {
    const name = calls[i].name;
    const res = settled[i];

    if (res.status === 'rejected') {
      results[name] = null;
      const err = res.reason instanceof Error ? res.reason : new Error(String(res.reason));
      failures.push({
        call: name,
        error_class: err.name || 'Error',
        message: err.message || String(res.reason),
      });
      continue;
    }

    const resp = res.value;
    if (!resp.ok) {
      results[name] = null;
      failures.push({
        call: name,
        error_class: 'HTTPError',
        message: `${resp.status} ${resp.statusText || ''}`.trim(),
      });
      continue;
    }

    try {
      const json = await resp.json<{ data?: unknown }>();
      results[name] = (json as { data?: unknown }).data ?? json;
    } catch (e) {
      results[name] = null;
      const err = e instanceof Error ? e : new Error(String(e));
      failures.push({
        call: name,
        error_class: 'JSONParseError',
        message: err.message,
      });
    }
  }

  return { results, partial: failures.length > 0, failures };
}
