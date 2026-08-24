// ============================================================
// st.ts — Shared live-ST read helper for tools that don't have a D1
// mirror (or are explicit live-only).
//
// Goals:
//   - One place where /api/st/read is hit, so future auth/header/rate-limit
//     changes touch a single file instead of every tool.
//   - Built-in pagination via readSTPaged() — most ST list endpoints
//     return { data, hasMore, page, pageSize, totalCount }; the helper
//     drains pages with a hard cap so a runaway loop can't be triggered.
//   - Filter-preservation discipline: callers pass a `query` record that
//     stringifies into the URL via URLSearchParams. The helper deliberately
//     does NOT silently drop any key the caller passes — if a filter is
//     unsupported by ST, the caller is responsible for rejecting it before
//     calling readST (see payroll_job_timesheets_list for that pattern).
//
// Response shape from ST list endpoints (via servicetitan-proxy):
//   { data: T[], hasMore: boolean, page: number, pageSize: number, totalCount?: number }
//
// Single-record GET endpoints return the resource directly (no envelope).
// ============================================================

import type { Env } from './env';
import { authHeaders } from './auth';
import { McpError, mapUpstreamStatus } from './errors';
import { guardedStFetch, parseRetryAfterSeconds } from './rate-limit-guard';
import { rewriteTenantPlaceholders } from './tenant';

export interface ReadSTContext {
  actor: string;
  correlation: string;
}

/**
 * Reject filter args that ST's list endpoints accept syntactically but
 * silently discard — the QUA-1054 / QUA-951 defect class.
 *
 * ST does not 400 on an unrecognized query param. It ignores it and returns
 * an unfiltered page 1 as HTTP 200, so a dropped filter is indistinguishable
 * from a genuine match. `find_customer({phone})` shipped `phoneNumber` and
 * handed callers a stranger's name, address and balance with full confidence.
 *
 * The rule (Luke, 2026-08-04): if a filter cannot be applied server-side,
 * FAIL LOUDLY. A wrong answer is worse than no answer. Never degrade to an
 * unfiltered page, and never quietly drop the arg either — the caller asked
 * a narrower question than we can answer and must be told so.
 *
 * @param args     the tool's parsed arguments
 * @param unsupported map of arg name -> what the caller should do instead
 */
export function rejectUnsupportedSTFilters(
  args: Record<string, unknown>,
  unsupported: Record<string, string>,
  correlation?: string,
): void {
  const offenders = Object.keys(unsupported).filter(
    (k) => args[k] !== undefined && args[k] !== null && args[k] !== '',
  );
  if (offenders.length === 0) return;
  const detail = offenders.map((k) => `\`${k}\`: ${unsupported[k]}`).join(' ');
  throw new McpError(
    'validation_error',
    `ServiceTitan does not support filtering by ${offenders.map((k) => `\`${k}\``).join(', ')} ` +
      `on this endpoint — it ignores the parameter and returns an unfiltered first page, ` +
      `which would look like a real match. Refusing rather than returning wrong data. ${detail}`,
    { correlation },
  );
}

export interface STListResponse<T = unknown> {
  data: T[];
  hasMore?: boolean;
  page?: number;
  pageSize?: number;
  totalCount?: number;
}

function buildUrl(endpoint: string, query?: Record<string, unknown>): string {
  let path = endpoint;
  if (query && Object.keys(query).length > 0) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null) continue;
      qs.set(k, String(v));
    }
    const qsStr = qs.toString();
    if (qsStr) path = path.includes('?') ? `${path}&${qsStr}` : `${path}?${qsStr}`;
  }
  return `https://servicetitan-proxy/api/st/read?endpoint=${encodeURIComponent(path)}`;
}

/**
 * Single live ST GET. Returns the parsed body — caller decides whether
 * it's a list envelope or a single resource.
 */
export async function readST<T = unknown>(
  env: Env,
  ctx: ReadSTContext,
  endpoint: string,
  query?: Record<string, unknown>,
): Promise<T> {
  // Resolve the /tenant/000000000/ placeholder to the real tenant HERE, at the
  // call site, using env.ST_TENANT_ID directly — the same value job_cost_actuals
  // interpolates successfully. The withTenantRewrite ST_PROXY.fetch wrapper does
  // not reliably substitute on this path in prod; resolving up front is robust
  // and independent of that wrapper. No-op when ST_TENANT_ID is the placeholder
  // (dev/test), so existing 000000000 URL assertions still hold.
  const resolved = rewriteTenantPlaceholders(env, endpoint);
  const url = buildUrl(resolved, query);
  // guardedStFetch consults the StRateLimiter DO before the call leaves the
  // Worker and feeds a 429's Retry-After back into it. Every ST read that is
  // not already paged through pagedStRead lands here, so this one wrapper is
  // what puts ~60 tool files under the rate limiter.
  const resp = await guardedStFetch(env, resolved, () =>
    env.ST_PROXY.fetch(url, {
      headers: authHeaders(env, ctx.correlation, ctx.actor),
    }),
  );
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new McpError(
      mapUpstreamStatus(resp.status),
      // 600, not 200: ST's RFC7231 validation envelope spends ~180 chars on
      // type/title/status/traceId before it reaches `errors`, so a 200-char
      // slice truncates the actual message mid-word. That is exactly how the
      // ids-batch cap got misdiagnosed — "Simple IDs lookup should n…".
      `readST ${resp.status} on ${resolved}: ${body.slice(0, 600)}`,
      {
        correlation: ctx.correlation,
        // A 429 without retry_after_ms is an error the caller cannot act on.
        ...(resp.status === 429
          ? { retry_after_ms: parseRetryAfterSeconds(resp.headers.get('Retry-After')) * 1000 }
          : {}),
      },
    );
  }
  return (await resp.json()) as T;
}

/**
 * POST-as-read: some ST endpoints (e.g. /capacity-planning, /capacity, report /data)
 * require a POST body even though they are semantically reads. This helper
 * mirrors readST but sends method=POST + a JSON body. The servicetitan-proxy
 * /api/st/read endpoint accepts both GET and POST.
 */
export async function readSTPost<T = unknown>(
  env: Env,
  ctx: ReadSTContext,
  endpoint: string,
  body: unknown,
  /**
   * `identity` names WHICH ServiceTitan report this is (id + every input that
   * changes the rows). ST allows 1 run of the same report per minute per
   * tenant — an identity rule, not a volume bucket — so the limiter can only
   * enforce it when the caller supplies this. Only st_run_report does.
   */
  opts: { identity?: string } = {},
): Promise<T> {
  const resolved = rewriteTenantPlaceholders(env, endpoint);
  const url = buildUrl(resolved);
  // Same gate as readST. This is the path st_run_report uses, and the reason
  // the reporting family's 20/min cap was never consulted before Wave 2.
  const resp = await guardedStFetch(
    env,
    resolved,
    () =>
      env.ST_PROXY.fetch(url, {
        method: 'POST',
        headers: { ...authHeaders(env, ctx.correlation, ctx.actor), 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    opts,
  );
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new McpError(
      mapUpstreamStatus(resp.status),
      `readSTPost ${resp.status} on ${resolved}: ${text.slice(0, 200)}`,
      {
        correlation: ctx.correlation,
        ...(resp.status === 429
          ? { retry_after_ms: parseRetryAfterSeconds(resp.headers.get('Retry-After')) * 1000 }
          : {}),
      },
    );
  }
  return (await resp.json()) as T;
}

export interface ReadSTPagedOptions {
  /** Hard cap on pages to fetch. Default 50 (= up to 25,000 rows at pageSize=500). */
  maxPages?: number;
  /** Page size to request per page. Default 200, max 500 (ST cap on most endpoints). */
  pageSize?: number;
  /** Start page, default 1. */
  startPage?: number;
}

export interface ReadSTPagedResult<T = unknown> {
  rows: T[];
  pagesFetched: number;
  hitCap: boolean;
  totalCount: number | null;
}

const DEFAULT_PAGE_SIZE = 200;
const MAX_PAGE_SIZE = 500;
const DEFAULT_MAX_PAGES = 50;

/**
 * Paginated live ST read. Drains pages via `hasMore`, bounded by maxPages.
 * Caller's `query` is forwarded as-is on every page; pagination params
 * (`page`, `pageSize`) are injected by the helper.
 *
 * Rate limiting is inherited: every page goes through readST, so the limiter
 * is consulted once PER PAGE — which is correct, since each page is a
 * separate ST request against the quota.
 */
export async function readSTPaged<T = unknown>(
  env: Env,
  ctx: ReadSTContext,
  endpoint: string,
  query: Record<string, unknown> = {},
  options: ReadSTPagedOptions = {},
): Promise<ReadSTPagedResult<T>> {
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  const pageSize = Math.min(options.pageSize ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
  let page = options.startPage ?? 1;
  const rows: T[] = [];
  let hitCap = false;
  let totalCount: number | null = null;

  for (let i = 0; i < maxPages; i++) {
    const body = await readST<STListResponse<T>>(env, ctx, endpoint, {
      ...query,
      page,
      pageSize,
    });
    rows.push(...(body.data ?? []));
    if (body.totalCount !== undefined) totalCount = body.totalCount;
    if (!body.hasMore) {
      return { rows, pagesFetched: i + 1, hitCap: false, totalCount };
    }
    page += 1;
  }
  hitCap = true;
  return { rows, pagesFetched: maxPages, hitCap, totalCount };
}
