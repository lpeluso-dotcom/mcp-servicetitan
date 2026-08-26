// ============================================================
// st_run_report — ST native reporting (4-mode discriminator).
//
// ST's reporting API is a 3-step discovery + 1-step run pattern:
//   1. list_categories  — GET /reporting/v2/tenant/{tid}/report-categories
//   2. list_reports     — GET /reporting/v2/tenant/{tid}/report-category/{cat}/reports
//   3. describe_report  — GET /reporting/v2/tenant/{tid}/report-category/{cat}/reports/{id}
//   4. run              — POST .../reports/{id}/data/query   (ASYNC, ST-78)
//
// QUA-785 / F-08 — ST API release #78 deprecated the old SYNCHRONOUS
// POST .../reports/{id}/data endpoint (which also silently ignored body-level
// paging) in favor of an async token pattern:
//   POST .../reports/{id}/data/query  → 200 (rows inline, done) | 202 (+ token)
//   GET  data-queries/{token}         → 200 (rows, done)        | 202 (pending)
//   DELETE data-queries/{token}       → best-effort cancel (frees ST's slot)
//
// The Wave 2 429-containment layer is preserved: a same-report repeat inside
// REPORT_RUN_TTL_SEC is served from D1's mcp_cache, and a real ST 429 arms a
// tool-wide post-429 cooldown. The async POST is routed through guardedStFetch
// so the reporting-family limiter /check still fires with the report identity
// (readSTPost can't be used here: 202 is resp.ok, so it can't tell "done" from
// "pending, here's a token").
//
// UNVERIFIED WIRE CONTRACT: the 202 token field name (`token` vs `queryToken`
// vs `id`) and the tenant-scoped data-queries path come from ST-78's release
// notes, not a live probe. The code fails loud — dumping the actual response
// keys it saw — the moment the live shape diverges, rather than hanging or
// crashing opaquely. Needs one live smoke-test to confirm before merge.
// ============================================================
import { z } from 'zod';
import { McpError, mapUpstreamStatus } from '../../errors';
import { readST } from '../../st';
import { cacheGet } from '../../cache';
import { authHeaders } from '../../auth';
import { rewriteTenantPlaceholders } from '../../tenant';
import { guardedStFetch, parseRetryAfterSeconds } from '../../rate-limit-guard';
import type { Env } from '../../env';
import type { ToolDef } from '../index';
import { defaultShaper } from '../../response-shape';

/** Result-cache namespace and TTL for mode=run. */
export const REPORT_CACHE_NS = 'servicetitan:report_run';
export const REPORT_RUN_TTL_SEC = 300; // 5 minutes

/** Fixed poll cadence and default ceiling (wall-clock) for the async run. */
const POLL_INTERVAL_MS = 2000;
const DEFAULT_POLL_TIMEOUT_SECONDS = 180;

/**
 * Epoch ms until which mode=run fails fast. Keyed to the whole tool, not one
 * report: an ST 429 means the TENANT is throttled, so a 429 on report A
 * predicts a 429 on report B. Deliberately NOT armed by the limiter's
 * same-report rejection — that is per report identity, and blocking every
 * other report for a minute because one report repeated would be its own bug.
 */
let reportRunCooldownUntil = 0;

/** Test seam — resets the isolate-local cooldown. */
export function _resetReportCooldown(): void {
  reportRunCooldownUntil = 0;
}

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
  /** Test seam — poll cadence override (not in zodSchema, never settable by a real caller). */
  _pollIntervalMs?: number;
  /** Test seam — injectable clock so the wall-clock deadline is testable without real waits. */
  _now?: () => number;
}

/**
 * The canonical identity of one report RUN: the report itself plus every input
 * that changes the rows it returns. Used for BOTH the result-cache key and the
 * limiter identity so the two can never disagree. Parameters are sorted by name
 * so `[From, To]` and `[To, From]` are the same report. page/pageSize are
 * included — page 2 is a DIFFERENT run (excluding them would make pagination
 * unusable; if ST counts paged calls as repeats, this is the line to change).
 */
export function reportRunIdentity(args: {
  categoryId?: string | number;
  reportId?: string | number;
  parameters?: ReportParam[];
  page: unknown;
  pageSize: unknown;
}): string {
  const params = [...(args.parameters ?? [])].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return JSON.stringify({
    c: String(args.categoryId),
    r: String(args.reportId),
    p: args.page,
    s: args.pageSize,
    params,
  });
}

/** servicetitan-proxy read URL (GET/POST-as-read; NOT DELETE — see cancelDataQuery). */
function readProxyUrl(path: string): string {
  return `https://servicetitan-proxy/api/st/read?endpoint=${encodeURIComponent(path)}`;
}

/** Checks the assumed token field, then the two stated aliases, in order. */
function extractQueryToken(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const obj = body as Record<string, unknown>;
  for (const key of ['token', 'queryToken', 'id']) {
    const v = obj[key];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return null;
}

/**
 * Best-effort cancel of a running data-query so we don't leave an orphaned
 * query burning ST's concurrency slot after OUR poll loop gives up locally.
 * DELETE isn't accepted by /api/st/read (GET/POST only) so this routes through
 * /api/st/write's method-envelope, the established non-GET pattern in this
 * codebase. Any error here is swallowed — it must never mask the real timeout.
 */
async function cancelDataQuery(
  env: Env,
  ctx: { actor: string; correlation: string },
  token: string,
): Promise<void> {
  try {
    const endpoint = rewriteTenantPlaceholders(env, `/reporting/v2/tenant/000000000/data-queries/${token}`);
    await env.ST_PROXY.fetch('https://servicetitan-proxy/api/st/write', {
      method: 'POST',
      headers: { ...authHeaders(env, ctx.correlation, ctx.actor), 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint, method: 'DELETE', payload: {} }),
    });
  } catch {
    // best-effort — swallow
  }
}

/**
 * Poll GET data-queries/{token} at a fixed cadence until 200 (done), a
 * non-200/202 status (fail loud, no upstream body echoed — B3), or the
 * WALL-CLOCK ceiling is exceeded (B1). The ceiling is real elapsed time, not
 * attempts × interval, so a report whose every poll hangs still trips it. No
 * fetch is issued once the deadline has passed (B4).
 */
async function pollDataQuery(
  env: Env,
  ctx: { actor: string; correlation: string },
  token: string,
  pollTimeoutSeconds: number,
  opts: { pollIntervalMs?: number; now?: () => number },
): Promise<unknown> {
  const now = opts.now ?? Date.now;
  const sleepMs = opts.pollIntervalMs ?? POLL_INTERVAL_MS;
  const start = now();
  const deadline = start + pollTimeoutSeconds * 1000;
  const pollPath = rewriteTenantPlaceholders(env, `/reporting/v2/tenant/000000000/data-queries/${token}`);

  let attempt = 0;
  while (now() < deadline) {
    if (attempt > 0 && sleepMs > 0) await new Promise((r) => setTimeout(r, sleepMs));
    if (now() >= deadline) break; // B4: never issue a fetch past the deadline
    attempt++;

    const resp = await env.ST_PROXY.fetch(readProxyUrl(pollPath), {
      headers: authHeaders(env, ctx.correlation, ctx.actor),
    });

    if (resp.status === 200) {
      return await resp.json();
    }
    if (resp.status === 202) {
      continue;
    }

    // B3: report the status, not the upstream body.
    throw new McpError(
      mapUpstreamStatus(resp.status),
      `report query poll failed: upstream returned ${resp.status} (correlation ${ctx.correlation})`,
      { correlation: ctx.correlation },
    );
  }

  // Ceiling exceeded locally — best-effort cancel so we don't burn ST's
  // concurrency slot with an orphaned query, THEN fail loud with real elapsed.
  await cancelDataQuery(env, ctx, token);
  const elapsedSeconds = Math.round((now() - start) / 1000);
  throw new McpError(
    'timeout',
    `report query ${token} timed out after ${elapsedSeconds}s (ceiling ${pollTimeoutSeconds}s) — canceled`,
    { correlation: ctx.correlation },
  );
}

/**
 * POST .../data/query and either return the inline 200 result, or extract the
 * 202 token and hand off to pollDataQuery. Routed through guardedStFetch so the
 * reporting-family limiter /check fires with the report identity (the same gate
 * readSTPost uses) while we still see the raw 200-vs-202 status.
 */
export async function runReportQueryAsync(
  env: Env,
  ctx: { actor: string; correlation: string },
  categoryId: string | number,
  reportId: string | number,
  runBody: Record<string, unknown>,
  pollTimeoutSeconds: number,
  opts: { identity: string; pollIntervalMs?: number; now?: () => number },
): Promise<unknown> {
  const queryPath = rewriteTenantPlaceholders(
    env,
    `/reporting/v2/tenant/000000000/report-category/${categoryId}/reports/${reportId}/data/query`,
  );

  const initialResp = await guardedStFetch(
    env,
    queryPath,
    () =>
      env.ST_PROXY.fetch(readProxyUrl(queryPath), {
        method: 'POST',
        headers: { ...authHeaders(env, ctx.correlation, ctx.actor), 'content-type': 'application/json' },
        body: JSON.stringify(runBody),
      }),
    { identity: opts.identity },
  );

  if (initialResp.status === 200) {
    return await initialResp.json();
  }

  if (initialResp.status !== 202) {
    if (initialResp.status === 429) {
      throw new McpError(
        'rate_limited',
        `report data/query rate-limited by ServiceTitan (correlation ${ctx.correlation})`,
        {
          correlation: ctx.correlation,
          retry_after_ms: parseRetryAfterSeconds(initialResp.headers.get('Retry-After')) * 1000,
        },
      );
    }
    // B3: no upstream body echoed.
    throw new McpError(
      mapUpstreamStatus(initialResp.status),
      `report data/query POST failed: upstream returned ${initialResp.status} (correlation ${ctx.correlation})`,
      { correlation: ctx.correlation },
    );
  }

  const body202 = await initialResp.json().catch(() => ({}));
  const token = extractQueryToken(body202);
  if (!token) {
    const keys = body202 && typeof body202 === 'object' ? Object.keys(body202 as object) : [];
    throw new McpError(
      'upstream_error',
      `report data/query returned 202 (still running) but no usable token field — checked token, queryToken, id, found none. Actual response keys seen: [${keys.join(', ')}]`,
      { correlation: ctx.correlation },
    );
  }

  return await pollDataQuery(env, ctx, token, pollTimeoutSeconds, {
    pollIntervalMs: opts.pollIntervalMs,
    now: opts.now,
  });
}

export const st_run_report: ToolDef<Args> = {
  name: 'st_run_report',
  description:
    'Run or discover ServiceTitan native reports. Modes: list_categories | list_reports (requires categoryId) | describe_report (requires categoryId + reportId — MANDATORY before first run on unknown reportId; parameter schema is dynamic) | run (requires categoryId + reportId, takes parameters[]). ' +
    'run is ASYNC (ST-78 deprecated the old synchronous POST .../data endpoint — it is no longer called): POSTs .../reports/{id}/data/query, which returns fast reports\' rows inline (200) or a token (202) for slow reports. On a token, this tool polls GET data-queries/{token} every 2s until ready, to a WALL-CLOCK ceiling (default 180s; override with pollTimeoutSeconds, max 600), and best-effort cancels (DELETE) if the ceiling is hit. A same-report repeat inside 5 minutes is served from cache and costs no ST request. Source: live ST.',
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
        'mode=run only. Wall-clock ceiling (seconds) for polling a slow async report query before this tool cancels it and gives up. Default 180. Max 600. Raise for known-slow reports.',
      ),
  },
  stEndpoint: {
    method: 'POST',
    path: '/reporting/v2/tenant/{tid}/report-category/{cat}/reports/{reportId}/data/query',
    source: 'live',
  },
  async handler(env, args, { actor, correlation }) {
    // Per-mode required-arg validation. `asserts cond` narrows the checked
    // expression for the rest of this function (so categoryId/reportId reach
    // runReportQueryAsync as string|number without a cast).
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
      'parameters[] required for mode=run (use describe_report to discover the schema)',
    );

    const runBody: Record<string, unknown> = {
      parameters: args.parameters,
      pageSize: args.pageSize ?? 100,
      page: args.page ?? 1,
    };
    const now = args._now ?? Date.now;

    // ── post-429 cooldown ─────────────────────────────────────
    // Checked only on the path that would hit upstream. A cache hit never
    // reaches here in a way that rejects — the cache read-through resolves
    // inside cacheGet below without entering the miss() upstream path.
    const nowMs = now();
    if (reportRunCooldownUntil > nowMs) {
      const remainingMs = reportRunCooldownUntil - nowMs;
      throw new McpError(
        'rate_limited',
        `st_run_report: ServiceTitan's reporting API returned 429 recently; mode=run is in a ` +
          `${Math.ceil(remainingMs / 1000)}s cooldown. Retry after that, or re-run a report you already ` +
          `pulled in the last ${REPORT_RUN_TTL_SEC / 60} minutes (it is served from cache and costs nothing).`,
        { correlation, retry_after_ms: remainingMs },
      );
    }

    const identity = reportRunIdentity({
      categoryId: args.categoryId,
      reportId: args.reportId,
      parameters: args.parameters,
      page: runBody.page,
      pageSize: runBody.pageSize,
    });

    let hitUpstream = false;
    let data: unknown;
    try {
      data = await cacheGet<unknown>(env, REPORT_CACHE_NS, identity, REPORT_RUN_TTL_SEC, async () => {
        hitUpstream = true;
        return runReportQueryAsync(
          env,
          { actor, correlation },
          args.categoryId!,
          args.reportId!,
          runBody,
          args.pollTimeoutSeconds ?? DEFAULT_POLL_TIMEOUT_SECONDS,
          { identity, pollIntervalMs: args._pollIntervalMs, now: args._now },
        );
      });
    } catch (err) {
      // An ST 429 means the TENANT is throttled — arm the tool-wide cooldown
      // from the error's own retry_after_ms. The limiter's same-report
      // rejection is NOT that: it is scoped to one report identity, and arming
      // a tool-wide cooldown from it would block every other report.
      if (
        err instanceof McpError &&
        err.code === 'rate_limited' &&
        (err.details as { reason?: string } | undefined)?.reason !== 'same_report_within_window'
      ) {
        reportRunCooldownUntil = now() + (err.retry_after_ms ?? 60_000);
      }
      throw err;
    }

    return {
      mode: 'run',
      categoryId: args.categoryId,
      reportId: args.reportId,
      data,
      _source: hitUpstream ? 'live' : 'cache',
      ...(hitUpstream ? {} : { _cache_ttl_seconds: REPORT_RUN_TTL_SEC }),
    };
  },
  transformResult: defaultShaper,
};
