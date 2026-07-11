// ============================================================
// st_run_report — ST native reporting (4-mode discriminator).
//
// ST's reporting API is a 3-step discovery + 1-step run pattern:
//   1. list_categories  — GET /reporting/v2/tenant/{tid}/report-categories
//   2. list_reports     — GET /reporting/v2/tenant/{tid}/report-category/{cat}/reports
//   3. describe_report  — GET /reporting/v2/tenant/{tid}/report-category/{cat}/reports/{id}
//   4. run              — POST /reporting/v2/tenant/{tid}/report-category/{cat}/reports/{id}/data/query
//
// Mandatory: describe_report before first run on an unknown reportId — the
// parameter schema is dynamic per report. The `parameters` array on `run`
// must match what describe_report returns.
//
// QUA-785 — ST API release #78 deprecated the old SYNCHRONOUS
// POST .../reports/{id}/data endpoint in favor of an async token pattern:
//   POST .../reports/{id}/data/query  → 200 (data inline, done) | 202 (+ token)
//   GET  data-queries/{token}         → 200 (data, done) | 202 (still pending)
//   DELETE data-queries/{token}       → best-effort cancel (frees ST's slot)
// `run` no longer calls the sync /data endpoint at all.
//
// UNVERIFIED WIRE CONTRACT: the token field name (`token` vs `queryToken` vs
// `id`) and the exact data-queries path (assumed tenant-scoped, matching every
// other endpoint in this file: /reporting/v2/tenant/{tid}/data-queries/{token})
// come from the Linear ticket's description of ST API release #78, NOT from a
// live probe or the (client-side-only, unfetchable) ST docs site. The code
// below fails loud with a diagnosable McpError — dumping the actual response
// keys it saw — the moment the live shape diverges from this assumption,
// rather than hanging or crashing opaquely. Needs a live smoke-test to confirm.
//
// canonical descriptor uses the run path (the actual data fetch).
// ============================================================
import { z } from 'zod';
import { McpError, mapUpstreamStatus } from '../../errors';
import { readST } from '../../st';
import { authHeaders } from '../../auth';
import { rewriteTenantPlaceholders } from '../../tenant';
import type { Env } from '../../env';
import type { ToolDef } from '../index';
import { defaultShaper } from '../../response-shape';

const ReportMode = z.enum(['list_categories', 'list_reports', 'describe_report', 'run']);

interface ReportParam {
  name: string;
  value: unknown;
}

interface Args {
  mode: z.infer<typeof ReportMode>;
  categoryId?: string | number;
  reportId?: string | number;
  parameters?: ReportParam[];
  page?: number;
  pageSize?: number;
  pollTimeoutSeconds?: number;
  /** Internal test-only override — NOT in zodSchema, never settable by a real
   * caller. Mirrors st_patch_service.ts's `_pollIntervalMs`/`_pollMaxAttempts`
   * convention: lets unit tests skip the real 2s wait between polls without
   * changing the elapsed-seconds math (which is derived from the nominal
   * POLL_INTERVAL_MS, not this override). */
  _pollIntervalMs?: number;
}

// Fixed poll cadence per QUA-785 (mirrors the QUA-91 durable-write polling
// convention: 90 × 2s = 180s default ceiling; error message reports real
// elapsed seconds). pollTimeoutSeconds overrides the ceiling, not the cadence.
const POLL_INTERVAL_MS = 2000;
const POLL_INTERVAL_SECONDS = POLL_INTERVAL_MS / 1000;
const DEFAULT_POLL_TIMEOUT_SECONDS = 180;

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Mirrors st.ts's private buildUrl for GET/POST-as-read calls through
// servicetitan-proxy's /api/st/read (accepts GET and POST; NOT DELETE — see
// cancelDataQuery below for the DELETE path). Not imported from st.ts because
// that function isn't exported and st.ts is protected (no edits without sign-off).
function readProxyUrl(path: string): string {
  return `https://servicetitan-proxy/api/st/read?endpoint=${encodeURIComponent(path)}`;
}

// Checks the assumed token field, then the two stated fallback aliases, in
// order. Returns null (not throw) so the caller can build a diagnostic error
// that dumps the actual keys seen — a wrong assumption must be instantly
// diagnosable, not a silent hang.
function extractQueryToken(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const obj = body as Record<string, unknown>;
  for (const key of ['token', 'queryToken', 'id']) {
    const v = obj[key];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return null;
}

// Best-effort cancel of a running data-query so we don't leave an orphaned
// query burning ST's concurrency slot after OUR poll loop gives up locally.
// DELETE isn't accepted by /api/st/read (GET/POST only — see st.ts) so this
// routes through /api/st/write's method-envelope, the established pattern
// for non-GET ST calls in this codebase (see write-tool-factory.ts,
// assign_technicians.ts). Any error here — network failure or non-2xx — is
// swallowed; it must never mask the real timeout error the caller throws.
async function cancelDataQuery(
  env: Env,
  ctx: { actor: string; correlation: string },
  token: string
): Promise<void> {
  try {
    const endpoint = rewriteTenantPlaceholders(
      env,
      `/reporting/v2/tenant/000000000/data-queries/${token}`
    );
    await env.ST_PROXY.fetch('https://servicetitan-proxy/api/st/write', {
      method: 'POST',
      headers: {
        ...authHeaders(env, ctx.correlation, ctx.actor),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ endpoint, method: 'DELETE', payload: {} }),
    });
  } catch {
    // best-effort — swallow
  }
}

// Poll GET data-queries/{token} at a fixed 2s cadence until 200 (done), a
// non-200/202 status (fail loud), or the pollTimeoutSeconds ceiling is
// exceeded (best-effort cancel, then fail loud with real elapsed seconds).
async function pollDataQuery(
  env: Env,
  ctx: { actor: string; correlation: string },
  token: string,
  pollTimeoutSeconds: number,
  pollIntervalMsOverride: number | undefined
): Promise<unknown> {
  const { actor, correlation } = ctx;
  const sleepMs = pollIntervalMsOverride ?? POLL_INTERVAL_MS;
  const maxAttempts = Math.max(1, Math.round(pollTimeoutSeconds / POLL_INTERVAL_SECONDS));
  const pollPath = rewriteTenantPlaceholders(
    env,
    `/reporting/v2/tenant/000000000/data-queries/${token}`
  );

  for (let i = 0; i < maxAttempts; i++) {
    if (i > 0) await sleep(sleepMs);
    const resp = await env.ST_PROXY.fetch(readProxyUrl(pollPath), {
      headers: authHeaders(env, correlation, actor),
    });

    if (resp.status === 200) {
      return await resp.json();
    }
    if (resp.status === 202) {
      continue;
    }

    const text = await resp.text().catch(() => '');
    const elapsedSeconds = (i + 1) * POLL_INTERVAL_SECONDS;
    throw new McpError(
      mapUpstreamStatus(resp.status),
      `report query ${token} poll failed: GET data-queries/${token} returned ${resp.status} after ${elapsedSeconds}s (attempt ${i + 1}/${maxAttempts}): ${text.slice(0, 200)}`,
      { correlation }
    );
  }

  // Ceiling exceeded locally — best-effort cancel so we don't burn ST's
  // concurrency slot with an orphaned query, THEN fail loud with real
  // elapsed seconds (mirrors QUA-91's durable-write timeout fix).
  await cancelDataQuery(env, { actor, correlation }, token);
  const elapsedSeconds = maxAttempts * POLL_INTERVAL_SECONDS;
  throw new McpError(
    'timeout',
    `report query ${token} timed out after ${elapsedSeconds}s (requested ceiling ${pollTimeoutSeconds}s) — canceled`,
    { correlation }
  );
}

// POST .../data/query and either return the inline 200 result, or extract a
// 202 token and hand off to pollDataQuery. Implemented with a raw ST_PROXY
// fetch (not readSTPost) because readSTPost only surfaces the parsed 2xx
// body — it can't distinguish 200 (done) from 202 (pending, contains a
// token), both of which are `resp.ok` at the fetch layer. See st.ts's
// readSTPost: it throws on !resp.ok and otherwise returns resp.json() with
// no status passed through, so 202 would be silently treated the same as
// 200 with no way to see the token.
async function runReportQueryAsync(
  env: Env,
  ctx: { actor: string; correlation: string },
  categoryId: string | number,
  reportId: string | number,
  runBody: Record<string, unknown>,
  pollTimeoutSeconds: number,
  pollIntervalMsOverride: number | undefined
): Promise<unknown> {
  const { actor, correlation } = ctx;
  const queryPath = rewriteTenantPlaceholders(
    env,
    `/reporting/v2/tenant/000000000/report-category/${categoryId}/reports/${reportId}/data/query`
  );

  const initialResp = await env.ST_PROXY.fetch(readProxyUrl(queryPath), {
    method: 'POST',
    headers: { ...authHeaders(env, correlation, actor), 'content-type': 'application/json' },
    body: JSON.stringify(runBody),
  });

  if (initialResp.status === 200) {
    return await initialResp.json();
  }

  if (initialResp.status !== 202) {
    const text = await initialResp.text().catch(() => '');
    throw new McpError(
      mapUpstreamStatus(initialResp.status),
      `report data/query POST ${initialResp.status} on ${queryPath}: ${text.slice(0, 200)}`,
      { correlation }
    );
  }

  const body202 = await initialResp.json().catch(() => ({}));
  const token = extractQueryToken(body202);
  if (!token) {
    const keys = body202 && typeof body202 === 'object' ? Object.keys(body202 as object) : [];
    throw new McpError(
      'upstream_error',
      `report data/query returned 202 (still running) but no usable token field — checked token, queryToken, id, found none. Actual response keys seen: [${keys.join(', ')}]`,
      { correlation }
    );
  }

  return await pollDataQuery(env, { actor, correlation }, token, pollTimeoutSeconds, pollIntervalMsOverride);
}

export const st_run_report: ToolDef<Args> = {
  name: 'st_run_report',
  description:
    'Run or discover ServiceTitan native reports. Modes: list_categories | list_reports (requires categoryId) | describe_report (requires categoryId + reportId — MANDATORY before first run on unknown reportId; parameter schema is dynamic) | run (requires categoryId + reportId, takes parameters[]). ' +
    'run is now ASYNC (ST API release #78 deprecated the old synchronous POST .../data endpoint — it is no longer called): POSTs .../reports/{id}/data/query, which returns fast reports\' rows inline (200) or a token (202) for slow reports. On a token, this tool polls GET data-queries/{token} every 2s until ready (default ceiling 180s = 90 polls; override with pollTimeoutSeconds, max 600) and best-effort cancels (DELETE) if the local ceiling is hit before ST finishes. Source: live ST.',
  zodSchema: {
    mode: ReportMode.describe('Reporting workflow step'),
    categoryId: z
      .union([z.string(), z.number()])
      .optional()
      .describe('Report category ID — required for list_reports/describe_report/run'),
    reportId: z
      .union([z.string(), z.number()])
      .optional()
      .describe('Report ID — required for describe_report/run'),
    parameters: z
      .array(z.object({ name: z.string(), value: z.unknown() }))
      .optional()
      .describe('Parameter list for mode=run; shape per describe_report response'),
    page: z.number().int().positive().optional().describe('Page (run mode only, default 1)'),
    pageSize: z
      .number()
      .int()
      .positive()
      .max(5000)
      .optional()
      .describe('Page size (run mode only, default 100)'),
    pollTimeoutSeconds: z
      .number()
      .int()
      .positive()
      .max(600)
      .optional()
      .describe(
        'mode=run only. Ceiling (seconds) for polling a slow async report query before this tool cancels it and gives up. Default 180 (90 polls at a fixed 2s cadence). Max 600. Raise this for known-slow reports.'
      ),
  },
  stEndpoint: {
    method: 'POST',
    path: '/reporting/v2/tenant/{tid}/report-category/{cat}/reports/{reportId}/data/query',
    source: 'live',
  },
  async handler(env, args, { actor, correlation }) {
    // Per-mode required-arg validation (zod refinement is a flat object so we do it here).
    // `asserts cond` lets TS narrow the checked expression (e.g. `args.categoryId !==
    // undefined`) for the rest of this function, same as an equivalent `if` guard would —
    // this is what lets categoryId/reportId reach runReportQueryAsync below as
    // `string | number` without a cast.
    const requireArg: (cond: unknown, msg: string) => asserts cond = (cond, msg) => {
      if (!cond) {
        throw new McpError('validation_error', msg, { correlation });
      }
    };
    const tid = '000000000';

    if (args.mode === 'list_categories') {
      const data = await readST<{ data?: unknown[] }>(
        env,
        { actor, correlation },
        `/reporting/v2/tenant/${tid}/report-categories`,
      );
      return { mode: 'list_categories', categories: data.data ?? data, _source: 'live' };
    }

    if (args.mode === 'list_reports') {
      requireArg(args.categoryId !== undefined, 'categoryId required for mode=list_reports');
      const data = await readST<{ data?: unknown[] }>(
        env,
        { actor, correlation },
        `/reporting/v2/tenant/${tid}/report-category/${args.categoryId}/reports`,
      );
      return {
        mode: 'list_reports',
        categoryId: args.categoryId,
        reports: data.data ?? data,
        _source: 'live',
      };
    }

    if (args.mode === 'describe_report') {
      requireArg(args.categoryId !== undefined, 'categoryId required for mode=describe_report');
      requireArg(args.reportId !== undefined, 'reportId required for mode=describe_report');
      const data = await readST<unknown>(
        env,
        { actor, correlation },
        `/reporting/v2/tenant/${tid}/report-category/${args.categoryId}/reports/${args.reportId}`,
      );
      return {
        mode: 'describe_report',
        categoryId: args.categoryId,
        reportId: args.reportId,
        report: data,
        _source: 'live',
      };
    }

    // mode === 'run'
    requireArg(args.categoryId !== undefined, 'categoryId required for mode=run');
    requireArg(args.reportId !== undefined, 'reportId required for mode=run');
    requireArg(
      Array.isArray(args.parameters),
      'parameters[] required for mode=run (use describe_report to discover the schema)'
    );

    const runBody: Record<string, unknown> = {
      parameters: args.parameters,
      pageSize: args.pageSize ?? 100,
      page: args.page ?? 1,
    };

    const pollTimeoutSeconds = args.pollTimeoutSeconds ?? DEFAULT_POLL_TIMEOUT_SECONDS;

    const data = await runReportQueryAsync(
      env,
      { actor, correlation },
      args.categoryId,
      args.reportId,
      runBody,
      pollTimeoutSeconds,
      args._pollIntervalMs,
    );

    return {
      mode: 'run',
      categoryId: args.categoryId,
      reportId: args.reportId,
      data,
      _source: 'live',
    };
  },
  transformResult: defaultShaper,
};
