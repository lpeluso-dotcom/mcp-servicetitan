import { describe, it, expect, vi } from 'vitest';
import { payroll_settings_get } from '../payroll/payroll_settings_get';

describe('payroll_settings_get', () => {
  it('returns spread settings object with _source live', async () => {
    const settingsPayload = {
      payPeriodType: 'BiWeekly',
      overtimeThresholdHours: 40,
      payrollStartDay: 'Monday',
      someOtherSetting: true,
    };
    const env = {
      ST_TENANT_ID: '000000000',
      ST_PROXY: {
        fetch: vi.fn(async () => new Response(JSON.stringify(settingsPayload), { status: 200 })),
      },
      MCP_SYNC_KEY: 'k',
    } as any;
    const out = (await payroll_settings_get.handler(env, {}, { actor: 'test', correlation: 'c1' })) as any;
    expect(out.payPeriodType).toBe('BiWeekly');
    expect(out.overtimeThresholdHours).toBe(40);
    expect(out.payrollStartDay).toBe('Monday');
    expect(out.someOtherSetting).toBe(true);
    expect(out._source).toBe('live');
    const calledUrl = (env.ST_PROXY.fetch as any).mock.calls[0][0];
    expect(calledUrl).toContain('%2Fpayroll%2Fv2%2Ftenant%2F000000000%2Fpayroll-settings');
  });

  it('throws McpError on upstream failure', async () => {
    const env = {
      ST_TENANT_ID: '000000000',
      ST_PROXY: { fetch: vi.fn(async () => new Response('', { status: 500 })) },
      MCP_SYNC_KEY: 'k',
    } as any;
    await expect(
      payroll_settings_get.handler(env, {}, { actor: 'test', correlation: 'c1' }),
    ).rejects.toThrow(/readST 500 on \/payroll\/v2\/tenant\/000000000\/payroll-settings/);
  });
});
