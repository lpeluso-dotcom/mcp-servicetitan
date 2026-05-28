import { describe, it, expect, vi } from 'vitest';
import { get_job_history } from '../jobs/get_job_history';

function fakeEnv(payload: unknown, status = 200) {
  const fetcher = vi.fn(async () => new Response(JSON.stringify(payload), { status }));
  return {
    ST_TENANT_ID: '000000000',
    ST_PROXY: { fetch: fetcher },
    MCP_SYNC_KEY: 'k',
  } as any;
}

describe('get_job_history', () => {
  it('returns the event list and pagination metadata', async () => {
    const env = fakeEnv({
      data: [
        { id: 1, jobId: 12345, eventType: 'Created', createdOn: '2026-04-28T10:00:00Z' },
        { id: 2, jobId: 12345, eventType: 'Scheduled', createdOn: '2026-04-28T10:01:00Z' },
      ],
      hasMore: false,
      totalCount: 2,
    });
    const out = (await get_job_history.handler(
      env,
      { jobId: 12345 },
      { actor: 'test', correlation: 'c1' },
    )) as any;
    expect(out.jobId).toBe(12345);
    expect(out.count).toBe(2);
    expect(out.events).toHaveLength(2);
    expect(out.events[0].eventType).toBe('Created');
    expect(out.has_more).toBe(false);
    expect(out.total_count).toBe(2);
    expect(out._source).toBe('live');
  });

  it('hits the canonical ST job-history endpoint path', async () => {
    const env = fakeEnv({ data: [], hasMore: false });
    await get_job_history.handler(
      env,
      { jobId: 79996179 },
      { actor: 'test', correlation: 'c1' },
    );
    const calledUrl = (env.ST_PROXY.fetch as any).mock.calls[0][0] as string;
    // URL-encoded form of /jpm/v2/tenant/000000000/jobs/79996179/history
    expect(calledUrl).toContain('%2Fjpm%2Fv2%2Ftenant%2F000000000%2Fjobs%2F79996179%2Fhistory');
  });

  it('forwards page and pageSize when provided', async () => {
    const env = fakeEnv({ data: [], hasMore: false });
    await get_job_history.handler(
      env,
      { jobId: 12345, page: 2, pageSize: 50 },
      { actor: 'test', correlation: 'c1' },
    );
    const calledUrl = (env.ST_PROXY.fetch as any).mock.calls[0][0] as string;
    expect(calledUrl).toContain('page%3D2');
    expect(calledUrl).toContain('pageSize%3D50');
  });

  it('omits page/pageSize when not provided', async () => {
    const env = fakeEnv({ data: [], hasMore: false });
    await get_job_history.handler(env, { jobId: 12345 }, { actor: 'test', correlation: 'c1' });
    const calledUrl = (env.ST_PROXY.fetch as any).mock.calls[0][0] as string;
    expect(calledUrl).not.toContain('page%3D');
    expect(calledUrl).not.toContain('pageSize%3D');
  });

  it('defaults empty data to an empty events array', async () => {
    const env = fakeEnv({ hasMore: false }); // no `data` key at all
    const out = (await get_job_history.handler(
      env,
      { jobId: 12345 },
      { actor: 'test', correlation: 'c1' },
    )) as any;
    expect(out.events).toEqual([]);
    expect(out.count).toBe(0);
  });

  it('throws McpError on upstream failure', async () => {
    const env = fakeEnv('', 503);
    await expect(
      get_job_history.handler(env, { jobId: 12345 }, { actor: 'test', correlation: 'c1' }),
    ).rejects.toThrow(/readST 503 on \/jpm\/v2\/tenant\/000000000\/jobs\/12345\/history/);
  });
});
