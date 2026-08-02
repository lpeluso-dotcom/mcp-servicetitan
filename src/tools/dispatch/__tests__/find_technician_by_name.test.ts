// ============================================================
// find_technician_by_name.test.ts
//
// Thin wrapper around name-resolver's resolveTechnician(), hydrated with
// the full technicians row. Mirrors dawn/identify_tech_by_phone.test.ts's
// FIFO ST_PROXY mock — resolveTechnician's index load is call 1, the
// hydration lookup by tech_id is call 2 (skipped on ambiguous/numeric-miss).
// ============================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { find_technician_by_name } from '../find_technician_by_name';
import { _clearResolverCache } from '../../../name-resolver';

type Row = Record<string, unknown>;

function fakeEnv(responses: Array<Row[] | { httpStatus?: number; success?: boolean; error?: string }>) {
  let i = 0;
  const fetcher = vi.fn(async () => {
    const r = responses[i++];
    if (r && !Array.isArray(r) && typeof r.httpStatus === 'number') {
      return new Response('upstream', { status: r.httpStatus });
    }
    const env = Array.isArray(r) ? { success: true, results: r } : (r ?? { success: true, results: [] });
    return new Response(JSON.stringify(env), { status: 200 });
  });
  return { ST_PROXY: { fetch: fetcher }, MCP_SYNC_KEY: 'test-key' } as any;
}

const ctx = { actor: 'test', correlation: 'c1' };

const ROSTER = [
  { id: 75766687, name: 'Brooks Hunsucker' },
  { id: 62109686, name: 'Wade Gaskins' },
  { id: 38575308, name: 'Harold Boseman' },
];

beforeEach(() => {
  _clearResolverCache();
});

describe('find_technician_by_name', () => {
  it('resolves an exact name match and hydrates the technician row', async () => {
    const env = fakeEnv([
      ROSTER,
      [{ tech_id: 75766687, name: 'Brooks Hunsucker', business_unit: 'Electrical Service Residential', role: 'Service' }],
    ]);
    const out = (await find_technician_by_name.handler(env, { name: 'Brooks Hunsucker' }, ctx)) as any;
    expect(out.status).toBe('found');
    expect(out.technician_id).toBe(75766687);
    expect(out.technician_name).toBe('Brooks Hunsucker');
    expect(out.business_unit).toBe('Electrical Service Residential');
    expect(out.resolved).toBe('exact');
    expect((env.ST_PROXY.fetch as any).mock.calls).toHaveLength(2);
  });

  it('resolves a partial/prefix name match', async () => {
    const env = fakeEnv([
      ROSTER,
      [{ tech_id: 75766687, name: 'Brooks Hunsucker', business_unit: 'Electrical Service Residential', role: 'Service' }],
    ]);
    const out = (await find_technician_by_name.handler(env, { name: 'Brooks' }, ctx)) as any;
    expect(out.status).toBe('found');
    expect(out.technician_id).toBe(75766687);
    expect(out.resolved).toBe('prefix');
  });

  it('returns ambiguous with candidates and skips hydration when multiple names match', async () => {
    const env = fakeEnv([
      [{ id: 1, name: 'Tech Adams' }, { id: 2, name: 'Tech Aiken' }],
    ]);
    const out = (await find_technician_by_name.handler(env, { name: 'Tech A' }, ctx)) as any;
    expect(out.status).toBe('ambiguous');
    expect(out.candidates.map((c: any) => c.id).sort()).toEqual([1, 2]);
    // Only the resolver's index load fired — no hydration call for an ambiguous match.
    expect((env.ST_PROXY.fetch as any).mock.calls).toHaveLength(1);
  });

  it('accepts a numeric technicianId and skips the name index entirely', async () => {
    const env = fakeEnv([
      [{ tech_id: 75766687, name: 'Brooks Hunsucker', business_unit: 'Electrical Service Residential', role: 'Service' }],
    ]);
    const out = (await find_technician_by_name.handler(env, { name: '75766687' }, ctx)) as any;
    expect(out.status).toBe('found');
    expect(out.technician_name).toBe('Brooks Hunsucker');
    // Numeric passthrough in resolveTechnician never touches D1 — only the hydration call fires.
    expect((env.ST_PROXY.fetch as any).mock.calls).toHaveLength(1);
  });

  it('rejects when no roster name matches', async () => {
    const env = fakeEnv([ROSTER]);
    await expect(find_technician_by_name.handler(env, { name: 'Nobody Here' }, ctx)).rejects.toMatchObject({
      code: 'validation_error',
    });
  });

  it('returns not_found if the resolved id has no live technicians row (stale roster)', async () => {
    const env = fakeEnv([ROSTER, []]);
    const out = (await find_technician_by_name.handler(env, { name: 'Brooks Hunsucker' }, ctx)) as any;
    expect(out.status).toBe('not_found');
    expect(out.resolved_id).toBe(75766687);
  });
});

// ── MB-1 / QUA-1141: mirror-freshness disclosure ─────────────────
// The hydration read hits the `technicians` D1 mirror: a hit must prove its
// age via synced_at, and a not_found means "not in the MIRROR" — new hires
// are absent until the next sync, so a miss is not proof the tech doesn't
// exist in ServiceTitan.
describe('find_technician_by_name freshness disclosure (MB-1 / QUA-1141)', () => {
  const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

  it('the hydration SELECT carries synced_at', async () => {
    const env = fakeEnv([ROSTER, []]);
    await find_technician_by_name.handler(env, { name: 'Brooks Hunsucker' }, ctx);
    const body = JSON.parse((env.ST_PROXY.fetch as any).mock.calls[1][1].body);
    expect(body.sql).toContain('synced_at');
  });

  it('stamps a found row with row-level mirror freshness', async () => {
    const env = fakeEnv([
      ROSTER,
      [{ tech_id: 75766687, name: 'Brooks Hunsucker', business_unit: 'Electrical Service Residential', role: 'Service', synced_at: hoursAgo(2) }],
    ]);
    const out = (await find_technician_by_name.handler(env, { name: 'Brooks Hunsucker' }, ctx)) as any;
    expect(out.status).toBe('found');
    expect(out._mirror_table).toBe('technicians');
    expect(out._freshness).toBe('fresh');
    expect(out._warning).toBeUndefined();
  });

  it('flags a hit off a frozen roster mirror as stale', async () => {
    const env = fakeEnv([
      ROSTER,
      [{ tech_id: 75766687, name: 'Brooks Hunsucker', business_unit: 'Electrical Service Residential', role: 'Service', synced_at: hoursAgo(24 * 30) }],
    ]);
    const out = (await find_technician_by_name.handler(env, { name: 'Brooks Hunsucker' }, ctx)) as any;
    expect(out._freshness).toBe('stale');
    expect(out._warning).toMatch(/STALE DATA/);
  });

  it('not_found carries the mirror caveat — new hires are absent until the next sync', async () => {
    const env = fakeEnv([ROSTER, []]);
    const out = (await find_technician_by_name.handler(env, { name: 'Brooks Hunsucker' }, ctx)) as any;
    expect(out.status).toBe('not_found');
    expect(out._not_found_caveat).toMatch(/mirror/i);
    expect(out._not_found_caveat).toMatch(/sync/i);
    expect(out._freshness).toBe('unknown');
    expect(out._empty).toBe(true);
  });
});
