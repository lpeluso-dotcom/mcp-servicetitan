// ============================================================
// d1.ts — Shared D1-read helper for D1-first tools.
//
// Hits servicetitan-proxy's `/api/sql/read` (SELECT/WITH only, enforced
// server-side AND here for defense-in-depth). All D1-first tools should
// import { readD1 } and call it directly — no per-tool fetch boilerplate.
//
// Response shape from servicetitan-proxy /api/sql/read:
//   { success: true,  results: Row[], meta: D1Meta }
//   { success: false, error: string }
// ============================================================

import type { Env } from './env';

export interface D1ReadResult<Row = Record<string, unknown>> {
  rows: Row[];
  meta?: unknown;
}

/**
 * Run a parameterized SELECT/WITH against servicetitan-proxy's D1.
 *
 * @throws if the SQL fails the SELECT/WITH gate or if the proxy returns
 *         non-2xx / `success: false`.
 */
export async function readD1<Row = Record<string, unknown>>(
  env: Env,
  sql: string,
  params: unknown[] = [],
): Promise<D1ReadResult<Row>> {
  const trimmed = sql.trim();
  if (!/^(SELECT|WITH)\b/i.test(trimmed)) {
    throw new Error('readD1: only SELECT/WITH statements are permitted');
  }

  const resp = await env.ST_PROXY.fetch('https://servicetitan-proxy/api/sql/read', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Sync-Key': env.MCP_SYNC_KEY,
    },
    body: JSON.stringify({ sql: trimmed, params }),
  });

  if (!resp.ok) {
    throw new Error(`readD1: proxy returned ${resp.status}`);
  }

  const data = (await resp.json()) as {
    success: boolean;
    results?: Row[];
    meta?: unknown;
    error?: string;
  };

  if (!data.success) {
    throw new Error(`readD1: ${data.error ?? 'unknown error'}`);
  }

  return { rows: data.results ?? [], meta: data.meta };
}
