// ============================================================
// paged-st-read.ts — v1.4 shared pagination helper for /api/st/read.
//
// Replaces the inline pageSize=200/page=1 single-shot pattern that
// silently truncates large result sets in L5 composites. Wraps the
// existing stRead URL shape, cooperates with the StRateLimiter DO
// (one checkRateLimit per attempt + reportBackoff on 429), and
// retries safely on 429/502/503/504 with Retry-After parsing.
//
// Stops paging when:
//   - response { hasMore: false }, or
//   - data.length < pageSize (defensive — only when hasMore is omitted)
//   - pageCount === maxPages (sets truncated=true + warning)
//   - opts.signal is aborted (sets warning='aborted')
//
// Returns already-collected items on partial failure rather than
// throwing — composites surface the partialFailures array and let
// the caller decide whether to error or warn.
// ============================================================

import type { Env } from './env';
import { extractStData } from './composite-helpers';
import { familyFromEndpoint, checkRateLimit, reportBackoff } from './rate-limit-guard';
import { rewriteTenantPlaceholders } from './tenant';

export interface PagedReadOptions {
  pageSize?: number;
  maxPages?: number;
  startPage?: number;
  retries?: number;
  signal?: AbortSignal;
}

export interface PagedReadFailure {
  page: number;
  status: number;
  message: string;
}

export interface PagedReadResult<T = unknown> {
  items: T[];
  pageCount: number;
  truncated: boolean;
  warnings: string[];
  partialFailures: PagedReadFailure[];
}

interface RawPageShape {
  data?: unknown[];
  hasMore?: boolean;
}

const DEFAULT_PAGE_SIZE = 200;
const DEFAULT_MAX_PAGES = 20;
const DEFAULT_RETRIES = 3;
const RETRY_AFTER_CAP_SECONDS = 30;
const RETRYABLE_STATUSES = new Set([429, 502, 503, 504]);

function buildPageUrl(
  endpointPath: string,
  query: Record<string, string | number>,
  page: number,
  pageSize: number
): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) qs.set(k, String(v));
  qs.set('pageSize', String(pageSize));
  qs.set('page', String(page));
  return `https://servicetitan-proxy/api/st/read?endpoint=${encodeURIComponent(`${endpointPath}?${qs.toString()}`)}`;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      resolve();
    }, { once: true });
  });
}

export async function pagedStRead<T = unknown>(
  env: Env,
  headers: Record<string, string>,
  endpointPath: string,
  query: Record<string, string | number>,
  opts: PagedReadOptions = {}
): Promise<PagedReadResult<T>> {
  const pageSize = opts.pageSize ?? DEFAULT_PAGE_SIZE;
  const maxPages = opts.maxPages ?? DEFAULT_MAX_PAGES;
  const startPage = opts.startPage ?? 1;
  const retries = opts.retries ?? DEFAULT_RETRIES;
  // Resolve the /tenant/000000000/ placeholder to the real ST_TENANT_ID ONCE,
  // here, mirroring st.ts's readST/readSTPost. buildPageUrl previously used
  // endpointPath verbatim, so callers passing the standard placeholder
  // pattern (e.g. margin_audit's `/jpm/v2/tenant/000000000/jobs`) sent the
  // literal placeholder to ST, which 403'd with "Resource owner validation
  // failed". No-op when ST_TENANT_ID is unset/placeholder (dev/test).
  const resolvedPath = rewriteTenantPlaceholders(env, endpointPath);
  const family = familyFromEndpoint(resolvedPath);

  const items: T[] = [];
  const warnings: string[] = [];
  const partialFailures: PagedReadFailure[] = [];
  let pageCount = 0;
  let truncated = false;

  for (let page = startPage; pageCount < maxPages; page++) {
    if (opts.signal?.aborted) {
      warnings.push('aborted');
      break;
    }

    const url = buildPageUrl(resolvedPath, query, page, pageSize);
    let attempt = 0;
    let pageResult: RawPageShape | null = null;
    let pageFailure: PagedReadFailure | null = null;

    while (attempt <= retries) {
      try {
        await checkRateLimit(env, family);
      } catch (e) {
        pageFailure = { page, status: 429, message: (e as Error).message };
        break;
      }

      const fetchInit: RequestInit = opts.signal ? { headers, signal: opts.signal } : { headers };
      let resp: Response;
      try {
        resp = await env.ST_PROXY.fetch(url, fetchInit);
      } catch (e) {
        pageFailure = { page, status: 0, message: (e as Error).message };
        break;
      }

      if (resp.ok) {
        try {
          const json = await resp.json<unknown>();
          // Some endpoints wrap the page in { data: [...] }, others return [...] directly.
          const raw = (json !== null && typeof json === 'object' && 'data' in json
            ? json
            : { data: extractStData<unknown[]>(json) }) as RawPageShape;
          pageResult = raw;
        } catch (e) {
          pageFailure = { page, status: resp.status, message: `JSON parse: ${(e as Error).message}` };
        }
        break;
      }

      if (RETRYABLE_STATUSES.has(resp.status) && attempt < retries) {
        if (resp.status === 429) {
          const retryAfterRaw = parseInt(resp.headers.get('Retry-After') ?? '60', 10);
          const retryAfter = isNaN(retryAfterRaw) ? 60 : retryAfterRaw;
          await reportBackoff(env, family, retryAfter);
          await sleep(Math.min(retryAfter, RETRY_AFTER_CAP_SECONDS) * 1000, opts.signal);
        } else {
          // 502/503/504 exponential backoff: 250, 500, 1000 ms
          await sleep(250 * Math.pow(2, attempt), opts.signal);
        }
        attempt++;
        continue;
      }

      // Non-retryable 4xx/5xx — stop paging, keep collected items.
      pageFailure = { page, status: resp.status, message: `${resp.status} ${resp.statusText || ''}`.trim() };
      break;
    }

    if (pageFailure) {
      partialFailures.push(pageFailure);
      if (!warnings.includes('partial_pagination_failure')) warnings.push('partial_pagination_failure');
      break;
    }

    if (!pageResult) break;

    const pageItems = (pageResult.data ?? []) as T[];
    items.push(...pageItems);
    pageCount++;

    const hasMore = pageResult.hasMore;
    const looksDone = hasMore === false || (hasMore === undefined && pageItems.length < pageSize);
    if (looksDone) break;

    if (pageCount === maxPages) {
      truncated = true;
      warnings.push('truncated_at_max_pages');
      break;
    }
  }

  return { items, pageCount, truncated, warnings, partialFailures };
}
