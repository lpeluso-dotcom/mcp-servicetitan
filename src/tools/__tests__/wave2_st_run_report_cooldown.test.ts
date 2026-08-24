// ============================================================
// Wave 2 / Workstream A — st_run_report post-429 cooldown + result cache.
//
// st_run_report is the tool that actually eats 429s: reporting is the most
// expensive ST surface and FAMILY_CAP declares it at 20/min, a cap that was
// never consulted because the tool calls a bare readSTPost. Gating readSTPost
// fixes the pre-emptive half. These tests cover the reactive half:
//
//   * a short result cache, so re-running the same report with the same
//     parameters inside the TTL costs nothing
//   * a post-429 cooldown, so the call AFTER a 429 fails fast locally with a
//     usable retry_after_ms instead of spending another ST request to be told
//     the same thing
// ============================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { st_run_report, _resetReportCooldown, REPORT_RUN_TTL_SEC } from '../reporting/st_run_report';

const CTX = { actor: 'vitest', correlation: 'corr-rr' };

/** D1 mock backing the mcp_cache read-through with a real in-memory table. */
function makeCacheDB() {
  const rows = new Map<string, { value: string; expires_at: number }>();
  return {
    rows,
    prepare: vi.fn((sql: string) => {
      const captured: unknown[] = [];
      const stmt: any = {
        bind: vi.fn((...args: unknown[]) => {
          captured.push(...args);
          return stmt;
        }),
        run: vi.fn(async () => {
          if (/INSERT OR REPLACE INTO mcp_cache/i.test(sql)) {
            rows.set(`${captured[0]}|${captured[1]}`, {
              value: String(captured[2]),
              expires_at: Number(captured[3]),
            });
          }
          return { success: true };
        }),
        first: vi.fn(async () => {
          if (/FROM mcp_cache/i.test(sql)) return rows.get(`${captured[0]}|${captured[1]}`) ?? null;
          return null;
        }),
      };
      return stmt;
    }),
  };
}

function makeEnv(stImpl: (url: string, init?: any) => Promise<Response>) {
  const stFetch = vi.fn(stImpl);
  return {
    ST_PROXY: { fetch: stFetch },
    ST_RATE_LIMITER: {
      idFromName: vi.fn((n: string) => n),
      get: vi.fn(() => ({
        fetch: vi.fn(async () => new Response(JSON.stringify({ allowed: true }), { status: 200 })),
      })),
    },
    MCP_SYNC_KEY: 'k',
    MCP_SERVICE_VERSION: '0.0.0-test',
    ST_TENANT_ID: '000000000',
    DB: makeCacheDB(),
    PROXY_STATE: {},
    SIRO_API_TOKEN: '',
  } as any;
}

const RUN_ARGS = {
  mode: 'run' as const,
  categoryId: 'cat1',
  reportId: 'r1',
  parameters: [{ name: 'From', value: '2026-01-01' }],
};

beforeEach(() => {
  _resetReportCooldown();
});

afterEach(() => {
  vi.useRealTimers();
  _resetReportCooldown();
});

describe('st_run_report result cache', () => {
  it('serves an identical re-run from cache without a second ST call', async () => {
    const env = makeEnv(async () => new Response(JSON.stringify({ rows: [{ a: 1 }] }), { status: 200 }));

    const first: any = await st_run_report.handler(env, { ...RUN_ARGS }, CTX);
    const second: any = await st_run_report.handler(env, { ...RUN_ARGS }, CTX);

    expect(env.ST_PROXY.fetch).toHaveBeenCalledTimes(1);
    expect(first._source).toBe('live');
    expect(second._source).toBe('cache');
    expect(second.data).toEqual(first.data);
  });

  it('treats different parameters as a different report run', async () => {
    const env = makeEnv(async () => new Response(JSON.stringify({ rows: [] }), { status: 200 }));

    await st_run_report.handler(env, { ...RUN_ARGS }, CTX);
    await st_run_report.handler(
      env,
      { ...RUN_ARGS, parameters: [{ name: 'From', value: '2026-02-01' }] },
      CTX
    );

    expect(env.ST_PROXY.fetch).toHaveBeenCalledTimes(2);
  });

  it('treats a different page as a different report run', async () => {
    const env = makeEnv(async () => new Response(JSON.stringify({ rows: [] }), { status: 200 }));

    await st_run_report.handler(env, { ...RUN_ARGS }, CTX);
    await st_run_report.handler(env, { ...RUN_ARGS, page: 2 }, CTX);

    expect(env.ST_PROXY.fetch).toHaveBeenCalledTimes(2);
  });

  it('declares a SHORT ttl (minutes, not hours)', () => {
    expect(REPORT_RUN_TTL_SEC).toBeGreaterThan(0);
    expect(REPORT_RUN_TTL_SEC).toBeLessThanOrEqual(15 * 60);
  });
});

describe('st_run_report post-429 cooldown', () => {
  it('fails the NEXT run fast, without another ST call, after a 429', async () => {
    const env = makeEnv(
      async () => new Response('slow down', { status: 429, headers: { 'Retry-After': '25' } })
    );

    const first: any = await st_run_report.handler(env, { ...RUN_ARGS }, CTX).catch((e) => e);
    expect(first.code).toBe('rate_limited');
    expect(env.ST_PROXY.fetch).toHaveBeenCalledTimes(1);

    // A DIFFERENT report — the reporting API is throttling the tenant, not
    // one report id — must also be held off.
    const second: any = await st_run_report
      .handler(env, { ...RUN_ARGS, reportId: 'r2' }, CTX)
      .catch((e) => e);
    expect(second.code).toBe('rate_limited');
    expect(second.retry_after_ms).toBeGreaterThan(0);
    expect(env.ST_PROXY.fetch).toHaveBeenCalledTimes(1); // no second ST call
  });

  it('lifts the cooldown once Retry-After has elapsed', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-24T12:00:00Z'));

    let calls = 0;
    const env = makeEnv(async () => {
      calls++;
      if (calls === 1) return new Response('slow', { status: 429, headers: { 'Retry-After': '5' } });
      return new Response(JSON.stringify({ rows: [] }), { status: 200 });
    });

    await st_run_report.handler(env, { ...RUN_ARGS }, CTX).catch(() => undefined);
    vi.setSystemTime(new Date('2026-08-24T12:00:06Z'));

    const after: any = await st_run_report.handler(env, { ...RUN_ARGS }, CTX);
    expect(after.mode).toBe('run');
    expect(calls).toBe(2);
  });

  it('does not block the cheap discovery modes', async () => {
    let calls = 0;
    const env = makeEnv(async () => {
      calls++;
      if (calls === 1) return new Response('slow', { status: 429, headers: { 'Retry-After': '60' } });
      return new Response(JSON.stringify({ data: [{ id: 'cat1' }] }), { status: 200 });
    });

    await st_run_report.handler(env, { ...RUN_ARGS }, CTX).catch(() => undefined);

    const cats: any = await st_run_report.handler(env, { mode: 'list_categories' }, CTX);
    expect(cats.mode).toBe('list_categories');
    expect(calls).toBe(2);
  });
});
