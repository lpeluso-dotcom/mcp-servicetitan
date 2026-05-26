// ============================================================
// d1-proxy.ts — shared helper for cross-worker D1 reads against
// taylor-ai via the servicetitan-proxy /api/sql/read endpoint.
//
// Consolidates the previously-inlined queryD1 helpers that lived in
// search_pricebook_all.ts, search_pricebook_services.ts,
// search_materials.ts, and identify_tech_by_phone.ts. Adds:
//   - Retry-with-backoff on transient failures (429, 5xx, network)
//   - Transient/terminal classification (no retry on 4xx-other)
//   - Correlation threading via the metric() helper so failures land
//     in the audit_log surface alongside the originating tool
//
// QUA-267 finding 3 (2026-05-26): callers like search_pricebook_all
// previously returned a single naked "d1 read failed: 500" with no
// retry and no breadcrumb. Now masking ~95% of transient flakes.
// ============================================================

import { metric } from './obs';
import type { Env } from './env';

const MAX_RETRIES = 2; // 1 initial + 2 retries = 3 attempts total
const BACKOFF_MS = [50, 200] as const; // applied between attempts

export class D1ProxyError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly transient: boolean,
    public readonly attempts: number,
  ) {
    super(message);
    this.name = 'D1ProxyError';
  }
}

interface QueryD1Options {
  /**
   * Correlation id for audit_log threading. Pass through from the
   * tool's ToolContext.correlation. Surfaces in metric writes and
   * D1ProxyError's wire shape.
   */
  correlation?: string;
  /**
   * Tag for observability — usually the calling tool's name
   * (`search_pricebook_all`, `identify_tech_by_phone`, etc.). Surfaces
   * in MCP_METRICS as the `tool` index.
   */
  tag?: string;
}

interface D1Envelope<T> {
  success: boolean;
  results?: T[];
  error?: string;
}

/**
 * Issue a SQL read against taylor-ai's D1 via the servicetitan-proxy
 * service binding, with retry-on-transient.
 *
 * Returns `data.results ?? []` on success. Throws `D1ProxyError` on
 * terminal failure or after all retries are exhausted.
 *
 * @param env  Worker env (must have ST_PROXY + MCP_SYNC_KEY bindings)
 * @param sql  Parameterized SQL string ($1, $2 / ? style — proxy decides)
 * @param params Positional params bound at the proxy layer
 * @param options correlation + tag for observability
 */
export async function queryD1<T = unknown>(
  env: Env,
  sql: string,
  params: unknown[],
  options: QueryD1Options = {},
): Promise<T[]> {
  const { correlation, tag = 'd1-proxy' } = options;
  let lastError: { status: number; message: string; transient: boolean } | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const startedAt = Date.now();
    try {
      const resp = await env.ST_PROXY.fetch('https://servicetitan-proxy/api/sql/read', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Sync-Key': env.MCP_SYNC_KEY },
        body: JSON.stringify({ sql, params }),
      });

      if (!resp.ok) {
        const transient = isTransientStatus(resp.status);
        lastError = {
          status: resp.status,
          message: `d1 read failed: ${resp.status}`,
          transient,
        };
        emitMetric(env, tag, 'error', Date.now() - startedAt, correlation, attempt);
        if (!transient) {
          // Terminal failure: 400, 401, 403, 404 won't get better.
          throw new D1ProxyError(lastError.message, resp.status, false, attempt + 1);
        }
        // Transient — backoff + retry if we have attempts left.
      } else {
        const data = (await resp.json()) as D1Envelope<T>;
        if (!data.success) {
          // success:false from proxy is treated as terminal — the SQL
          // is malformed or the row doesn't exist; retrying won't help.
          lastError = {
            status: resp.status,
            message: data.error || 'd1 read returned success=false',
            transient: false,
          };
          emitMetric(env, tag, 'error', Date.now() - startedAt, correlation, attempt);
          throw new D1ProxyError(lastError.message, resp.status, false, attempt + 1);
        }
        emitMetric(env, tag, 'ok', Date.now() - startedAt, correlation, attempt);
        return data.results ?? [];
      }
    } catch (err) {
      if (err instanceof D1ProxyError) throw err; // terminal — propagate immediately
      // Network / fetch errors are transient.
      lastError = {
        status: 0,
        message: `d1 read network error: ${(err as Error).message}`,
        transient: true,
      };
      emitMetric(env, tag, 'error', Date.now() - startedAt, correlation, attempt);
    }

    // If we get here, the attempt was transient. Backoff before retry.
    if (attempt < MAX_RETRIES) {
      const delay = BACKOFF_MS[attempt] ?? BACKOFF_MS[BACKOFF_MS.length - 1];
      await sleep(delay);
    }
  }

  // All retries exhausted.
  throw new D1ProxyError(
    lastError?.message ?? 'd1 read failed: unknown',
    lastError?.status ?? 0,
    true,
    MAX_RETRIES + 1,
  );
}

/**
 * Convenience wrapper for the common "first row or null" pattern.
 */
export async function queryD1First<T = unknown>(
  env: Env,
  sql: string,
  params: unknown[],
  options: QueryD1Options = {},
): Promise<T | null> {
  const rows = await queryD1<T>(env, sql, params, options);
  return rows[0] ?? null;
}

function isTransientStatus(status: number): boolean {
  return status === 429 || status === 408 || (status >= 500 && status < 600);
}

function emitMetric(
  env: Env,
  tag: string,
  status: 'ok' | 'error',
  latency_ms: number,
  correlation: string | undefined,
  attempt: number,
): void {
  try {
    metric(env, {
      tool: tag,
      latency_ms,
      status,
      source: correlation ? `d1-proxy attempt=${attempt} corr=${correlation}` : `d1-proxy attempt=${attempt}`,
    });
  } catch {
    // Best-effort observability — never block the read on metric failure.
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
