// ============================================================
// Cluster 1 — st_run_report pagination.
//
// ServiceTitan's Reporting v2 POST .../data takes page/pageSize/includeTotal
// as QUERY parameters; the body carries only `parameters`. We sent all three
// in the body, where ST silently drops them. Live probe 2026-08-25 on report
// accounting/155 with pageSize:3 returned 188 rows and echoed pageSize:1000.
//
// Consequence: reports over 1000 rows could not be paged at all, and
// reportRunIdentity keyed the cache on parameters that never left the Worker,
// so page 1 and page 2 cached as distinct entries holding identical rows.
// ============================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readSTPost } from '../../st';
import { st_run_report, _resetReportCooldown, REPORT_CACHE_NS } from '../reporting/st_run_report';

const CTX = { actor: 'vitest', correlation: 'corr-c1' };

function makeLimiter() {
  const doFetch = vi.fn(async (url: string): Promise<Response> => {
    if (url.endsWith('/check')) return new Response(JSON.stringify({ allowed: true }), { status: 200 });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  });
  return { idFromName: vi.fn((n: string) => n), get: vi.fn(() => ({ fetch: doFetch })) } as any;
}

function makeEnv(stImpl: (url: string, init?: any) => Promise<Response>) {
  return {
    ST_PROXY: { fetch: vi.fn(stImpl) },
    ST_RATE_LIMITER: makeLimiter(),
    MCP_SYNC_KEY: 'k',
    MCP_SERVICE_VERSION: '0.0.0-test',
    ST_TENANT_ID: '000000000',
    PROXY_STATE: {},
  } as any;
}

/**
 * Pull the real ST path back out of the proxy URL's ?endpoint= parameter.
 * searchParams.get() already percent-decodes once — do NOT decodeURIComponent
 * again or a legitimate '%' in a parameter value will throw.
 */
function endpointOf(url: string): string {
  return new URL(url).searchParams.get('endpoint') ?? '';
}

describe('readSTPost query support', () => {
  it('appends query params to the endpoint and leaves the body untouched', async () => {
    const env = makeEnv(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));

    await readSTPost(
      env,
      CTX,
      '/reporting/v2/tenant/000000000/report-category/cat1/reports/r1/data',
      { parameters: [{ name: 'From', value: '2026-01-01' }] },
      { query: { page: 2, pageSize: 3, includeTotal: true } },
    );

    const [url, init] = env.ST_PROXY.fetch.mock.calls[0];
    const endpoint = endpointOf(url as string);

    expect(endpoint).toContain('page=2');
    expect(endpoint).toContain('pageSize=3');
    expect(endpoint).toContain('includeTotal=true');

    // The body must carry ONLY parameters — ST's ReportDataRequest schema is
    // additionalProperties:false, so anything else is a spec violation.
    expect(JSON.parse((init as any).body)).toEqual({
      parameters: [{ name: 'From', value: '2026-01-01' }],
    });
  });

  it('omits the query string entirely when no query is supplied', async () => {
    const env = makeEnv(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));

    await readSTPost(env, CTX, '/capacity/v2/tenant/000000000/capacity', { foo: 1 });

    const endpoint = endpointOf(env.ST_PROXY.fetch.mock.calls[0][0] as string);
    expect(endpoint).not.toContain('?');
  });
});

/** D1 mock backing the mcp_cache read-through with a real in-memory table. */
function makeCacheDB() {
  const rows = new Map<string, { value: string; expires_at: number }>();
  return {
    rows,
    prepare: vi.fn((sql: string) => {
      const captured: unknown[] = [];
      const stmt: any = {
        bind: vi.fn((...args: unknown[]) => {
          captured.push(...args);
          return stmt;
        }),
        run: vi.fn(async () => {
          if (/INSERT OR REPLACE INTO mcp_cache/i.test(sql)) {
            rows.set(`${captured[0]}|${captured[1]}`, {
              value: String(captured[2]),
              expires_at: Number(captured[3]),
            });
          }
          return { success: true };
        }),
        first: vi.fn(async () => {
          if (/FROM mcp_cache/i.test(sql)) return rows.get(`${captured[0]}|${captured[1]}`) ?? null;
          return null;
        }),
      };
      return stmt;
    }),
  };
}

function makeReportEnv(stImpl: (url: string, init?: any) => Promise<Response>) {
  const env = makeEnv(stImpl);
  env.DB = makeCacheDB();
  return env;
}

const RUN_ARGS = {
  mode: 'run' as const,
  categoryId: 'cat1',
  reportId: 'r1',
  parameters: [{ name: 'From', value: '2026-01-01' }],
};

beforeEach(() => {
  _resetReportCooldown();
});

describe('st_run_report pagination placement', () => {
  it('sends page/pageSize/includeTotal as query params, body carries only parameters', async () => {
    const env = makeReportEnv(async () => new Response(JSON.stringify({ data: [] }), { status: 200 }));

    await st_run_report.handler(env, { ...RUN_ARGS, page: 2, pageSize: 3 }, CTX);

    const [url, init] = env.ST_PROXY.fetch.mock.calls[0];
    const endpoint = endpointOf(url as string);

    expect(endpoint).toContain('page=2');
    expect(endpoint).toContain('pageSize=3');
    expect(endpoint).toContain('includeTotal=true');
    expect(JSON.parse((init as any).body)).toEqual({ parameters: RUN_ARGS.parameters });
  });

  it('defaults to pageSize 1000 so honoring pageSize does not shrink existing callers', async () => {
    const env = makeReportEnv(async () => new Response(JSON.stringify({ data: [] }), { status: 200 }));

    await st_run_report.handler(env, { ...RUN_ARGS }, CTX);

    const endpoint = endpointOf(env.ST_PROXY.fetch.mock.calls[0][0] as string);
    expect(endpoint).toContain('pageSize=1000');
    expect(endpoint).toContain('page=1');
  });

  it('uses a versioned cache namespace so pre-fix poisoned entries cannot serve', () => {
    expect(REPORT_CACHE_NS).toBe('servicetitan:report_run:v2');
  });

  it('still treats a different page as a different run and hits ST twice', async () => {
    const env = makeReportEnv(async () => new Response(JSON.stringify({ data: [] }), { status: 200 }));

    await st_run_report.handler(env, { ...RUN_ARGS }, CTX);
    await st_run_report.handler(env, { ...RUN_ARGS, page: 2 }, CTX);

    expect(env.ST_PROXY.fetch).toHaveBeenCalledTimes(2);
  });
});
