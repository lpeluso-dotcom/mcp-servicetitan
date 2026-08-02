// ============================================================
// search_pricebook_all — freshness disclosure (MB-1 / QUA-1141)
//
// This tool reads pb_services/pb_materials/pb_equipment raw from the
// taylor-ai D1 mirror; a stale or empty mirror used to be served to Dawn
// as current truth. These tests pin the stamp on every response path AND
// the QUA-1108 runtime trap: search_pricebook_all has an outputSchema, so
// EVERY key the handler emits must be declared in it — the MCP SDK
// validates structuredContent at runtime on every call, and an undeclared
// field fails in production while unit tests stay green.
// ============================================================
import { describe, it, expect, vi } from 'vitest';
import { search_pricebook_all } from '../search_pricebook_all';

const CTX = { actor: 'vitest', correlation: 'test-corr' };
const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

function makeD1Env(results: unknown[]) {
  const bodies: Array<{ sql: string; params: unknown[] }> = [];
  const fetcher = vi.fn(async (_url: any, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(init.body as string) : { sql: '', params: [] };
    bodies.push(body);
    return new Response(JSON.stringify({ success: true, results }), { status: 200 });
  });
  return {
    env: { ST_PROXY: { fetch: fetcher }, MCP_SYNC_KEY: 'test-key', MCP_SERVICE_VERSION: '0.0.0-test' } as any,
    bodies,
  };
}

const SVC_ROW = (synced_at: string) => ({
  code: 'FLU-150', name: 'Flush', description: '', category: 'Drain', price: 150,
  member_price: null, hours: 0.75, calculated_price: 200, type: 'service', synced_at,
});

describe('search_pricebook_all freshness disclosure (MB-1 / QUA-1141)', () => {
  it('every SELECT it issues carries synced_at — the rows must be able to prove their age', async () => {
    const { env, bodies } = makeD1Env([]);
    await search_pricebook_all.handler(env, { query: 'flush' }, CTX);
    expect(bodies.length).toBe(3);
    for (const { sql } of bodies) {
      expect(sql).toContain('synced_at');
    }
  });

  it('code hit: stamps the matched table fresh off row-level synced_at', async () => {
    const { env } = makeD1Env([SVC_ROW(hoursAgo(2))]);
    const out: any = await search_pricebook_all.handler(env, { code: 'FLU-150' }, CTX);
    expect(out.status).toBe('success');
    expect(out._mirror_table).toBe('pb_services');
    expect(out._freshness).toBe('fresh');
    expect(out._warning).toBeUndefined();
  });

  it('code hit on a frozen mirror is flagged stale', async () => {
    const { env } = makeD1Env([SVC_ROW(hoursAgo(24 * 23))]);
    const out: any = await search_pricebook_all.handler(env, { code: 'FLU-150' }, CTX);
    expect(out._freshness).toBe('stale');
    expect(out._warning).toMatch(/STALE DATA/);
  });

  it('query miss: not_found is a claim about the MIRROR — empty is flagged, never silent', async () => {
    const { env } = makeD1Env([]);
    const out: any = await search_pricebook_all.handler(env, { query: 'zzz-nothing' }, CTX);
    expect(out.status).toBe('not_found');
    expect(out._mirror_table).toBe('pb_services+pb_materials+pb_equipment');
    expect(out._freshness).toBe('unknown');
    expect(out._empty).toBe(true);
    expect(out._warning).toMatch(/not proof/i);
  });

  // ── QUA-1108 regression: outputSchema must declare every emitted key ──
  it('every key of every real envelope is declared in the outputSchema (runtime validation trap)', async () => {
    const declared = new Set(Object.keys(search_pricebook_all.outputSchema!));

    const hit = makeD1Env([SVC_ROW(hoursAgo(1))]);
    const hitOut: any = await search_pricebook_all.handler(hit.env, { code: 'FLU-150' }, CTX);
    const missCode = makeD1Env([]);
    const missCodeOut: any = await search_pricebook_all.handler(missCode.env, { code: 'NOPE-1' }, CTX);
    const missQuery = makeD1Env([]);
    const missQueryOut: any = await search_pricebook_all.handler(missQuery.env, { query: 'zzz' }, CTX);
    const queryHit = makeD1Env([SVC_ROW(hoursAgo(1))]);
    const queryHitOut: any = await search_pricebook_all.handler(queryHit.env, { query: 'flush' }, CTX);

    for (const out of [hitOut, missCodeOut, missQueryOut, queryHitOut]) {
      for (const key of Object.keys(out)) {
        expect(declared.has(key), `response key "${key}" is NOT declared in outputSchema — this fails runtime structuredContent validation in production`).toBe(true);
      }
    }
  });
});
