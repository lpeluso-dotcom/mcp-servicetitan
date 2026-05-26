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
 */
function fakeEnv(responses: Array<Row[] | { httpStatus?: number; success?: boolean; error?: string }>) {
  let i = 0;
  const fetcher = vi.fn(async () => {
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
    // Tier 2 should NOT have fired.
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
    expect((env.ST_PROXY.fetch as any).mock.calls).toHaveLength(2);
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
    expect((env.ST_PROXY.fetch as any).mock.calls).toHaveLength(2);
  });

  it('rejects too-short numbers before hitting D1', async () => {
    const env = fakeEnv([]);
    const out = (await identify_tech_by_phone.handler(env, { phone: '123' }, ctx)) as any;
    expect(out.status).toBe('parse_error');
    expect(out.message).toMatch(/too short/i);
    expect((env.ST_PROXY.fetch as any).mock.calls).toHaveLength(0);
  });

  it('wraps upstream HTTP 500 as parse_error (never throws)', async () => {
    const env = fakeEnv([{ httpStatus: 500 }]);
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
