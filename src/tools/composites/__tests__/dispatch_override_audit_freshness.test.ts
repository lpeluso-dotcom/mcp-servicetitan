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

/**
 * Route the live appointments read, the D1 assignments read, and the
 * fetchTableMax probe (matched on `AS t,`; defaults to a fresh 1h MAX).
 */
function makeEnv(appointments: any[], assignmentRows: any[], tableMax: string | null = hoursAgo(1)) {
  const bodies: Array<{ sql: string; params: unknown[] }> = [];
  const fetcher = vi.fn(async (url: any, init?: RequestInit) => {
    const u = typeof url === 'string' ? url : url.toString();
    if (u.includes('/api/sql/read')) {
      const body = init?.body ? JSON.parse(init.body as string) : {};
      bodies.push(body);
      if (/ AS t,/.test(String(body.sql))) {
        return new Response(
          JSON.stringify({ success: true, results: [{ t: 'appointment_assignments', m: tableMax }] }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ success: true, results: assignmentRows }), { status: 200 });
    }
    if (u.includes('/api/st/read')) {
      return new Response(JSON.stringify({ data: appointments }), { status: 200 });
    }
    return new Response(JSON.stringify({ success: false, error: 'no route' }), { status: 500 });
  });
  // ST_RATE_LIMITER: the appointments read now drains pages through
  // pagedStRead, which checks the rate-limiter DO once per page attempt.
  const rateLimiter = {
    idFromName: vi.fn().mockReturnValue('rl-id'),
    get: vi.fn().mockReturnValue({
      fetch: vi.fn(async () => new Response(JSON.stringify({ allowed: true }), { status: 200 })),
    }),
  };
  return {
    env: {
      ST_TENANT_ID: '000000000',
      ST_PROXY: { fetch: fetcher },
      ST_RATE_LIMITER: rateLimiter,
      MCP_SYNC_KEY: 'k',
      MCP_SERVICE_VERSION: '0.0.0-test',
    } as any,
    bodies,
  };
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
    expect(out.appointments[0].technicians[0].technician_id).toBe(55);
    expect(out.appointments[0].technicians[0].synced_at).toBeUndefined();
  });

  it('concatenates a stale-mirror warning into the existing _warnings array — never a top-level _warning', async () => {
    const { env } = makeEnv([APPT], [asg(hoursAgo(24 * 30))], hoursAgo(24 * 30));
    const out: any = await dispatch_override_audit.handler(env, ARGS, CTX);
    expect(out._freshness).toBe('unknown');
    expect(out._warning).toBeUndefined();
    expect(out._warnings.join(' ')).toMatch(/no row change in|indistinguishable/);
  });

  it('old assignment rows on a LIVE mirror are not called stale — the table probe decides (F1)', async () => {
    const { env } = makeEnv([APPT], [asg(hoursAgo(24 * 30))]);
    const out: any = await dispatch_override_audit.handler(env, ARGS, CTX);
    expect(out._freshness).toBe('fresh');
    expect(out._warnings).toBeUndefined();
  });

  it('zero assignment rows on a LIVE mirror is an honest "nobody assigned" (F5)', async () => {
    const { env } = makeEnv([APPT], []);
    const out: any = await dispatch_override_audit.handler(env, ARGS, CTX);
    expect(out.appointments[0].technicians).toEqual([]);
    expect(out._empty).toBe(true);
    expect(out._freshness).toBe('fresh');
    expect(out._warnings).toBeUndefined();
  });

  it('flags an UNPROVABLE assignments mirror — technicians: [] must not read as "nobody assigned"', async () => {
    const { env } = makeEnv([APPT], [], null);
    const out: any = await dispatch_override_audit.handler(env, ARGS, CTX);
    expect(out.appointments[0].technicians).toEqual([]);
    expect(out._empty).toBe(true);
    expect(out._freshness).toBe('unknown');
    expect(out._warnings.join(' ')).toMatch(/not proof/i);
  });

  it('emits no stamp when no appointments exist — there was no mirror read to disclose', async () => {
    const { env } = makeEnv([], []);
    const out: any = await dispatch_override_audit.handler(env, ARGS, CTX);
    expect(out.appointments).toEqual([]);
    expect(out._mirror_table).toBeUndefined();
    expect(out._warnings).toBeUndefined();
  });
});
