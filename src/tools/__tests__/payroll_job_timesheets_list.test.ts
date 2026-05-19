import { describe, it, expect, vi } from 'vitest';
import { payroll_job_timesheets_list } from '../payroll/payroll_job_timesheets_list';

// Probe job 77423990 (Brooks Hunsucker, 2026-02-20) shape.
const PROBE_ROW = {
  id: 77457122,
  jobId: 77423990,
  appointmentId: 77423991,
  technicianId: 75766687,
  dispatchedOn: '2026-02-20T16:38:00Z',
  arrivedOn: '2026-02-20T17:02:00Z',
  canceledOn: null,
  doneOn: '2026-02-20T19:34:00Z',
  createdOn: '2026-02-20T16:38:00Z',
  modifiedOn: '2026-02-20T19:34:00Z',
  active: true,
};

function envWith(body: object, status = 200) {
  const fetcher = vi.fn(async () =>
    new Response(JSON.stringify(body), { status }),
  );
  return {
    ST_TENANT_ID: '431848990',
    ST_PROXY: { fetch: fetcher },
    MCP_SYNC_KEY: 'k',
  } as any;
}

describe('payroll_job_timesheets_list', () => {
  it('single-job mode: returns slim shape with computed drive/working minutes', async () => {
    const env = envWith({ data: [PROBE_ROW] });
    const out = (await payroll_job_timesheets_list.handler(
      env,
      { jobId: 77423990 },
      { actor: 'test', correlation: 'c1' },
    )) as any;
    expect(out.count).toBe(1);
    expect(out.has_more).toBe(false);
    expect(out._source).toBe('live');
    expect(out.timesheets[0]).toEqual({
      timesheet_id: 77457122,
      job_id: 77423990,
      appointment_id: 77423991,
      technician_id: 75766687,
      dispatched_on: '2026-02-20T16:38:00Z',
      arrived_on: '2026-02-20T17:02:00Z',
      canceled_on: null,
      done_on: '2026-02-20T19:34:00Z',
      drive_minutes: 24,
      working_minutes: 152,
      active: true,
      created_on: '2026-02-20T16:38:00Z',
      modified_on: '2026-02-20T19:34:00Z',
    });
    const calledUrl = (env.ST_PROXY.fetch as any).mock.calls[0][0];
    // Per-job endpoint, no pagination params.
    expect(calledUrl).toContain('%2Fpayroll%2Fv2%2Ftenant%2F431848990%2Fjobs%2F77423990%2Ftimesheets');
    expect(calledUrl).not.toContain('page%3D');
    expect(calledUrl).not.toContain('modifiedOnOrAfter');
  });

  it('batch mode: paginates and forwards modifiedOnOrAfter + active=Any', async () => {
    const env = envWith({ data: [PROBE_ROW], hasMore: true });
    const out = (await payroll_job_timesheets_list.handler(
      env,
      { modifiedOnOrAfter: '2026-05-01T00:00:00Z', page: 2, pageSize: 250 },
      { actor: 'test', correlation: 'c1' },
    )) as any;
    expect(out.count).toBe(1);
    expect(out.has_more).toBe(true);
    expect(out.timesheets[0].drive_minutes).toBe(24);
    expect(out.timesheets[0].working_minutes).toBe(152);
    const calledUrl = (env.ST_PROXY.fetch as any).mock.calls[0][0];
    expect(calledUrl).toContain('%2Fpayroll%2Fv2%2Ftenant%2F431848990%2Fjobs%2Ftimesheets');
    expect(calledUrl).toContain('page%3D2');
    expect(calledUrl).toContain('pageSize%3D250');
    expect(calledUrl).toContain('active%3DAny');
    expect(calledUrl).toContain('modifiedOnOrAfter%3D2026-05-01T00%253A00%253A00Z');
  });

  it('null timestamps produce null drive_minutes / working_minutes', async () => {
    const inProgress = {
      ...PROBE_ROW,
      id: 9999,
      arrivedOn: undefined,
      doneOn: undefined,
    };
    const env = envWith({ data: [inProgress] });
    const out = (await payroll_job_timesheets_list.handler(
      env,
      { jobId: 77423990 },
      { actor: 'test', correlation: 'c1' },
    )) as any;
    expect(out.timesheets[0].arrived_on).toBeNull();
    expect(out.timesheets[0].done_on).toBeNull();
    expect(out.timesheets[0].drive_minutes).toBeNull();
    expect(out.timesheets[0].working_minutes).toBeNull();
  });

  it('throws McpError on upstream failure', async () => {
    const env = envWith({}, 503);
    await expect(
      payroll_job_timesheets_list.handler(env, { jobId: 1 }, { actor: 'test', correlation: 'c1' }),
    ).rejects.toThrow(/payroll_job_timesheets_list failed: 503/);
  });

  it('returns empty list when ST returns no data', async () => {
    const env = envWith({ data: [] });
    const out = (await payroll_job_timesheets_list.handler(
      env,
      {},
      { actor: 'test', correlation: 'c1' },
    )) as any;
    expect(out.count).toBe(0);
    expect(out.timesheets).toEqual([]);
  });
});
