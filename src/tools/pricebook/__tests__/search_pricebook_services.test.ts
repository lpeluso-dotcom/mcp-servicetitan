// ============================================================
// search_pricebook_services — QUA-267 finding 2 regression
//
// Verifies the new `code` parameter does an exact-match D1 lookup
// via /api/sql/read and short-circuits before hitting live ST. Pre-fix,
// `name: "P1HL22"` returned HV-RES-ST (id 98) as top hit. With `code`,
// callers get the actual row or a fall-through to live ST — never a
// mis-rank.
// ============================================================

import { describe, it, expect, vi } from 'vitest';
import { search_pricebook_services } from '../search_pricebook_services';

type Row = Record<string, unknown>;

interface ProxyResponse {
  urlContains?: string;
  body: unknown;
  status?: number;
}

/**
 * Build an env whose ST_PROXY.fetch responds based on URL. /api/sql/read
 * hits use the D1-envelope shape ({success, results}); /api/st/read hits
 * use the ST live-API shape ({data}).
 */
function fakeEnv(
  responses: ProxyResponse[],
  tableMaxIso: string | null = new Date(Date.now() - 1 * 3_600_000).toISOString(),
) {
  const fetcher = vi.fn(async (url: string | Request, init?: any) => {
    const u = typeof url === 'string' ? url : url.url;
    // fetchTableMax probe (MB-1 / QUA-1141 v2) — matched on `AS t,`.
    const body = init?.body ? JSON.parse(init.body as string) : { sql: '' };
    if (/ AS t,/.test(String(body.sql))) {
      return new Response(
        JSON.stringify({ success: true, results: [{ t: 'pb_services', m: tableMaxIso }] }),
        { status: 200 },
      );
    }
    const match = responses.find((r) => !r.urlContains || u.includes(r.urlContains));
    if (!match) {
      return new Response(JSON.stringify({ success: false, error: 'no mock for ' + u }), { status: 500 });
    }
    return new Response(JSON.stringify(match.body), { status: match.status ?? 200 });
  });
  return {
    ST_TENANT_ID: '000000000',
    ST_PROXY: { fetch: fetcher },
    MCP_SYNC_KEY: 'test-key',
  } as any;
}

/** Non-probe D1 calls only. */
function d1DataCalls(env: any) {
  return (env.ST_PROXY.fetch as any).mock.calls.filter((c: any) => {
    if (!String(c[0]).includes('/api/sql/read')) return false;
    const body = c[1]?.body ? JSON.parse(c[1].body) : { sql: '' };
    return !/ AS t,/.test(String(body.sql));
  });
}

const ctx = { actor: 'test', correlation: 'c1' };

describe('search_pricebook_services (QUA-267 code param)', () => {
  it('exact code: short-circuits to D1 hit and returns that row', async () => {
    const env = fakeEnv([
      {
        urlContains: '/api/sql/read',
        body: {
          success: true,
          results: [
            { id: 999, code: 'P1HL22', name: 'Residential Crawl Space Repair - Advanced', hours: 3, price: 0 },
          ],
        },
      },
    ]);
    const out = (await search_pricebook_services.handler(env, { code: 'P1HL22' }, ctx)) as any;
    expect(out._source).toBe('d1-exact');
    expect(out.services).toHaveLength(1);
    expect((out.services[0] as Row).code).toBe('P1HL22');
    expect((out.services[0] as Row).hours).toBe(3);
    // Only ONE data fetch — D1 hit short-circuits before live ST (the
    // fetchTableMax probe rides alongside).
    expect(d1DataCalls(env)).toHaveLength(1);
  });

  it('exact code: tries variants (raw → UPPER → UPPER-hyphenated) before falling through', async () => {
    let calls = 0;
    const env = fakeEnv([
      {
        urlContains: '/api/sql/read',
        body: { success: true, results: [] }, // every D1 lookup empty
      },
      {
        urlContains: '/api/st/read',
        body: { data: [{ id: 1, name: 'live ST fuzzy match' }] },
      },
    ]);
    // Override to count D1 code-lookup hits (skip the fetchTableMax probe)
    const realFetch = env.ST_PROXY.fetch;
    env.ST_PROXY.fetch = vi.fn(async (url: any, init: any) => {
      const body = init?.body ? JSON.parse(init.body as string) : { sql: '' };
      if (String(url).includes('/api/sql/read') && !/ AS t,/.test(String(body.sql))) calls += 1;
      return realFetch(url, init);
    });

    const out = (await search_pricebook_services.handler(env, { code: 'flu150' }, ctx)) as any;
    // codeVariants("flu150") = ['flu150', 'FLU150', 'FLU-150'] (3 variants)
    expect(calls).toBe(3);
    expect(out._source).toBe('live');
  });

  it('exact code with no D1 hit and no name: falls through to live ST using code as name', async () => {
    const env = fakeEnv([
      {
        urlContains: '/api/sql/read',
        body: { success: true, results: [] },
      },
      {
        urlContains: '/api/st/read',
        body: { data: [{ id: 7, name: 'New service' }] },
      },
    ]);
    const out = (await search_pricebook_services.handler(env, { code: 'BRAND-NEW-99' }, ctx)) as any;
    expect(out._source).toBe('live');
    // Verify live ST was hit AT LEAST once (readST encodes query params in the URL).
    const liveCall = (env.ST_PROXY.fetch as any).mock.calls.find((c: any) =>
      String(c[0]).includes('/api/st/read'),
    );
    expect(liveCall).toBeTruthy();
    // The code is passed to the live ST `name` param when no explicit name is set.
    // readST may inline the query in the URL or POST it as JSON depending on its impl.
    const liveUrl = String(liveCall[0]);
    const liveInit = liveCall[1] ?? {};
    const probe = liveUrl + (liveInit.body ? ' ' + String(liveInit.body) : '');
    expect(probe).toMatch(/BRAND-NEW-99/i);
  });

  it('name only (no code): goes straight to live ST', async () => {
    const env = fakeEnv([
      {
        urlContains: '/api/st/read',
        body: { data: [{ id: 1, name: 'Diagnostic Fee' }] },
      },
    ]);
    const out = (await search_pricebook_services.handler(env, { name: 'diagnostic' }, ctx)) as any;
    expect(out._source).toBe('live');
    // No D1 hit at all.
    const d1Call = (env.ST_PROXY.fetch as any).mock.calls.find((c: any) =>
      String(c[0]).includes('/api/sql/read'),
    );
    expect(d1Call).toBeUndefined();
  });

  it('preserves the matched variant in _matched_code', async () => {
    const env = fakeEnv([
      {
        urlContains: '/api/sql/read',
        body: { success: true, results: [{ code: 'WHEH-140', name: '40 Gal Hybrid', hours: 2.84, price: 3278.24 }] },
      },
    ]);
    const out = (await search_pricebook_services.handler(env, { code: 'WHEH-140' }, ctx)) as any;
    expect(out._matched_code).toBe('WHEH-140');
    expect((out.services[0] as Row)._matched_code).toBe('WHEH-140');
  });
});

// ── Mirror-freshness disclosure (MB-1 / QUA-1141) ────────────────────
// The exact-code path serves a raw pb_services mirror row; a stale hit
// used to be served silently. The SELECT must carry synced_at and the
// response must carry the stamp.

const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

describe('search_pricebook_services freshness disclosure (MB-1 / QUA-1141)', () => {
  it('the exact-code SELECT includes synced_at so the row can prove its age', async () => {
    let capturedSql = '';
    const fetcher = vi.fn(async (_url: any, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(init.body as string) : {};
      capturedSql = body.sql ?? '';
      return new Response(JSON.stringify({ success: true, results: [{ code: 'P1HL22', synced_at: hoursAgo(1) }] }), { status: 200 });
    });
    const env = { ST_TENANT_ID: '000000000', ST_PROXY: { fetch: fetcher }, MCP_SYNC_KEY: 'k' } as any;
    await search_pricebook_services.handler(env, { code: 'P1HL22' }, ctx);
    expect(capturedSql).toContain('synced_at');
  });

  it('a fresh D1 hit is stamped fresh with no warning', async () => {
    const env = fakeEnv([
      { urlContains: '/api/sql/read', body: { success: true, results: [{ code: 'P1HL22', name: 'Heat pump', synced_at: hoursAgo(2) }] } },
    ]);
    const out = (await search_pricebook_services.handler(env, { code: 'P1HL22' }, ctx)) as any;
    expect(out._mirror_table).toBe('pb_services');
    expect(out._freshness).toBe('fresh');
    expect(out._warning).toBeUndefined();
  });

  it('a hit off a frozen mirror (table MAX weeks old) is disclosed, not served silently', async () => {
    const env = fakeEnv([
      { urlContains: '/api/sql/read', body: { success: true, results: [{ code: 'P1HL22', name: 'Heat pump', synced_at: hoursAgo(24 * 23) }] } },
    ], hoursAgo(24 * 23));
    const out = (await search_pricebook_services.handler(env, { code: 'P1HL22' }, ctx)) as any;
    expect(out._source).toBe('d1-exact');
    expect(out._freshness).toBe('stale');
    expect(out._warning).toMatch(/STALE DATA/);
  });

  it('an old ROW on a live mirror is not called stale — the table probe decides (F1)', async () => {
    const env = fakeEnv([
      { urlContains: '/api/sql/read', body: { success: true, results: [{ code: 'P1HL22', name: 'Heat pump', synced_at: hoursAgo(24 * 23) }] } },
    ]);
    const out = (await search_pricebook_services.handler(env, { code: 'P1HL22' }, ctx)) as any;
    expect(out._freshness).toBe('fresh');
    expect(out._warning).toBeUndefined();
  });

  it('strips synced_at from the emitted service row (stamp plumbing, not payload)', async () => {
    const env = fakeEnv([
      { urlContains: '/api/sql/read', body: { success: true, results: [{ code: 'P1HL22', name: 'Heat pump', synced_at: hoursAgo(1) }] } },
    ]);
    const out = (await search_pricebook_services.handler(env, { code: 'P1HL22' }, ctx)) as any;
    expect(out.services[0]).not.toHaveProperty('synced_at');
  });
});
