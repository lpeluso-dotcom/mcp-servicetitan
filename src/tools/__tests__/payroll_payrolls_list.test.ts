import { describe, it, expect, vi } from 'vitest';
import { payroll_payrolls_list } from '../payroll/payroll_payrolls_list';

function fakeEnv() {
  const fetcher = vi.fn(async () =>
    new Response(
      JSON.stringify({
        data: [
          {
            id: 300,
            employeeId: 42,
            payrollPeriodId: 7,
            status: 'Approved',
            grossPay: 2400.0,
            netPay: 1800.0,
            periodStart: '2024-04-01',
            periodEnd: '2024-04-14',
          },
          {
            id: 301,
            // employeeId, payrollPeriodId, periodStart, periodEnd intentionally omitted
            status: 'Pending',
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

describe('payroll_payrolls_list', () => {
  it('returns slim payroll records and forwards filters', async () => {
    const env = fakeEnv();
    const out = (await payroll_payrolls_list.handler(
      env,
      { employeeId: 42, status: 'Approved' },
      { actor: 'test', correlation: 'c1' },
    )) as any;
    expect(out.count).toBe(2);
    expect(out.payrolls[0]).toEqual({
      id: 300,
      employee_id: 42,
      payroll_period_id: 7,
      status: 'Approved',
      gross_pay: 2400.0,
      net_pay: 1800.0,
      period_start: '2024-04-01',
      period_end: '2024-04-14',
    });
    // omitted fields fall back to null / 0
    expect(out.payrolls[1].employee_id).toBeNull();
    expect(out.payrolls[1].payroll_period_id).toBeNull();
    expect(out.payrolls[1].period_start).toBeNull();
    expect(out.payrolls[1].period_end).toBeNull();
    expect(out.payrolls[1].gross_pay).toBe(0);
    const calledUrl = (env.ST_PROXY.fetch as any).mock.calls[0][0];
    expect(calledUrl).toContain('%2Fpayroll%2Fv2%2Ftenant%2F000000000%2Fpayrolls');
    expect(calledUrl).toContain('employeeId%3D42');
    expect(calledUrl).toContain('status%3DApproved');
    expect(out.has_more).toBe(false);
    expect(out._source).toBe('live');
  });

  it('forwards payrollPeriodId filter into the URL', async () => {
    const env = fakeEnv();
    await payroll_payrolls_list.handler(env, { payrollPeriodId: 7 }, { actor: 'test', correlation: 'c1' });
    const calledUrl = (env.ST_PROXY.fetch as any).mock.calls[0][0];
    expect(calledUrl).toContain('payrollPeriodId%3D7');
  });

  it('throws McpError on upstream failure', async () => {
    const env = {
      ST_TENANT_ID: '000000000',
      ST_PROXY: { fetch: vi.fn(async () => new Response('', { status: 503 })) },
      MCP_SYNC_KEY: 'k',
    } as any;
    await expect(
      payroll_payrolls_list.handler(env, {}, { actor: 'test', correlation: 'c1' }),
    ).rejects.toThrow(/readST 503 on \/payroll\/v2\/tenant\/.+\/payrolls/);
  });

  it('returns count=0 and payrolls=[] when ST returns empty data', async () => {
    const env = {
      ST_TENANT_ID: '000000000',
      ST_PROXY: {
        fetch: vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 })),
      },
      MCP_SYNC_KEY: 'k',
    } as any;
    const out = (await payroll_payrolls_list.handler(env, {}, { actor: 'test', correlation: 'c1' })) as any;
    expect(out.count).toBe(0);
    expect(out.payrolls).toEqual([]);
  });
});
