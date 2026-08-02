// ============================================================
// find_technician_by_name.test.ts
//
// Thin wrapper around name-resolver's resolveTechnician(), hydrated with
// the full technicians row. Mirrors dawn/identify_tech_by_phone.test.ts's
// ST_PROXY mock — resolveTechnician's index load is call 1, the hydration
// lookup by tech_id is call 2 (skipped on ambiguous). The fetchTableMax
// probe (matched on `AS t,` in the SQL) is routed separately so the FIFO
// queue only feeds the real reads.
// ============================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { find_technician_by_name } from '../find_technician_by_name';
import { _clearResolverCache } from '../../../name-resolver';

type Row = Record<string, unknown>;

function fakeEnv(
  responses: Array<Row[] | { httpStatus?: number; success?: boolean; error?: string }>,
  tableMaxIso: string | null = new Date(Date.now() - 1 * 3_600_000).toISOString(),
) {
  let i = 0;
  const fetcher = vi.fn(async (_url: any, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(init.body as string) : { sql: '' };
    if (/AS t,/.test(String(body.sql))) {
      return new Response(
        JSON.stringify({ success: true, results: [{ t: 'technicians', m: tableMaxIso }] }),
        { status: 200 },
      );
    }
    const r = responses[i++];
    if (r && !Array.isArray(r) && typeof r.httpStatus === 'number') {
      return new Response('upstream', { status: r.httpStatus });
    }
    const env = Array.isArray(r) ? { success: true, results: r } : (r ?? { success: true, results: [] });
    return new Response(JSON.stringify(env), { status: 200 });
  });
  return { ST_PROXY: { fetch: fetcher }, MCP_SYNC_KEY: 'test-key' } as any;
}

/** Non-probe calls only — the FIFO queue the tests reason about. */
function dataCalls(env: any) {
  return (env.ST_PROXY.fetch as any).mock.calls.filter((c: any) => {
    const body = c[1]?.body ? JSON.parse(c[1].body) : { sql: '' };
    return !/AS t,/.test(String(body.sql));
  });
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
    expect(dataCalls(env)).toHaveLength(2);
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
    expect(dataCalls(env)).toHaveLength(1);
  });

  it('accepts a numeric technicianId and skips the name index entirely', async () => {
    const env = fakeEnv([
      [{ tech_id: 75766687, name: 'Brooks Hunsucker', business_unit: 'Electrical Service Residential', role: 'Service' }],
    ]);
    const out = (await find_technician_by_name.handler(env, { name: '75766687' }, ctx)) as any;
    expect(out.status).toBe('found');
    expect(out.technician_name).toBe('Brooks Hunsucker');
    // Numeric passthrough in resolveTechnician never touches D1 — only the hydration call fires.
    expect(dataCalls(env)).toHaveLength(1);
  });

  // Review fix (2026-08-02): the COMMON miss — a name that matches nobody on
  // the roster — used to escape as name-resolver's validation_error and never
  // reach the caveated not_found path. It must now return the same honest
  // not_found envelope the stale-roster miss gets.
  it('returns a caveated not_found (not a thrown validation_error) when no roster name matches', async () => {
    const env = fakeEnv([ROSTER]);
    const out = (await find_technician_by_name.handler(env, { name: 'Nobody Here' }, ctx)) as any;
    expect(out.status).toBe('not_found');
    expect(out.resolved_id).toBeUndefined();
    expect(out._not_found_caveat).toMatch(/mirror/i);
    expect(out._not_found_caveat).toMatch(/sync/i);
    // Fresh roster mirror → the miss is an honest "not on the roster as of
    // the last sync", stamped fresh with no scary warning.
    expect(out._freshness).toBe('fresh');
    expect(out._empty).toBe(true);
    expect(out._warning).toBeUndefined();
  });

  it('still rethrows non-not-found resolver failures (upstream errors)', async () => {
    const env = fakeEnv([
      { httpStatus: 500 },
    ]);
    await expect(find_technician_by_name.handler(env, { name: 'Brooks' }, ctx)).rejects.toMatchObject({
      code: 'upstream_error',
    });
  });

  it('returns not_found with resolved_id if the resolved id has no live technicians row (stale roster)', async () => {
    const env = fakeEnv([ROSTER, []]);
    const out = (await find_technician_by_name.handler(env, { name: 'Brooks Hunsucker' }, ctx)) as any;
    expect(out.status).toBe('not_found');
    expect(out.resolved_id).toBe(75766687);
  });
});

// ── MB-1 / QUA-1141: mirror-freshness disclosure (v2: table-level) ──────
// The hydration read hits the `technicians` D1 mirror. Freshness is judged
// by the table's MAX(synced_at) probe: a hit off a frozen roster is flagged,
// and a miss on a LIVE roster is an honest "not in the mirror as of the last
// sync" — fresh, empty, no scary warning (F5).
describe('find_technician_by_name freshness disclosure (MB-1 / QUA-1141)', () => {
  const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

  it('the hydration SELECT carries synced_at', async () => {
    const env = fakeEnv([ROSTER, []]);
    await find_technician_by_name.handler(env, { name: 'Brooks Hunsucker' }, ctx);
    const body = JSON.parse(dataCalls(env)[1][1].body);
    expect(body.sql).toContain('synced_at');
  });

  it('issues the fetchTableMax probe against the technicians table', async () => {
    const env = fakeEnv([ROSTER, []]);
    await find_technician_by_name.handler(env, { name: 'Brooks Hunsucker' }, ctx);
    const probe = (env.ST_PROXY.fetch as any).mock.calls
      .map((c: any) => (c[1]?.body ? JSON.parse(c[1].body) : { sql: '' }))
      .find((b: any) => /AS t,/.test(String(b.sql)));
    expect(probe).toBeDefined();
    expect(probe.sql).toMatch(/MAX\(synced_at\)/);
    expect(probe.sql).toMatch(/FROM technicians/);
  });

  it('stamps a found row via the table-level probe', async () => {
    const env = fakeEnv(
      [
        ROSTER,
        [{ tech_id: 75766687, name: 'Brooks Hunsucker', business_unit: 'Electrical Service Residential', role: 'Service', synced_at: hoursAgo(2) }],
      ],
      hoursAgo(2),
    );
    const out = (await find_technician_by_name.handler(env, { name: 'Brooks Hunsucker' }, ctx)) as any;
    expect(out.status).toBe('found');
    expect(out._mirror_table).toBe('technicians');
    expect(out._freshness).toBe('fresh');
    expect(out._warning).toBeUndefined();
  });

  it('flags a hit off a frozen roster mirror as stale (table MAX weeks old)', async () => {
    const env = fakeEnv(
      [
        ROSTER,
        [{ tech_id: 75766687, name: 'Brooks Hunsucker', business_unit: 'Electrical Service Residential', role: 'Service', synced_at: hoursAgo(24 * 30) }],
      ],
      hoursAgo(24 * 30),
    );
    const out = (await find_technician_by_name.handler(env, { name: 'Brooks Hunsucker' }, ctx)) as any;
    expect(out._freshness).toBe('stale');
    expect(out._warning).toMatch(/STALE DATA/);
  });

  it('an old ROW on a live roster is not called stale — the table probe decides (F1)', async () => {
    const env = fakeEnv(
      [
        ROSTER,
        [{ tech_id: 75766687, name: 'Brooks Hunsucker', business_unit: 'Electrical Service Residential', role: 'Service', synced_at: hoursAgo(24 * 30) }],
      ],
      hoursAgo(1),
    );
    const out = (await find_technician_by_name.handler(env, { name: 'Brooks Hunsucker' }, ctx)) as any;
    expect(out._freshness).toBe('fresh');
    expect(out._warning).toBeUndefined();
  });

  it('not_found on a LIVE roster carries the caveat but stamps fresh — honest miss, not an alarm (F5)', async () => {
    const env = fakeEnv([ROSTER, []], hoursAgo(1));
    const out = (await find_technician_by_name.handler(env, { name: 'Brooks Hunsucker' }, ctx)) as any;
    expect(out.status).toBe('not_found');
    expect(out._not_found_caveat).toMatch(/mirror/i);
    expect(out._not_found_caveat).toMatch(/sync/i);
    expect(out._freshness).toBe('fresh');
    expect(out._empty).toBe(true);
    expect(out._warning).toBeUndefined();
  });

  it('not_found on an UNPROVABLE mirror (probe fails) stays unknown', async () => {
    const env = fakeEnv([ROSTER, []], null);
    const out = (await find_technician_by_name.handler(env, { name: 'Brooks Hunsucker' }, ctx)) as any;
    expect(out.status).toBe('not_found');
    expect(out._freshness).toBe('unknown');
    expect(out._empty).toBe(true);
  });
});
