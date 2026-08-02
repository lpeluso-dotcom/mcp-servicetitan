// ============================================================
// job_cost_actuals — freshness disclosure (MB-1 / QUA-1141)
//
// The money figure (labor_burden_$) is computed off the D1 `job_timesheets`
// mirror, which has been frozen in production. The tool already discloses
// zero-by-absence via its QUA-1066 _warnings mechanism — the stamp must
// INTEGRATE with it: stamp fields at top level, stamp warning concatenated
// into the _warnings array, never a colliding top-level _warning.
//
// job_cost_actuals also carries an outputSchema, so structuredContent is
// validated against it AT RUNTIME on every call (QUA-1108): every stamp
// field must be declared or the tool fails in production while unit tests
// stay green.
// ============================================================
import { describe, it, expect, vi } from 'vitest';
import { job_cost_actuals } from '../job_cost_actuals';

const CTX = { actor: 'vitest', correlation: 'c1' };
const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

function multiRouter(routes: Array<{ matches: (sql: string) => boolean; rows: any[] }>, liveBody: any = { data: [] }) {
  const bodies: Array<{ sql: string; params: unknown[] }> = [];
  const fetcher = vi.fn(async (url: any, init?: RequestInit) => {
    const u = typeof url === 'string' ? url : url.toString();
    if (u.includes('/api/sql/read')) {
      const body = init?.body ? JSON.parse(init.body as string) : {};
      bodies.push(body);
      for (const route of routes) {
        if (route.matches(body.sql)) {
          return new Response(JSON.stringify({ success: true, results: route.rows }), { status: 200 });
        }
      }
      return new Response(JSON.stringify({ success: true, results: [] }), { status: 200 });
    }
    if (u.includes('/api/st/read')) return new Response(JSON.stringify(liveBody), { status: 200 });
    return new Response(JSON.stringify({ success: false, error: 'no route' }), { status: 500 });
  });
  return { fetcher, bodies };
}

function makeEnv(fetcher: any) {
  return { ST_TENANT_ID: '000000000', ST_PROXY: { fetch: fetcher }, MCP_SYNC_KEY: 'k' } as any;
}

/** Brooks/77423990 probe shape, with a controllable timesheet synced_at. */
function routes(timesheetRows: any[]) {
  return [
    {
      matches: (sql: string) => sql.includes('FROM jobs WHERE job_id'),
      rows: [{
        job_id: 77423990, customer_id: 9001, business_unit: 'Plumbing Service Residential',
        job_type: 'Service Call', job_status: 'Completed', completed_date: '2026-02-20',
        revenue: 850, project_id: null, modified_at: '2026-02-20T19:34:00Z',
      }],
    },
    { matches: (sql: string) => sql.includes('FROM job_timesheets'), rows: timesheetRows },
    { matches: (sql: string) => sql.includes('FROM appointments'), rows: [] },
    {
      matches: (sql: string) => sql.includes('FROM appointment_assignments'),
      rows: [{ assignment_id: 1, appointment_id: 200, job_id: 77423990, technician_id: 75766687, technician_name: 'Brooks Hunsucker', status: 'Done' }],
    },
    { matches: (sql: string) => sql.includes('FROM estimates'), rows: [] },
  ];
}

const tsRow = (synced_at: string) => ({
  timesheet_id: 1, job_id: 77423990, appointment_id: 200, technician_id: 75766687,
  dispatched_on: '2026-02-20T16:38:00Z', arrived_on: '2026-02-20T17:02:00Z', canceled_on: null,
  done_on: '2026-02-20T19:34:00Z', drive_minutes: 24, working_minutes: 152, active: 1, synced_at,
});

describe('job_cost_actuals freshness disclosure (MB-1 / QUA-1141)', () => {
  it('the job_timesheets SELECT carries synced_at — it is the read that drives money', async () => {
    const { fetcher, bodies } = multiRouter(routes([]));
    await job_cost_actuals.handler(makeEnv(fetcher), { jobId: 77423990 }, CTX);
    const tsSql = bodies.map((b) => b.sql).find((s) => s.includes('FROM job_timesheets'));
    expect(tsSql, 'never queried job_timesheets').toBeDefined();
    expect(tsSql!).toContain('synced_at');
  });

  it('marks fresh timesheets authoritative with no warnings', async () => {
    const { fetcher } = multiRouter(routes([tsRow(hoursAgo(2))]));
    const out: any = await job_cost_actuals.handler(makeEnv(fetcher), { jobId: 77423990 }, CTX);
    expect(out._mirror_table).toBe('job_timesheets');
    expect(out._freshness).toBe('fresh');
    expect(out.summary.metrics_are_authoritative).toBe(true);
    expect(out._warning).toBeUndefined();
    expect(out._warnings).toBeUndefined();
  });

  it('concatenates a stale-mirror warning into _warnings — never a colliding top-level _warning', async () => {
    const { fetcher } = multiRouter(routes([tsRow(hoursAgo(24 * 30))]));
    const out: any = await job_cost_actuals.handler(makeEnv(fetcher), { jobId: 77423990 }, CTX);
    expect(out._freshness).toBe('stale');
    expect(out.summary.metrics_are_authoritative).toBe(false);
    expect(out._warning).toBeUndefined();
    expect(out._warnings.join(' ')).toMatch(/STALE DATA/);
    // The stale burden figure is still computed — the disclosure rides alongside.
    expect(out.summary.labor_burden_$).toBeCloseTo(132, 2);
  });

  it('keeps BOTH disclosures on the zero-timesheet path: labor-burden absence AND the empty-mirror stamp', async () => {
    const { fetcher } = multiRouter(routes([]));
    const out: any = await job_cost_actuals.handler(makeEnv(fetcher), { jobId: 77423990 }, CTX);
    expect(out._empty).toBe(true);
    expect(out._freshness).toBe('unknown');
    expect(out.summary.metrics_are_authoritative).toBe(false);
    const warned = out._warnings.join(' ');
    expect(warned).toMatch(/labor_burden_unavailable/);
    expect(warned).toMatch(/not proof/i);
    expect(out._warning).toBeUndefined();
  });

  // ── QUA-1108 regression: outputSchema must declare every emitted key ──
  it('every key of every real envelope is declared in the outputSchema (runtime validation trap)', async () => {
    const declared = new Set(Object.keys(job_cost_actuals.outputSchema!));

    const fresh = multiRouter(routes([tsRow(hoursAgo(1))]));
    const freshOut: any = await job_cost_actuals.handler(makeEnv(fresh.fetcher), { jobId: 77423990 }, CTX);
    const empty = multiRouter(routes([]));
    const emptyOut: any = await job_cost_actuals.handler(makeEnv(empty.fetcher), { jobId: 77423990 }, CTX);
    const stale = multiRouter(routes([tsRow(hoursAgo(24 * 30))]));
    const staleOut: any = await job_cost_actuals.handler(makeEnv(stale.fetcher), { jobId: 77423990 }, CTX);

    for (const out of [freshOut, emptyOut, staleOut]) {
      for (const key of Object.keys(out)) {
        expect(declared.has(key), `response key "${key}" is NOT declared in outputSchema — this fails runtime structuredContent validation in production`).toBe(true);
      }
    }
  });
});
