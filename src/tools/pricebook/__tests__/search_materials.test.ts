// ============================================================
// search_materials — QUA-267 finding 2 regression (mirror of services)
// ============================================================

import { describe, it, expect, vi } from 'vitest';
import { search_materials } from '../search_materials';

type Row = Record<string, unknown>;

interface ProxyResponse {
  urlContains?: string;
  body: unknown;
  status?: number;
}

function fakeEnv(responses: ProxyResponse[]) {
  const fetcher = vi.fn(async (url: string | Request) => {
    const u = typeof url === 'string' ? url : url.url;
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

const ctx = { actor: 'test', correlation: 'c1' };

describe('search_materials (QUA-267 code param)', () => {
  it('exact code: short-circuits to D1 hit', async () => {
    const env = fakeEnv([
      {
        urlContains: '/api/sql/read',
        body: { success: true, results: [{ id: 42, code: 'PRV-075', name: 'Pressure Reducing Valve 3/4"', cost: 35.5, price: 89 }] },
      },
    ]);
    const out = (await search_materials.handler(env, { code: 'PRV-075' }, ctx)) as any;
    expect(out._source).toBe('d1-exact');
    expect(out.materials).toHaveLength(1);
    expect((out.materials[0] as Row).code).toBe('PRV-075');
    expect((env.ST_PROXY.fetch as any).mock.calls).toHaveLength(1);
  });

  it('exact code with no D1 hit: falls through to live ST', async () => {
    const env = fakeEnv([
      { urlContains: '/api/sql/read', body: { success: true, results: [] } },
      { urlContains: '/api/st/read', body: { data: [{ id: 7, name: 'New material' }] } },
    ]);
    const out = (await search_materials.handler(env, { code: 'BRAND-NEW' }, ctx)) as any;
    expect(out._source).toBe('live');
    expect((out.materials as unknown[]).length).toBeGreaterThanOrEqual(0);
  });

  it('name only: goes straight to live ST', async () => {
    const env = fakeEnv([
      { urlContains: '/api/st/read', body: { data: [{ id: 1, name: 'Copper pipe' }] } },
    ]);
    const out = (await search_materials.handler(env, { name: 'copper' }, ctx)) as any;
    expect(out._source).toBe('live');
    const d1Call = (env.ST_PROXY.fetch as any).mock.calls.find((c: any) =>
      String(c[0]).includes('/api/sql/read'),
    );
    expect(d1Call).toBeUndefined();
  });

  it('preserves _matched_code on hit', async () => {
    const env = fakeEnv([
      {
        urlContains: '/api/sql/read',
        body: { success: true, results: [{ code: 'PIP-100', name: 'PIP Drain Repair' }] },
      },
    ]);
    const out = (await search_materials.handler(env, { code: 'PIP-100' }, ctx)) as any;
    expect(out._matched_code).toBe('PIP-100');
  });
});

// ── Mirror-freshness disclosure (MB-1 / QUA-1141) ────────────────────
// The exact-code path serves a raw pb_materials mirror row; a stale hit
// used to be served silently. The SELECT must carry synced_at and the
// response must carry the stamp.

const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

describe('search_materials freshness disclosure (MB-1 / QUA-1141)', () => {
  it('the exact-code SELECT includes synced_at so the row can prove its age', async () => {
    let capturedSql = '';
    const fetcher = vi.fn(async (_url: any, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(init.body as string) : {};
      capturedSql = body.sql ?? '';
      return new Response(JSON.stringify({ success: true, results: [{ code: 'PRV-075', synced_at: hoursAgo(1) }] }), { status: 200 });
    });
    const env = { ST_TENANT_ID: '000000000', ST_PROXY: { fetch: fetcher }, MCP_SYNC_KEY: 'k' } as any;
    await search_materials.handler(env, { code: 'PRV-075' }, ctx);
    expect(capturedSql).toContain('synced_at');
  });

  it('a fresh D1 hit is stamped fresh with no warning', async () => {
    const env = fakeEnv([
      { urlContains: '/api/sql/read', body: { success: true, results: [{ code: 'PRV-075', name: 'PRV', synced_at: hoursAgo(2) }] } },
    ]);
    const out = (await search_materials.handler(env, { code: 'PRV-075' }, ctx)) as any;
    expect(out._mirror_table).toBe('pb_materials');
    expect(out._freshness).toBe('fresh');
    expect(out._warning).toBeUndefined();
  });

  it('a stale D1 hit is disclosed, not served silently', async () => {
    const env = fakeEnv([
      { urlContains: '/api/sql/read', body: { success: true, results: [{ code: 'PRV-075', name: 'PRV', synced_at: hoursAgo(24 * 23) }] } },
    ]);
    const out = (await search_materials.handler(env, { code: 'PRV-075' }, ctx)) as any;
    expect(out._source).toBe('d1-exact');
    expect(out._freshness).toBe('stale');
    expect(out._warning).toMatch(/STALE DATA/);
  });
});
