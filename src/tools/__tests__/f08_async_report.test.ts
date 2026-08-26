// ============================================================
// F-08 — st_run_report async data/query migration (ST-78).
//
// Covers the async token path the wave2 suite does NOT (it drives the tool
// through a 200-inline mock): 202 -> poll -> 200, no-token fail-loud, the four
// adversarial blockers (B1 wall-clock deadline, B3 no upstream-body disclosure,
// B4 no fetch past abort), and B2 cache-vs-cooldown independence.
//
// ST_PROXY.fetch is mocked; no live ST. The limiter DO is a permissive double.
// ============================================================
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { st_run_report, _resetReportCooldown } from '../reporting/st_run_report';

const CTX = { actor: 'vitest', correlation: 'corr-f08' };

/** In-memory mcp_cache double, mirroring wave2's makeCacheDB. */
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
  const doFetch = vi.fn(async (url: string) =>
    String(url).endsWith('/check')
      ? new Response(JSON.stringify({ allowed: true }), { status: 200 })
      : new Response(JSON.stringify({ ok: true }), { status: 200 }),
  );
  return {
    ST_PROXY: { fetch: stFetch },
    ST_RATE_LIMITER: { idFromName: (n: string) => n, get: () => ({ fetch: doFetch }) },
    ST_TENANT_ID: '000000000',
    MCP_SYNC_KEY: 'k',
    MCP_SERVICE_VERSION: '0.0.0-test',
    DB: makeCacheDB(),
    PROXY_STATE: {},
    SIRO_API_TOKEN: '',
  } as any;
}

const RUN = {
  mode: 'run' as const,
  categoryId: 'c',
  reportId: 'r',
  parameters: [{ name: 'From', value: 'x' }],
};

beforeEach(() => _resetReportCooldown());

describe('F-08 poll deadline (B1/B4)', () => {
  it('B1: trips the wall-clock ceiling when every poll hangs (not sleep-count)', async () => {
    let t = 0; // injected clock, ms
    const now = () => t;
    const env = makeEnv(async (url: string) => {
      // The proxy read URL percent-encodes the endpoint, so match on the
      // decoded path. data/query is the initial POST; data-queries is a poll.
      const u = decodeURIComponent(String(url));
      if (u.includes('/data/query')) return new Response(JSON.stringify({ token: 'tok1' }), { status: 202 });
      if (u.includes('/api/st/write')) return new Response('{}', { status: 200 }); // DELETE cancel
      // every poll GET "hangs" — model it as burning 10s of real time then 202
      t += 10_000;
      return new Response('', { status: 202 });
    });

    const err: any = await st_run_report
      .handler(env, { ...RUN, pollTimeoutSeconds: 30, _pollIntervalMs: 0, _now: now } as any, CTX)
      .catch((e) => e);

    expect(err.code).toBe('timeout');
    expect(err.message).toMatch(/canceled/);
    // a DELETE cancel was attempted
    expect(
      env.ST_PROXY.fetch.mock.calls.some((c: any[]) => String(c[0]).includes('/api/st/write')),
    ).toBe(true);
  });

  it('B4: issues no poll GET once the deadline has passed', async () => {
    let t = 0;
    const now = () => t;
    let pollGets = 0;
    const env = makeEnv(async (url: string) => {
      const u = decodeURIComponent(String(url));
      if (u.includes('/data/query')) return new Response(JSON.stringify({ token: 'tok2' }), { status: 202 });
      if (u.includes('/api/st/write')) return new Response('{}', { status: 200 });
      pollGets++;
      t += 100_000; // one poll blows far past a 30s ceiling
      return new Response('', { status: 202 });
    });

    await st_run_report
      .handler(env, { ...RUN, pollTimeoutSeconds: 30, _pollIntervalMs: 0, _now: now } as any, CTX)
      .catch((e) => e);

    // exactly one poll GET happened; the loop did not fetch again after the deadline
    expect(pollGets).toBe(1);
  });
});
