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

import { describe, it, expect, vi } from 'vitest';
import { readSTPost } from '../../st';

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
