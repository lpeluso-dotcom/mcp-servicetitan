import { describe, it, expect, vi } from 'vitest';
import { st_list_appointments } from '../st_list_appointments';
import { st_list_jobs } from '../st_list_jobs';
import { get_job } from '../jobs/get_job';
import { jobs_hold_reasons_list } from '../jobs/jobs_hold_reasons_list';
import { payroll_job_timesheets_list } from '../payroll/payroll_job_timesheets_list';
import { opportunities_list } from '../opportunities/opportunities_list';
import { assertFilterPreservation } from './filter_preservation_helper';

function liveEnv(body: unknown = { data: [] }, status = 200) {
  const fetcher = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  return {
    ST_TENANT_ID: '431848990',
    ST_PROXY: { fetch: fetcher },
    MCP_SYNC_KEY: 'k',
  } as any;
}

// ─── ST-77 changes ─────────────────────────────────────────────

describe('st_list_appointments — ST-77 active filter', () => {
  it('forwards active=True when true is passed', async () => {
    const env = liveEnv({ data: [], hasMore: false });
    await st_list_appointments.handler(env, { active: true }, { actor: 't', correlation: 'c' });
    const url = (env.ST_PROXY.fetch as any).mock.calls[0][0] as string;
    expect(url).toContain('active%3DTrue');
  });

  it('forwards active=False when false is passed', async () => {
    const env = liveEnv({ data: [], hasMore: false });
    await st_list_appointments.handler(env, { active: false }, { actor: 't', correlation: 'c' });
    const url = (env.ST_PROXY.fetch as any).mock.calls[0][0] as string;
    expect(url).toContain('active%3DFalse');
  });

  it('omits active param when not passed', async () => {
    const env = liveEnv({ data: [], hasMore: false });
    await st_list_appointments.handler(env, {}, { actor: 't', correlation: 'c' });
    const url = (env.ST_PROXY.fetch as any).mock.calls[0][0] as string;
    expect(url).not.toContain('active%3D');
  });

  it('passes returned row.active through unchanged', async () => {
    const env = liveEnv({ data: [{ id: 1, jobId: 100, active: false, start: '2026-05-19T08:00:00Z' }], hasMore: false });
    const out: any = await st_list_appointments.handler(env, {}, { actor: 't', correlation: 'c' });
    expect(out.data[0].active).toBe(false);
  });
});

describe('st_list_appointments — filter preservation harness', () => {
  it('forwards every declared filter to the live URL', async () => {
    await assertFilterPreservation(st_list_appointments, {
      startsOnOrAfter: { value: '2026-05-01T00:00:00Z', expect: 'forwarded_query' },
      startsBefore:    { value: '2026-05-31T23:59:59Z', expect: 'forwarded_query' },
      technicianId:    { value: 777, expect: 'forwarded_query' },
      jobId:           { value: 999, expect: 'forwarded_query' },
      active:          { value: true, expect: 'forwarded_query' },
    });
  });
});

describe('st_list_jobs — ST-77 isAutoDispatched + filter preservation', () => {
  it('passes isAutoDispatched through unchanged on each row', async () => {
    const env = liveEnv({
      data: [
        { id: 1, isAutoDispatched: true, projectId: 50, jobStatus: 'Scheduled' },
        { id: 2, isAutoDispatched: false, projectId: null, jobStatus: 'Completed' },
      ],
      hasMore: false,
    });
    const out: any = await st_list_jobs.handler(env, {}, { actor: 't', correlation: 'c' });
    expect(out.data[0].isAutoDispatched).toBe(true);
    expect(out.data[1].isAutoDispatched).toBe(false);
    expect(out.data[0].projectId).toBe(50);
  });

  it('forwards every declared filter to the live URL', async () => {
    await assertFilterPreservation(st_list_jobs, {
      customerId:        { value: 555, expect: 'forwarded_query' },
      jobStatus:         { value: 'Scheduled', expect: 'forwarded_query' },
      modifiedOnOrAfter: { value: '2026-05-01T00:00:00Z', expect: 'forwarded_query' },
    });
  });
});

describe('get_job — ST-77 isAutoDispatched', () => {
  it('returns isAutoDispatched on the job object', async () => {
    const env = liveEnv({ id: 77423990, isAutoDispatched: true, projectId: 50, jobStatus: 'Completed' });
    const out: any = await get_job.handler(env, { jobId: 77423990 }, { actor: 't', correlation: 'c' });
    expect(out.job.isAutoDispatched).toBe(true);
    expect(out.job.projectId).toBe(50);
  });
});

describe('jobs_hold_reasons_list — new tool', () => {
  it('hits /jpm/v2/.../job-hold-reasons and returns the slim shape', async () => {
    const env = liveEnv({
      data: [
        { id: 1, name: 'Parts ordered', active: true },
        { id: 2, name: 'Customer unavailable', active: true },
        { id: 3, name: 'Legacy reason', active: false },
      ],
      hasMore: false,
      totalCount: 3,
    });
    const out: any = await jobs_hold_reasons_list.handler(env, {}, { actor: 't', correlation: 'c' });
    expect(out._source).toBe('live');
    expect(out.count).toBe(3);
    expect(out.hold_reasons[0]).toEqual({ id: 1, name: 'Parts ordered', active: true });
    expect(out.total_count).toBe(3);
    const url = (env.ST_PROXY.fetch as any).mock.calls[0][0] as string;
    expect(url).toContain('%2Fjpm%2Fv2%2Ftenant%2F431848990%2Fjob-hold-reasons');
  });

  it('forwards active filter', async () => {
    await assertFilterPreservation(jobs_hold_reasons_list, {
      active: { value: true, expect: 'forwarded_query' },
    });
  });
});

// ─── Apply harness to v1.5 readers (regression coverage) ───────

describe('payroll_job_timesheets_list — harness regression', () => {
  // Filter-preservation expectations on the post-QA-fix shape:
  //   jobId, modifiedOnOrAfter → forwarded to live OR honored by D1
  //     (auto mode doesn't fallback w/o a filter, but the SQL still
  //     contains the column — so 'forwarded_d1' is the right assertion
  //     for filters the live path can't express anyway).
  //   technicianId, appointmentId, arrived-window, active → handled in D1
  //     SQL; on auto with an empty D1, must NOT fallback to live
  //     (covered by per-filter rejection_or_skipped semantics already
  //     tested in payroll_job_timesheets_list.test.ts).
  it('jobId is honored in D1 SQL (auto mode)', async () => {
    await assertFilterPreservation(payroll_job_timesheets_list, {
      jobId: { value: 77423990, expect: 'forwarded_d1', column: 'job_id' },
    });
  });

  it('technicianId is honored in D1 SQL', async () => {
    await assertFilterPreservation(payroll_job_timesheets_list, {
      technicianId: { value: 75766687, expect: 'forwarded_d1', column: 'technician_id' },
    });
  });

  it('appointmentId is honored in D1 SQL', async () => {
    await assertFilterPreservation(payroll_job_timesheets_list, {
      appointmentId: { value: 555, expect: 'forwarded_d1', column: 'appointment_id' },
    });
  });
});

describe('opportunities_list — harness regression', () => {
  it('status, customerId, jobId, projectId, businessUnit, jobTypeName all reach D1 SQL', async () => {
    await assertFilterPreservation(opportunities_list, {
      status:        { value: 'Not Attempted', expect: 'forwarded_d1', column: 'status' },
      customerId:    { value: 9001, expect: 'forwarded_d1', column: 'customer_id' },
      jobId:         { value: 100, expect: 'forwarded_d1', column: 'job_id' },
      projectId:     { value: 200, expect: 'forwarded_d1', column: 'project_id' },
      businessUnit:  { value: 'HVAC Service Residential', expect: 'forwarded_d1', column: 'business_unit' },
      jobTypeName:   { value: 'Service Call', expect: 'forwarded_d1', column: 'job_type_name' },
    });
  });
});
