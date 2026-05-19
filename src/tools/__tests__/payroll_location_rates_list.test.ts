import { describe, it, expect, vi } from 'vitest';
import { payroll_location_rates_list } from '../payroll/payroll_location_rates_list';

function fakeEnv() {
  const fetcher = vi.fn(async () =>
    new Response(
      JSON.stringify({
        data: [
          {
            id: 500,
            locationId: 20,
            hourlyRate: 18.5,
            active: true,
          },
          {
            id: 501,
            // locationId, active intentionally omitted — exercises the `?? null` defaults
            hourlyRate: 0,
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

describe('payroll_location_rates_list', () => {
  it('returns slim location rate records and forwards filters', async () => {
    const env = fakeEnv();
    const out = (await payroll_location_rates_list.handler(
      env,
      { active: true, locationId: 20 },
      { actor: 'test', correlation: 'c1' },
    )) as any;
    expect(out.count).toBe(2);
    expect(out.rates[0]).toEqual({
      id: 500,
      location_id: 20,
      hourly_rate: 18.5,
      active: true,
    });
    // omitted fields fall back to null / 0
    expect(out.rates[1].location_id).toBeNull();
    expect(out.rates[1].active).toBeNull();
    const calledUrl = (env.ST_PROXY.fetch as any).mock.calls[0][0];
    expect(calledUrl).toContain('%2Fpayroll%2Fv2%2Ftenant%2F000000000%2Flocations%2Frates');
    expect(calledUrl).toContain('active%3Dtrue');
    expect(calledUrl).toContain('locationId%3D20');
    expect(out.has_more).toBe(false);
    expect(out._source).toBe('live');
  });

  it('passes active=false through to the URL', async () => {
    const env = fakeEnv();
    await payroll_location_rates_list.handler(env, { active: false }, { actor: 'test', correlation: 'c1' });
    const calledUrl = (env.ST_PROXY.fetch as any).mock.calls[0][0];
    expect(calledUrl).toContain('active%3Dfalse');
  });

  it('throws McpError on upstream failure', async () => {
    const env = {
      ST_TENANT_ID: '000000000',
      ST_PROXY: { fetch: vi.fn(async () => new Response('', { status: 500 })) },
      MCP_SYNC_KEY: 'k',
    } as any;
    await expect(
      payroll_location_rates_list.handler(env, {}, { actor: 'test', correlation: 'c1' }),
    ).rejects.toThrow(/readST 500 on \/payroll\/v2\/tenant\/.+\/locations\/rates/);
  });

  it('omits active filter when not provided', async () => {
    const env = fakeEnv();
    await payroll_location_rates_list.handler(env, {}, { actor: 'test', correlation: 'c1' });
    const calledUrl = (env.ST_PROXY.fetch as any).mock.calls[0][0];
    expect(calledUrl).not.toContain('active%3D');
  });
});
