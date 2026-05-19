import { describe, it, expect, vi } from 'vitest';
import { payroll_non_job_timesheets_list } from '../payroll/payroll_non_job_timesheets_list';

function fakeEnv() {
  const fetcher = vi.fn(async () =>
    new Response(
      JSON.stringify({
        data: [
          {
            id: 400,
            employeeId: 42,
            activityCodeId: 8,
            date: '2024-04-10',
            hours: 2.5,
            notes: 'Team meeting',
          },
          {
            id: 401,
            // employeeId, activityCodeId, date, notes intentionally omitted
            hours: 0,
          },
        ],
        hasMore: false,
      }),
      { status: 200 },
    ),
  );
  return {
    ST_TENANT_ID: '000000000',
    ST_PROXY: { fetch: fetcher },
    MCP_SYNC_KEY: 'k',
  } as any;
}

describe('payroll_non_job_timesheets_list', () => {
  it('returns slim timesheet records and forwards filters', async () => {
    const env = fakeEnv();
    const out = (await payroll_non_job_timesheets_list.handler(
      env,
      { employeeId: 42, activityCodeId: 8 },
      { actor: 'test', correlation: 'c1' },
    )) as any;
    expect(out.count).toBe(2);
    expect(out.timesheets[0]).toEqual({
      id: 400,
      employee_id: 42,
      activity_code_id: 8,
      date: '2024-04-10',
      hours: 2.5,
      notes: 'Team meeting',
    });
    // omitted fields fall back to null / defaults
    expect(out.timesheets[1].employee_id).toBeNull();
    expect(out.timesheets[1].activity_code_id).toBeNull();
    expect(out.timesheets[1].date).toBeNull();
    expect(out.timesheets[1].notes).toBe('');
    const calledUrl = (env.ST_PROXY.fetch as any).mock.calls[0][0];
    expect(calledUrl).toContain('%2Fpayroll%2Fv2%2Ftenant%2F000000000%2Fnon-job-timesheets');
    expect(calledUrl).toContain('employeeId%3D42');
    expect(calledUrl).toContain('activityCodeId%3D8');
    expect(out.has_more).toBe(false);
    expect(out._source).toBe('live');
  });

  it('maps fromDate/toDate to startsOnOrAfter/endsOnOrBefore in the URL', async () => {
    const env = fakeEnv();
    await payroll_non_job_timesheets_list.handler(
      env,
      { fromDate: '2024-04-01', toDate: '2024-04-30' },
      { actor: 'test', correlation: 'c1' },
    );
    const calledUrl = (env.ST_PROXY.fetch as any).mock.calls[0][0];
    expect(calledUrl).toContain('startsOnOrAfter%3D2024-04-01');
    expect(calledUrl).toContain('endsOnOrBefore%3D2024-04-30');
  });

  it('throws McpError on upstream failure', async () => {
    const env = {
      ST_TENANT_ID: '000000000',
      ST_PROXY: { fetch: vi.fn(async () => new Response('', { status: 502 })) },
      MCP_SYNC_KEY: 'k',
    } as any;
    await expect(
      payroll_non_job_timesheets_list.handler(env, {}, { actor: 'test', correlation: 'c1' }),
    ).rejects.toThrow(/readST 502 on \/payroll\/v2\/tenant\/.+\/non-job-timesheets/);
  });

  it('returns count=0 and timesheets=[] when ST returns empty data', async () => {
    const env = {
      ST_TENANT_ID: '000000000',
      ST_PROXY: {
        fetch: vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 })),
      },
      MCP_SYNC_KEY: 'k',
    } as any;
    const out = (await payroll_non_job_timesheets_list.handler(
      env,
      {},
      { actor: 'test', correlation: 'c1' },
    )) as any;
    expect(out.count).toBe(0);
    expect(out.timesheets).toEqual([]);
  });
});
