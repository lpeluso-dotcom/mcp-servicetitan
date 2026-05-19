import { describe, it, expect, vi } from 'vitest';
import { job_cost_actuals } from '../composites/job_cost_actuals';
import { tech_drive_time_summary } from '../composites/tech_drive_time_summary';
import { assigned_vs_sold_estimate_audit } from '../composites/assigned_vs_sold_estimate_audit';
import { open_opportunities_pulitzer_feed } from '../composites/open_opportunities_pulitzer_feed';

// Reconciliation reference (2026-05-19 probe): job 77423990 / Brooks Hunsucker.
// drive=24m, working=152m → labor_burden ≈ $132 at $45/hr.
const BROOKS_JOB_ID = 77423990;
const BROOKS_TECH_ID = 75766687;

function multiRouter(
  routes: Array<{ matches: (sql: string) => boolean; rows: any[] | ((p: any[]) => any[]) }>,
  liveBody: any = { data: [] },
) {
  return vi.fn(async (url: any, init?: RequestInit) => {
    const u = typeof url === 'string' ? url : url.toString();
    if (u.includes('/api/sql/read')) {
      const body = init?.body ? JSON.parse(init.body as string) : {};
      for (const route of routes) {
        if (route.matches(body.sql)) {
          const rows = typeof route.rows === 'function' ? route.rows(body.params) : route.rows;
          return new Response(JSON.stringify({ success: true, results: rows }), { status: 200 });
        }
      }
      return new Response(JSON.stringify({ success: true, results: [] }), { status: 200 });
    }
    if (u.includes('/api/st/read')) {
      return new Response(JSON.stringify(liveBody), { status: 200 });
    }
    return new Response(JSON.stringify({ success: false, error: 'no route' }), { status: 500 });
  });
}

function makeEnv(fetcher: any) {
  return {
    ST_TENANT_ID: '000000000',
    ST_PROXY: { fetch: fetcher },
    MCP_SYNC_KEY: 'k',
  } as any;
}

describe('job_cost_actuals', () => {
  it('reconciles to Brooks/77423990 probe: drive 24m + work 152m = $132 burden at $45/hr', async () => {
    const fetcher = multiRouter(
      [
        {
          matches: (sql) => sql.includes('FROM jobs WHERE job_id'),
          rows: [
            {
              job_id: BROOKS_JOB_ID,
              job_number: 'J-77423990',
              customer_id: 9001,
              business_unit: 'Plumbing Service Residential',
              job_type: 'Service Call',
              job_status: 'Completed',
              completed_date: '2026-02-20',
              revenue: 850.0,
              project_id: null,
              modified_at: '2026-02-20T19:34:00Z',
            },
          ],
        },
        {
          matches: (sql) => sql.includes('FROM job_timesheets'),
          rows: [
            {
              timesheet_id: 1,
              job_id: BROOKS_JOB_ID,
              appointment_id: 200,
              technician_id: BROOKS_TECH_ID,
              dispatched_on: '2026-02-20T16:38:00Z',
              arrived_on: '2026-02-20T17:02:00Z',
              canceled_on: null,
              done_on: '2026-02-20T19:34:00Z',
              drive_minutes: 24,
              working_minutes: 152,
              active: 1,
            },
          ],
        },
        { matches: (sql) => sql.includes('FROM appointments'), rows: [] },
        {
          matches: (sql) => sql.includes('FROM appointment_assignments'),
          rows: [
            { assignment_id: 1, appointment_id: 200, job_id: BROOKS_JOB_ID, technician_id: BROOKS_TECH_ID, technician_name: 'Brooks Hunsucker', status: 'Done' },
          ],
        },
        { matches: (sql) => sql.includes('FROM estimates'), rows: [] },
      ],
      { data: [{ id: 5001, jobId: BROOKS_JOB_ID, total: 850 }] },
    );
    const env = makeEnv(fetcher);
    const out: any = await job_cost_actuals.handler(
      env,
      { jobId: BROOKS_JOB_ID },
      { actor: 'test', correlation: 'c1' },
    );
    expect(out.summary.total_drive_minutes).toBe(24);
    expect(out.summary.total_working_minutes).toBe(152);
    expect(out.summary.total_minutes).toBe(176);
    expect(out.summary.labor_burden_$).toBe(132);
    expect(out.summary.revenue).toBe(850);
    expect(out.summary.gross_profit_$).toBe(718);
    expect(out.per_technician.length).toBe(1);
    expect(out.per_technician[0].technician_id).toBe(BROOKS_TECH_ID);
    expect(out.per_technician[0].technician_name).toBe('Brooks Hunsucker');
  });

  it('honors a custom burdenRate', async () => {
    const fetcher = multiRouter([
      { matches: (sql) => sql.includes('FROM jobs'), rows: [{ job_id: 1, revenue: 0 }] },
      {
        matches: (sql) => sql.includes('FROM job_timesheets'),
        rows: [{ timesheet_id: 1, job_id: 1, technician_id: 9, drive_minutes: 30, working_minutes: 90, active: 1 }],
      },
      { matches: (sql) => sql.includes('FROM appointments'), rows: [] },
      { matches: (sql) => sql.includes('FROM appointment_assignments'), rows: [] },
      { matches: (sql) => sql.includes('FROM estimates'), rows: [] },
      { matches: (sql) => sql.includes('FROM technicians'), rows: [{ technician_id: 9, name: 'X', business_unit: null }] },
    ]);
    const env = makeEnv(fetcher);
    const out: any = await job_cost_actuals.handler(
      env,
      { jobId: 1, burdenRate: 60 },
      { actor: 'test', correlation: 'c1' },
    );
    // 120 min * 60/hr = 120 -> $120
    expect(out.summary.labor_burden_$).toBe(120);
  });
});

describe('tech_drive_time_summary', () => {
  it('rolls up window totals + per-day breakdown', async () => {
    const fetcher = multiRouter([
      {
        matches: (sql) => sql.includes('FROM technicians'),
        rows: [{ technician_id: BROOKS_TECH_ID, name: 'Brooks Hunsucker', business_unit: 'Plumbing Service Residential' }],
      },
      {
        matches: (sql) => sql.includes('FROM base'),
        rows: [
          { day: '2026-02-20', jobs: 1, drive_minutes: 24, working_minutes: 152, first_call_drive_minutes: 24 },
          { day: '2026-02-21', jobs: 2, drive_minutes: 40, working_minutes: 200, first_call_drive_minutes: 18 },
        ],
      },
    ]);
    const env = makeEnv(fetcher);
    const out: any = await tech_drive_time_summary.handler(
      env,
      { technicianId: BROOKS_TECH_ID, startDate: '2026-02-20', endDate: '2026-02-21' },
      { actor: 'test', correlation: 'c1' },
    );
    expect(out.technician.name).toBe('Brooks Hunsucker');
    expect(out.totals.days_worked).toBe(2);
    expect(out.totals.jobs).toBe(3);
    expect(out.totals.total_drive_minutes).toBe(64);
    expect(out.totals.total_working_minutes).toBe(352);
    // 64 / (64+352) = 15.4%
    expect(out.totals.drive_pct).toBeCloseTo(15.4, 1);
    // 64 minutes drive × $110/60/hr = $117.33
    expect(out.totals.windshield_cost_$).toBeCloseTo(117.33, 1);
  });
});

describe('assigned_vs_sold_estimate_audit', () => {
  it('flags sold_by_empty when status=Sold and sold_by is blank', async () => {
    const fetcher = multiRouter([
      {
        matches: (sql) => sql.includes('FROM estimates e'),
        rows: [
          // No mismatch — sold_by matches a tech.
          {
            estimate_id: 1,
            job_id: 100,
            status: 'Sold',
            total: 500,
            sold_by: 'Brooks Hunsucker',
            modified_at: '2026-05-15T12:00:00Z',
            job_business_unit: 'PSR',
            job_type: 'SC',
            job_techs_csv: 'Brooks Hunsucker',
          },
          // Empty sold_by + Sold status → flagged.
          {
            estimate_id: 2,
            job_id: 101,
            status: 'Sold',
            total: 700,
            sold_by: '',
            modified_at: '2026-05-15T13:00:00Z',
            job_business_unit: 'PSR',
            job_type: 'SC',
            job_techs_csv: 'Brooks Hunsucker',
          },
          // Tech name mismatch.
          {
            estimate_id: 3,
            job_id: 102,
            status: 'Sold',
            total: 900,
            sold_by: 'Frank Mystery',
            modified_at: '2026-05-15T14:00:00Z',
            job_business_unit: 'PSR',
            job_type: 'SC',
            job_techs_csv: 'Brooks Hunsucker,Carlos Perez',
          },
          // No job link.
          {
            estimate_id: 4,
            job_id: null,
            status: 'Open',
            total: 0,
            sold_by: null,
            modified_at: '2026-05-15T15:00:00Z',
            job_business_unit: null,
            job_type: null,
            job_techs_csv: null,
          },
        ],
      },
    ]);
    const env = makeEnv(fetcher);
    const out: any = await assigned_vs_sold_estimate_audit.handler(
      env,
      { startDate: '2026-05-01', endDate: '2026-05-31' },
      { actor: 'test', correlation: 'c1' },
    );
    expect(out.summary.flagged).toBe(3);
    expect(out.summary.by_reason.sold_by_empty).toBe(1);
    expect(out.summary.by_reason.tech_name_mismatch).toBe(1);
    expect(out.summary.by_reason.no_job_link).toBe(1);
    expect(out.mismatches.find((m: any) => m.estimate_id === 1)).toBeUndefined();
  });
});

describe('open_opportunities_pulitzer_feed', () => {
  it('returns the open cohort sorted oldest-follow-up-first', async () => {
    const fetcher = multiRouter([
      {
        matches: (sql) => sql.includes('FROM opportunities o'),
        rows: [
          {
            opportunity_id: 1,
            job_id: 100,
            project_id: null,
            customer_id: 9001,
            customer_name: 'A',
            customer_phone: null,
            status: 'Not Attempted',
            follow_up_date: '2026-05-10',
            last_follow_up_date: null,
            follow_ups_count: 0,
            estimate_amount: 5000,
            sold_estimate_amount: 0,
            open_estimates_count: 1,
            job_type_name: 'Install',
            business_unit: 'Electrical Install Residential',
            technicians_json: '["A","B"]',
            location_name: null,
            location_address: null,
            created_date: null,
            modified_date: '2026-05-15T08:00:00Z',
            job_completed_on: null,
            latest_estimate_id: 999,
            latest_estimate_name: 'Quote A',
            latest_estimate_status: 'Open',
            latest_estimate_total: 5000,
            latest_estimate_modified_at: '2026-05-15T08:00:00Z',
          },
        ],
      },
    ]);
    const env = makeEnv(fetcher);
    const out: any = await open_opportunities_pulitzer_feed.handler(
      env,
      {},
      { actor: 'test', correlation: 'c1' },
    );
    expect(out.summary.count).toBe(1);
    expect(out.summary.total_estimate_amount).toBe(5000);
    expect(out.opportunities[0].technicians).toEqual(['A', 'B']);
    expect(out.opportunities[0].latest_estimate_id).toBe(999);
  });

  it('passes daysOverdue threshold into SQL', async () => {
    let capturedSql = '';
    const fetcher = vi.fn(async (_url: any, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(init.body as string) : {};
      capturedSql = body.sql;
      return new Response(JSON.stringify({ success: true, results: [] }), { status: 200 });
    });
    const env = makeEnv(fetcher);
    await open_opportunities_pulitzer_feed.handler(
      env,
      { daysOverdue: 30 },
      { actor: 'test', correlation: 'c1' },
    );
    expect(capturedSql).toContain("date('now', '-30 days')");
  });
});
