// ============================================================
// dispatch_override_audit — freshness disclosure (MB-1 / QUA-1141)
//
// HYBRID tool: appointments come from LIVE ServiceTitan (authoritative, not
// stamped); the per-appointment `technicians` arrays are joined from the D1
// `appointment_assignments` mirror. Only that mirror-sourced portion gets a
// stamp — `_mirror_table: 'appointment_assignments'` scopes it. The trap:
// with the mirror empty/frozen, every appointment shows `technicians: []`,
// which reads as "nobody assigned" rather than "the sync is broken".
// ============================================================
import { describe, it, expect, vi } from 'vitest';
import { dispatch_override_audit } from '../dispatch_override_audit';

const CTX = { actor: 'vitest', correlation: 'c1' };
const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

const ARGS = { from: '2026-07-01', to: '2026-07-27' };

/** Route the live appointments read and the D1 assignments read. */
function makeEnv(appointments: any[], assignmentRows: any[]) {
  const bodies: Array<{ sql: string; params: unknown[] }> = [];
  const fetcher = vi.fn(async (url: any, init?: RequestInit) => {
    const u = typeof url === 'string' ? url : url.toString();
    if (u.includes('/api/sql/read')) {
      const body = init?.body ? JSON.parse(init.body as string) : {};
      bodies.push(body);
      return new Response(JSON.stringify({ success: true, results: assignmentRows }), { status: 200 });
    }
    if (u.includes('/api/st/read')) {
      return new Response(JSON.stringify({ data: appointments }), { status: 200 });
    }
    return new Response(JSON.stringify({ success: false, error: 'no route' }), { status: 500 });
  });
  return { env: { ST_TENANT_ID: '000000000', ST_PROXY: { fetch: fetcher }, MCP_SYNC_KEY: 'k' } as any, bodies };
}

const APPT = { id: 1001, jobId: 2002, start: '2026-07-20T09:00:00Z' };
const asg = (synced_at: string | null) => ({
  appointment_id: 1001, technician_id: 55, technician_name: 'Bob', status: 'Active', synced_at,
});

describe('dispatch_override_audit freshness disclosure (MB-1 / QUA-1141)', () => {
  it('the appointment_assignments SELECT carries synced_at', async () => {
    const { env, bodies } = makeEnv([APPT], []);
    await dispatch_override_audit.handler(env, ARGS, CTX);
    const asgSql = bodies.map((b) => b.sql).find((s) => s.includes('FROM appointment_assignments'));
    expect(asgSql, 'never queried appointment_assignments').toBeDefined();
    expect(asgSql!).toContain('synced_at');
  });

  it('stamps ONLY the mirror-sourced portion — live appointments stay authoritative', async () => {
    const { env } = makeEnv([APPT], [asg(hoursAgo(2))]);
    const out: any = await dispatch_override_audit.handler(env, ARGS, CTX);
    expect(out._mirror_table).toBe('appointment_assignments');
    expect(out._freshness).toBe('fresh');
    expect(out._source).toBe('live');
    expect(out._warnings).toBeUndefined();
    // synced_at is stamp plumbing, not part of the technicians row shape.
    expect(out.overrides[0].technicians[0].technician_id).toBe(55);
    expect(out.overrides[0].technicians[0].synced_at).toBeUndefined();
  });

  it('concatenates a stale-mirror warning into the existing _warnings array — never a top-level _warning', async () => {
    const { env } = makeEnv([APPT], [asg(hoursAgo(24 * 30))]);
    const out: any = await dispatch_override_audit.handler(env, ARGS, CTX);
    expect(out._freshness).toBe('stale');
    expect(out._warning).toBeUndefined();
    expect(out._warnings.join(' ')).toMatch(/STALE DATA/);
  });

  it('flags an empty assignments mirror — technicians: [] must not read as "nobody assigned"', async () => {
    const { env } = makeEnv([APPT], []);
    const out: any = await dispatch_override_audit.handler(env, ARGS, CTX);
    expect(out.overrides[0].technicians).toEqual([]);
    expect(out._empty).toBe(true);
    expect(out._freshness).toBe('unknown');
    expect(out._warnings.join(' ')).toMatch(/not proof/i);
  });

  it('emits no stamp when no appointments exist — there was no mirror read to disclose', async () => {
    const { env } = makeEnv([], []);
    const out: any = await dispatch_override_audit.handler(env, ARGS, CTX);
    expect(out.overrides).toEqual([]);
    expect(out._mirror_table).toBeUndefined();
    expect(out._warnings).toBeUndefined();
  });
});
