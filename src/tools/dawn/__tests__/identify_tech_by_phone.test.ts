// ============================================================
// identify_tech_by_phone — QUA-267 finding 1 regression
//
// Validates the cross-worker D1 read path (env.ST_PROXY.fetch
// against /api/sql/read on servicetitan-proxy). Pre-fix used
// env.DB.prepare(...) directly, which always failed with
// "no such table: voice_registry" because those tables live in
// taylor-ai's D1, not mcp-servicetitan's own.
//
// Supersedes the prior version of this test (which mocked env.DB).
// ============================================================

import { describe, it, expect, vi } from 'vitest';
import { identify_tech_by_phone } from '../identify_tech_by_phone';

type Row = Record<string, unknown>;

/**
 * Build an env with an ST_PROXY mock that returns successive responses,
 * one per call (FIFO). Each test wires the registry + technicians answers
 * in the order the tool issues them (registry first, technicians second).
 * The fetchTableMax probe (matched on `AS t,` in the SQL) is routed
 * separately — `tableMaxIso` controls the technicians table MAX(synced_at)
 * (defaults fresh, 1h) so the FIFO queue only feeds the real reads.
 */
function fakeEnv(
  responses: Array<Row[] | { httpStatus?: number; success?: boolean; error?: string }>,
  tableMaxIso: string | null = new Date(Date.now() - 1 * 3_600_000).toISOString(),
) {
  let i = 0;
  const fetcher = vi.fn(async (_url: any, init?: any) => {
    const body = init?.body ? JSON.parse(init.body as string) : { sql: '' };
    if (/ AS t,/.test(String(body.sql))) {
      return new Response(
        JSON.stringify({ success: true, results: [{ t: 'technicians', m: tableMaxIso }] }),
        { status: 200 },
      );
    }
    const r = responses[i++];
    if (r && !Array.isArray(r) && typeof r.httpStatus === 'number') {
      return new Response('upstream', { status: r.httpStatus });
    }
    const env = Array.isArray(r)
      ? { success: true, results: r }
      : r ?? { success: true, results: [] };
    return new Response(JSON.stringify(env), { status: 200 });
  });
  return {
    ST_PROXY: { fetch: fetcher },
    MCP_SYNC_KEY: 'test-key',
  } as any;
}

/** Non-probe calls only — the FIFO queue the tests reason about. */
function dataCalls(env: any) {
  return (env.ST_PROXY.fetch as any).mock.calls.filter((c: any) => {
    const body = c[1]?.body ? JSON.parse(c[1].body) : { sql: '' };
    return !/ AS t,/.test(String(body.sql));
  });
}

const ctx = { actor: 'test', correlation: 'c1' };

describe('identify_tech_by_phone (QUA-267 binding fix)', () => {
  it('returns voice_registry hit when tier 1 has a row', async () => {
    const env = fakeEnv([
      [{ name: 'Brooks Hunsucker', tech_id: '111', role: 'Service', confidence: 0.9 }],
    ]);
    const out = (await identify_tech_by_phone.handler(env, { phone: '843-496-3573' }, ctx)) as any;
    expect(out.status).toBe('found');
    expect(out.source).toBe('voice_registry');
    expect(out.tech_id).toBe('111');
    expect(out.tech_name).toBe('Brooks Hunsucker');
    // Tier 2 should NOT have fired (and neither should the table-max probe).
    expect((env.ST_PROXY.fetch as any).mock.calls).toHaveLength(1);
  });

  it('falls through to technicians when tier 1 returns empty', async () => {
    const env = fakeEnv([
      [],
      [{ tech_id: '222', name: 'AH Tech', business_unit: null, role: 'DummyTech' }],
    ]);
    const out = (await identify_tech_by_phone.handler(env, { phone: '8435365603' }, ctx)) as any;
    expect(out.status).toBe('found');
    expect(out.source).toBe('technicians');
    expect(out.tech_id).toBe('222');
    expect(out.tech_name).toBe('AH Tech');
    expect(dataCalls(env)).toHaveLength(2);
  });

  it('falls through to technicians when tier 1 returns "Unknown Tech"', async () => {
    const env = fakeEnv([
      [{ name: 'Unknown Tech', tech_id: '999', role: '', confidence: 0.1 }],
      [{ tech_id: '333', name: 'Chase Feagin', business_unit: '4921847', role: 'Service' }],
    ]);
    const out = (await identify_tech_by_phone.handler(env, { phone: '854-903-5837' }, ctx)) as any;
    expect(out.status).toBe('found');
    expect(out.source).toBe('technicians');
    expect(out.tech_name).toBe('Chase Feagin');
  });

  it('returns not_found when both tiers are empty', async () => {
    const env = fakeEnv([[], []]);
    const out = (await identify_tech_by_phone.handler(env, { phone: '5555555555' }, ctx)) as any;
    expect(out.status).toBe('not_found');
    expect(dataCalls(env)).toHaveLength(2);
  });

  it('rejects too-short numbers before hitting D1', async () => {
    const env = fakeEnv([]);
    const out = (await identify_tech_by_phone.handler(env, { phone: '123' }, ctx)) as any;
    expect(out.status).toBe('parse_error');
    expect(out.message).toMatch(/too short/i);
    expect((env.ST_PROXY.fetch as any).mock.calls).toHaveLength(0);
  });

  it('retries transient HTTP 500 and recovers (Step D retry behavior)', async () => {
    const env = fakeEnv([
      { httpStatus: 500 }, // attempt 1 — transient, retried
      [{ name: 'Brooks Hunsucker', tech_id: '111', role: 'Service', confidence: 0.9 }], // attempt 2 — success
    ]);
    const out = (await identify_tech_by_phone.handler(env, { phone: '8434963573' }, ctx)) as any;
    expect(out.status).toBe('found');
    expect(out.source).toBe('voice_registry');
    // Two ST_PROXY calls: 500 + 200.
    expect((env.ST_PROXY.fetch as any).mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('wraps persistent upstream HTTP 500 (all retries exhausted) as parse_error', async () => {
    // d1-proxy makes 3 attempts (1 initial + 2 retries) — queue 3 + a tier-2 fallback set.
    const env = fakeEnv([
      { httpStatus: 500 },
      { httpStatus: 500 },
      { httpStatus: 500 },
      // tier 2 wouldn't be reached because tier 1 throws D1ProxyError after the 3rd 500.
    ]);
    const out = (await identify_tech_by_phone.handler(env, { phone: '8435365603' }, ctx)) as any;
    expect(out.status).toBe('parse_error');
    expect(out.message).toMatch(/d1 read failed: 500/);
  });

  it('wraps success:false envelope as parse_error', async () => {
    const env = fakeEnv([{ success: false, error: 'no such table: voice_registry' }]);
    const out = (await identify_tech_by_phone.handler(env, { phone: '8435365603' }, ctx)) as any;
    expect(out.status).toBe('parse_error');
    expect(out.message).toMatch(/no such table: voice_registry/);
  });

  it('normalizes phone formatting before querying (digits-only, last 10)', async () => {
    const env = fakeEnv([
      [{ name: 'Briley Ward', tech_id: '444', role: 'Service', confidence: 0.95 }],
    ]);
    await identify_tech_by_phone.handler(env, { phone: '+1 (854) 208-3516' }, ctx);
    const callBody = JSON.parse((env.ST_PROXY.fetch as any).mock.calls[0][1].body);
    expect(callBody.params[0]).toBe('8542083516');
  });

  it('hits /api/sql/read on servicetitan-proxy with X-Sync-Key header', async () => {
    const env = fakeEnv([[]]);
    await identify_tech_by_phone.handler(env, { phone: '8435365603' }, ctx);
    const [url, init] = (env.ST_PROXY.fetch as any).mock.calls[0];
    expect(String(url)).toContain('/api/sql/read');
    expect(init.headers['X-Sync-Key']).toBe('test-key');
    expect(init.method).toBe('POST');
  });
});

// ── MB-1 / QUA-1141: mirror-freshness disclosure ─────────────────
// Tier 2 reads the `technicians` ST mirror — a hit proves its age via
// synced_at and a miss is a claim about the MIRROR, not ServiceTitan.
// Tier 1 (voice_registry) is a LEARNED table with no synced_at column
// (pragma-verified 2026-08-02) — it is not an ST mirror, so it is not
// stamped.
describe('identify_tech_by_phone freshness disclosure (MB-1 / QUA-1141)', () => {
  const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

  it('the tier-2 technicians SELECT carries synced_at', async () => {
    const env = fakeEnv([[], []]);
    await identify_tech_by_phone.handler(env, { phone: '8435365603' }, ctx);
    const tier2Body = JSON.parse(dataCalls(env)[1][1].body);
    expect(tier2Body.sql).toContain('synced_at');
  });

  it('stamps a tier-2 hit with row-level mirror freshness', async () => {
    const env = fakeEnv([
      [],
      [{ tech_id: '222', name: 'AH Tech', business_unit: null, role: 'DummyTech', synced_at: hoursAgo(1) }],
    ]);
    const out = (await identify_tech_by_phone.handler(env, { phone: '8435365603' }, ctx)) as any;
    expect(out.status).toBe('found');
    expect(out._mirror_table).toBe('technicians');
    expect(out._freshness).toBe('fresh');
    expect(out._warning).toBeUndefined();
  });

  it('flags a tier-2 hit off a frozen mirror as stale — the row may be an ex-tech', async () => {
    const env = fakeEnv([
      [],
      [{ tech_id: '222', name: 'AH Tech', business_unit: null, role: 'DummyTech', synced_at: hoursAgo(24 * 30) }],
    ], hoursAgo(24 * 30));
    const out = (await identify_tech_by_phone.handler(env, { phone: '8435365603' }, ctx)) as any;
    expect(out.status).toBe('found');
    expect(out._freshness).toBe('stale');
    expect(out._warning).toMatch(/STALE DATA/);
  });

  it('not_found on a LIVE mirror is an honest "not in the mirror as of the last sync" (F5)', async () => {
    const env = fakeEnv([[], []]);
    const out = (await identify_tech_by_phone.handler(env, { phone: '5555555555' }, ctx)) as any;
    expect(out.status).toBe('not_found');
    expect(out._not_found_caveat).toMatch(/mirror/i);
    expect(out._freshness).toBe('fresh');
    expect(out._empty).toBe(true);
    expect(out._warning).toBeUndefined();
  });

  it('not_found on an UNPROVABLE mirror stays unknown', async () => {
    const env = fakeEnv([[], []], null);
    const out = (await identify_tech_by_phone.handler(env, { phone: '5555555555' }, ctx)) as any;
    expect(out.status).toBe('not_found');
    expect(out._freshness).toBe('unknown');
    expect(out._empty).toBe(true);
  });

  it('an old tier-2 row on a LIVE mirror is not called stale — the table probe decides (F1)', async () => {
    const env = fakeEnv([
      [],
      [{ tech_id: '222', name: 'AH Tech', business_unit: null, role: 'DummyTech', synced_at: hoursAgo(24 * 30) }],
    ]);
    const out = (await identify_tech_by_phone.handler(env, { phone: '8435365603' }, ctx)) as any;
    expect(out.status).toBe('found');
    expect(out._freshness).toBe('fresh');
    expect(out._warning).toBeUndefined();
  });

  it('does NOT stamp a voice_registry hit — learned table, no sync to disclose', async () => {
    const env = fakeEnv([
      [{ name: 'Brooks Hunsucker', tech_id: '111', role: 'Service', confidence: 0.9 }],
    ]);
    const out = (await identify_tech_by_phone.handler(env, { phone: '8434963573' }, ctx)) as any;
    expect(out.status).toBe('found');
    expect(out.source).toBe('voice_registry');
    expect(out._mirror_table).toBeUndefined();
  });
});
