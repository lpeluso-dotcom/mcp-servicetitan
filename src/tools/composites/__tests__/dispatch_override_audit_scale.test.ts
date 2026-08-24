// ============================================================
// dispatch_override_audit — scale + naming honesty (Wave 2 / B).
//
// Three separate defects, all invisible on a 1-appointment fixture:
//
//  1. NAMING. `overrides = appointments.map(...)` and
//     `overrideCount: overrides.length` counted EVERY appointment in the
//     range. There is no reassignment detection anywhere in the tool — ST's
//     /jpm/v2 appointments feed carries no dispatch history, and the D1
//     appointment_assignments mirror holds current assignments only, with no
//     prior-assignee column to diff against. So "overrideCount: 412" meant
//     "412 appointments existed", which an operator reads as "412 dispatch
//     decisions were overridden". Nothing here can be renamed into truth
//     except the field itself.
//
//  2. ST ids batch. The optional isAutoDispatched join did
//     `ids: jobIds.join(',')` with up to 200 ids. ST 400s above ~50.
//
//  3. D1 bind params. `IN (${apptIds.map(() => '?')})` bound up to 200
//     variables against SQLite's ~100 ceiling — the origin of the
//     `too many SQL variables` errors.
//
// The mirror-freshness stamp (MB-1 / QUA-1141) must survive all of it: it is
// the only thing telling an operator that `technicians: []` means "the sync
// is dead", not "nobody was assigned".
// ============================================================
import { describe, it, expect, vi } from 'vitest';
import { dispatch_override_audit } from '../dispatch_override_audit';
import { ST_IDS_BATCH_MAX, D1_BIND_PARAM_MAX } from '../../../chunk';

const CTX = { actor: 'vitest', correlation: 'scale-corr' };
const ARGS = { from: '2026-07-01', to: '2026-07-27' };

interface Harness {
  env: any;
  jobIdBatches: number[][];
  sqlBodies: Array<{ sql: string; params: unknown[] }>;
}

/**
 * One full page of `count` appointments, then done. Records the `ids=` batches
 * sent to the jobs endpoint and every D1 statement issued.
 */
function harness(count: number, assignmentRows: any[] = []): Harness {
  const appointments = Array.from({ length: count }, (_, i) => ({
    id: 1000 + i,
    jobId: 5000 + i,
    start: '2026-07-20T09:00:00Z',
  }));
  const jobIdBatches: number[][] = [];
  const sqlBodies: Array<{ sql: string; params: unknown[] }> = [];

  const fetcher = vi.fn(async (url: any, init?: RequestInit) => {
    const u = typeof url === 'string' ? url : url.toString();
    if (u.includes('/api/sql/read')) {
      const body = init?.body ? JSON.parse(init.body as string) : {};
      sqlBodies.push(body);
      if (/ AS t,/.test(String(body.sql))) {
        return new Response(
          JSON.stringify({
            success: true,
            results: [{ t: 'appointment_assignments', m: new Date().toISOString() }],
          }),
          { status: 200 },
        );
      }
      const wanted = new Set(body.params as number[]);
      return new Response(
        JSON.stringify({
          success: true,
          results: assignmentRows.filter((r) => wanted.has(r.appointment_id)),
        }),
        { status: 200 },
      );
    }
    if (u.includes('/api/st/read')) {
      const endpoint = decodeURIComponent(new URL(u).searchParams.get('endpoint') ?? '');
      const qs = new URLSearchParams(endpoint.split('?')[1] ?? '');
      if (endpoint.includes('/jobs')) {
        const ids = (qs.get('ids') ?? '').split(',').filter(Boolean).map(Number);
        jobIdBatches.push(ids);
        return new Response(
          JSON.stringify({ data: ids.map((id) => ({ id, isAutoDispatched: true })), hasMore: false }),
          { status: 200 },
        );
      }
      const page = Number(qs.get('page') ?? '1');
      return new Response(
        JSON.stringify({ data: page === 1 ? appointments : [], hasMore: false }),
        { status: 200 },
      );
    }
    return new Response(JSON.stringify({ error: 'no route' }), { status: 500 });
  });

  return {
    env: {
      ST_PROXY: { fetch: fetcher },
      ST_RATE_LIMITER: {
        idFromName: vi.fn().mockReturnValue('rl-id'),
        get: vi.fn().mockReturnValue({
          fetch: vi.fn(async () => new Response(JSON.stringify({ allowed: true }), { status: 200 })),
        }),
      },
      ST_TENANT_ID: '000000000',
      MCP_SYNC_KEY: 'k',
      MCP_SERVICE_VERSION: '0.0.0-test',
    } as any,
    jobIdBatches,
    sqlBodies,
  };
}

/** D1 statements that are the assignments join (not the freshness probe). */
function assignmentStatements(h: Harness) {
  return h.sqlBodies.filter((b) => /FROM appointment_assignments/.test(String(b.sql)));
}

describe('dispatch_override_audit — the count must not claim to be overrides', () => {
  it('does not expose an `overrideCount` / `overrides` field that counts plain appointments', async () => {
    const h = harness(3);
    const out: any = await dispatch_override_audit.handler(h.env, ARGS, CTX);

    expect(out.overrideCount).toBeUndefined();
    expect(out.overrides).toBeUndefined();
  });

  it('names the count for what it actually measures: appointments in range', async () => {
    const h = harness(3);
    const out: any = await dispatch_override_audit.handler(h.env, ARGS, CTX);

    expect(out.appointmentCount).toBe(3);
    expect(out.appointments).toHaveLength(3);
  });

  it('discloses in the payload that no reassignment detection was performed', async () => {
    const h = harness(1);
    const out: any = await dispatch_override_audit.handler(h.env, ARGS, CTX);

    expect(String(out._note ?? '')).toMatch(/not.*(override|reassign)|no reassignment/i);
  });

  it('says so in the tool description too — the LLM picks the tool from that text', () => {
    expect(dispatch_override_audit.description).toMatch(/does NOT|no reassignment|not detect/i);
  });
});

describe('dispatch_override_audit — ST simple-IDs batching', () => {
  it('splits a 200-appointment isAutoDispatched join into <=50-id ST calls', async () => {
    const h = harness(200);
    await dispatch_override_audit.handler(
      h.env,
      { ...ARGS, includeAutoDispatchedFlag: true },
      CTX,
    );

    expect(h.jobIdBatches.length).toBeGreaterThan(1);
    for (const batch of h.jobIdBatches) {
      expect(batch.length).toBeLessThanOrEqual(ST_IDS_BATCH_MAX);
    }
    // Every distinct job id must still be asked for — chunking, not dropping.
    expect(new Set(h.jobIdBatches.flat()).size).toBe(200);
  });

  it('annotates every appointment, not just the ones in the first batch', async () => {
    const h = harness(200);
    const out: any = await dispatch_override_audit.handler(
      h.env,
      { ...ARGS, includeAutoDispatchedFlag: true },
      CTX,
    );

    expect(out.appointments).toHaveLength(200);
    expect(out.appointments.every((r: any) => r.isAutoDispatched === true)).toBe(true);
  });
});

describe('dispatch_override_audit — D1 bind-parameter batching', () => {
  it('never binds more than the SQLite variable ceiling in one statement', async () => {
    const h = harness(200);
    await dispatch_override_audit.handler(h.env, ARGS, CTX);

    const stmts = assignmentStatements(h);
    expect(stmts.length).toBeGreaterThan(1);
    for (const s of stmts) {
      expect(s.params.length).toBeLessThanOrEqual(D1_BIND_PARAM_MAX);
      // Placeholder count must match the bind count or D1 rejects the call.
      const placeholders = (String(s.sql).match(/\?/g) ?? []).length;
      expect(placeholders).toBe(s.params.length);
    }
  });

  it('joins technicians from every chunk, not just the first', async () => {
    const rows = [0, 120, 199].map((i) => ({
      appointment_id: 1000 + i,
      technician_id: 55 + i,
      technician_name: 'Tech',
      status: 'Active',
      synced_at: new Date().toISOString(),
    }));
    const h = harness(200, rows);
    const out: any = await dispatch_override_audit.handler(h.env, ARGS, CTX);

    const withTechs = out.appointments.filter((r: any) => r.technicians.length > 0);
    expect(withTechs.map((r: any) => r.appointmentId)).toEqual([1000, 1120, 1199]);
  });

  it('still emits the mirror-freshness stamp over the chunked reads', async () => {
    const rows = [
      {
        appointment_id: 1000,
        technician_id: 55,
        technician_name: 'Tech',
        status: 'Active',
        synced_at: new Date().toISOString(),
      },
    ];
    const h = harness(200, rows);
    const out: any = await dispatch_override_audit.handler(h.env, ARGS, CTX);

    expect(out._mirror_table).toBe('appointment_assignments');
    expect(out._freshness).toBe('fresh');
    expect(out._empty).toBe(false);
  });
});
