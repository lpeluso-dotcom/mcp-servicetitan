// ============================================================
// job_cost_actuals — the silent-zero defect.
//
// With no timesheet rows the tool computed labor_burden_$ = 0 and then reported
// gross_profit_$ = revenue and gross_margin_pct = 100 — a plausible-looking,
// completely wrong answer. Verified live against prod 2026-07-28, job 30035955:
//
//   summary: { labor_burden_$: 0, revenue: 170, gross_profit_$: 170,
//              gross_margin_pct: 100 }
//   timesheets: []          assignments: [3 techs, all status "Done"]
//
// Three technicians were assigned and the job completed, so labor certainly
// happened — D1 just has no timesheet rows for it. `job_timesheets` holds 7,910
// rows spanning 2025-12-08..2026-07-27 (5,206 distinct jobs); job 30035955
// completed 2023-02-21, well outside that window.
//
// Zero-by-absence must never be presented as zero-by-measurement: this tool
// feeds margin review, and a 100% margin reads as a great job rather than a
// missing input.
// ============================================================
import { describe, it, expect, vi } from 'vitest';
import { job_cost_actuals } from '../job_cost_actuals';

function multiRouter(routes: Array<{ matches: (sql: string) => boolean; rows: any[] }>, liveBody: any = { data: [] }) {
  return vi.fn(async (url: any, init?: RequestInit) => {
    const u = typeof url === 'string' ? url : url.toString();
    if (u.includes('/api/sql/read')) {
      const body = init?.body ? JSON.parse(init.body as string) : {};
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
}

function makeEnv(fetcher: any) {
  return { ST_TENANT_ID: '000000000', ST_PROXY: { fetch: fetcher }, MCP_SYNC_KEY: 'k' } as any;
}

const CTX = { actor: 'vitest', correlation: 'c1' };

/** Job 30035955 as it really is in D1: revenue, assignments, zero timesheets. */
function noTimesheetRoutes() {
  return [
    {
      matches: (sql: string) => sql.includes('FROM jobs WHERE job_id'),
      rows: [{
        job_id: 30035955, customer_id: 11483641, business_unit: 'HVAC Service Residential',
        job_type: null, job_status: 'Completed', completed_date: '2023-02-21T15:31:11.267Z',
        revenue: 170, project_id: null, modified_at: '2023-02-21T15:31:13.9847366Z',
      }],
    },
    { matches: (sql: string) => sql.includes('FROM job_timesheets'), rows: [] },
    { matches: (sql: string) => sql.includes('FROM appointments'), rows: [] },
    {
      matches: (sql: string) => sql.includes('FROM appointment_assignments'),
      rows: [
        { assignment_id: 30047732, appointment_id: 30035956, job_id: 30035955, technician_id: 5522937, technician_name: 'Jonathan Smallwood', status: 'Done' },
        { assignment_id: 30068980, appointment_id: 30068979, job_id: 30035955, technician_id: 5522937, technician_name: 'Jonathan Smallwood', status: 'Done' },
        { assignment_id: 30114166, appointment_id: 30068979, job_id: 30035955, technician_id: 22127859, technician_name: 'Hunter Sawyer', status: 'Done' },
      ],
    },
    { matches: (sql: string) => sql.includes('FROM estimates'), rows: [] },
  ];
}

describe('job_cost_actuals with no timesheet rows', () => {
  it('warns instead of silently reporting a 100% gross margin', async () => {
    const out: any = await job_cost_actuals.handler(makeEnv(multiRouter(noTimesheetRoutes())), { jobId: 30035955 }, CTX);

    expect(out.timesheets).toEqual([]);
    expect(out._warnings, 'no _warnings emitted for a zero-timesheet job').toBeDefined();
    const warned = out._warnings.join(' ');
    expect(warned).toMatch(/labor/i);
    expect(warned).toMatch(/timesheet/i);

    // The misleading derived figures must not be presented as measured.
    expect(out.summary.gross_margin_pct, 'a 100% margin was reported from missing data').toBeNull();
    expect(out.summary.gross_profit_$).toBeNull();
    expect(out.summary.labor_burden_basis).toBe('none');
  });

  it('names the assigned technicians as evidence that labor actually occurred', async () => {
    const out: any = await job_cost_actuals.handler(makeEnv(multiRouter(noTimesheetRoutes())), { jobId: 30035955 }, CTX);

    // 3 assignment rows, 2 distinct techs — the warning should surface that
    // labor happened despite the absent timesheets.
    expect(out._warnings.join(' ')).toMatch(/assign/i);
  });

  it('still reports real margin figures when timesheets DO exist', async () => {
    const routes = noTimesheetRoutes().map((r) =>
      r.matches('FROM job_timesheets')
        ? {
            matches: r.matches,
            rows: [{
              timesheet_id: 1, job_id: 30035955, appointment_id: 200, technician_id: 5522937,
              dispatched_on: null, arrived_on: '2026-02-20T17:02:00Z', canceled_on: null,
              done_on: null, drive_minutes: 24, working_minutes: 152, active: 1,
            }],
          }
        : r,
    );

    const out: any = await job_cost_actuals.handler(makeEnv(multiRouter(routes)), { jobId: 30035955 }, CTX);

    // (24 + 152)/60 * 45 = 132
    expect(out.summary.labor_burden_$).toBeCloseTo(132, 2);
    expect(out.summary.gross_profit_$).toBeCloseTo(38, 2);
    expect(out.summary.gross_margin_pct).not.toBeNull();
    expect(out.summary.labor_burden_basis).toBe('timesheets');
    expect((out._warnings ?? []).join(' ')).not.toMatch(/labor_burden_unavailable/);
  });
});
