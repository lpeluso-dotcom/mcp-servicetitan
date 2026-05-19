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

export interface ReadSTContext {
  actor: string;
  correlation: string;
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
  const url = buildUrl(endpoint, query);
  const resp = await env.ST_PROXY.fetch(url, {
    headers: authHeaders(env, ctx.correlation, ctx.actor),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new McpError(
      mapUpstreamStatus(resp.status),
      `readST ${resp.status} on ${endpoint}: ${body.slice(0, 200)}`,
      { correlation: ctx.correlation },
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
