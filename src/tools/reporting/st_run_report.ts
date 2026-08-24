// ============================================================
// st_run_report — ST native reporting (4-mode discriminator).
//
// ST's reporting API is a 3-step discovery + 1-step run pattern:
//   1. list_categories  — GET /reporting/v2/tenant/{tid}/report-categories
//   2. list_reports     — GET /reporting/v2/tenant/{tid}/report-category/{cat}/reports
//   3. describe_report  — GET /reporting/v2/tenant/{tid}/report-category/{cat}/reports/{id}
//   4. run              — POST /reporting/v2/tenant/{tid}/report-category/{cat}/reports/{id}/data
//
// Mandatory: describe_report before first run on an unknown reportId — the
// parameter schema is dynamic per report. The `parameters` array on `run`
// must match what describe_report returns.
//
// canonical descriptor uses the run path (the actual data fetch).
// ============================================================
import { z } from 'zod';
import { McpError } from '../../errors';
import { readST, readSTPost } from '../../st';
import { cacheGet } from '../../cache';
import type { ToolDef } from '../index';
import { defaultShaper } from '../../response-shape';

// ── Wave 2: 429 containment ─────────────────────────────────
//
// Reporting is the most expensive ST surface and FAMILY_CAP budgets it at
// 20/min. readSTPost is now gated, which stops us OVERSHOOTING. These two
// mechanisms handle what happens when ST throttles us anyway:
//
//   1. RESULT CACHE — an identical run (same category, report, parameters,
//      page, pageSize) inside the TTL is served from D1's mcp_cache instead
//      of spending an ST request. Reports are heavy and agents re-run them
//      verbatim; the TTL is deliberately short so the numbers stay current.
//   2. POST-429 COOLDOWN — after ST answers 429 we hold off `run` locally
//      for the Retry-After window and fail fast with a usable
//      retry_after_ms, rather than spending another request to be told the
//      same thing.
//
// Scope note on the cooldown: it is ISOLATE-LOCAL, not global. The global
// half of the reaction is reportBackoff(), which the readSTPost gate already
// fires into the StRateLimiter DO (halving the reporting cap for the penalty
// window) — that IS shared across isolates. This local gate is the cheap
// first line for the common case, an agent immediately retrying in the same
// isolate. It is deliberately not another DO round trip.

/** Result-cache namespace and TTL for mode=run. */
export const REPORT_CACHE_NS = 'servicetitan:report_run';
export const REPORT_RUN_TTL_SEC = 300; // 5 minutes

/**
 * Epoch ms until which mode=run fails fast. Keyed to the whole tool, not to
 * one report: an ST 429 means the TENANT is being throttled, so a 429 on
 * report A predicts a 429 on report B.
 *
 * Deliberately NOT armed by the limiter's same-report rejection — that one is
 * per report identity, and blocking every other report for a minute because
 * one report repeated would be its own "the server got slow" bug.
 */
let reportRunCooldownUntil = 0;

/** Test seam — resets the isolate-local cooldown. */
export function _resetReportCooldown(): void {
  reportRunCooldownUntil = 0;
}

/**
 * The canonical identity of one report RUN: the report itself plus every
 * input that changes the rows it returns.
 *
 * This single string is used for BOTH the result-cache key and the limiter's
 * `identity`, so the two can never disagree about what "the same report"
 * means. Parameters are sorted by name first — `[From, To]` and `[To, From]`
 * are the same report, and treating them as different would both miss the
 * cache and spend a second ST call against a limit that would reject it.
 *
 * Note on ST's wording: the docs say "1 of the same report per minute per
 * tenant" without defining whether paging counts as the same report. We
 * include page/pageSize in the identity, i.e. we treat page 2 as a DIFFERENT
 * run. Excluding them would make ordinary pagination unusable; if ST turns
 * out to count paged calls as repeats, this is the line to change.
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
}

export const st_run_report: ToolDef<Args> = {
  name: 'st_run_report',
  description:
    'Run or discover ServiceTitan native reports. Modes: list_categories | list_reports (requires categoryId) | describe_report (requires categoryId + reportId — MANDATORY before first run on unknown reportId; parameter schema is dynamic) | run (requires categoryId + reportId, takes parameters[]). POST .../reports/{id}/data is the data fetch (returns rows synchronously). Source: live ST. mode=run: default page size 100, max 5000.',
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
  },
  stEndpoint: {
    method: 'POST',
    path: '/reporting/v2/tenant/{tid}/report-category/{cat}/reports/{reportId}/data',
    source: 'live',
  },
  async handler(env, args, { actor, correlation }) {
    // Per-mode required-arg validation (zod refinement is a flat object so we do it here).
    const requireArg = (cond: unknown, msg: string) => {
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

    // ── post-429 cooldown ────────────────────────────────────
    const now = Date.now();
    if (reportRunCooldownUntil > now) {
      const remainingMs = reportRunCooldownUntil - now;
      throw new McpError(
        'rate_limited',
        `st_run_report: ServiceTitan's reporting API returned 429 recently; mode=run is in a ` +
          `${Math.ceil(remainingMs / 1000)}s cooldown. Retry after that, or re-run a report you already ` +
          `pulled in the last ${REPORT_RUN_TTL_SEC / 60} minutes (it is served from cache and costs nothing).`,
        { correlation, retry_after_ms: remainingMs },
      );
    }

    // ── short result cache ───────────────────────────────────
    // One canonical string is both the cache key and the limiter identity —
    // see reportRunIdentity. This cache is the REAL fix for st_run_report's
    // 429s: ST's reporting limit is "1 of the same report per minute", so the
    // 429s were repeat runs of the same report, and a repeat inside the TTL
    // now never leaves the Worker.
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
        return readSTPost<unknown>(
          env,
          { actor, correlation },
          `/reporting/v2/tenant/${tid}/report-category/${args.categoryId}/reports/${args.reportId}/data`,
          runBody,
          { identity },
        );
      });
    } catch (err) {
      // An ST 429 means the TENANT is throttled — arm the tool-wide cooldown
      // from the error's own retry_after_ms. The limiter's same-report
      // rejection is NOT that: it is scoped to one report identity, and
      // arming a tool-wide cooldown from it would block every other report.
      if (
        err instanceof McpError &&
        err.code === 'rate_limited' &&
        (err.details as { reason?: string } | undefined)?.reason !== 'same_report_within_window'
      ) {
        reportRunCooldownUntil = Date.now() + (err.retry_after_ms ?? 60_000);
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
