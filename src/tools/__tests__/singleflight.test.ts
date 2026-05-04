// ============================================================
// Singleflight tests — verifies the CustomerSnapshotSingleflight
// Durable Object integration in customer_snapshot.
//
// Three paths under test:
//   1. D1 cache hit  → skip DO + fanout entirely
//   2. D1 cache miss + lock acquired → fire fanout, write D1, release
//   3. D1 cache miss + lock not acquired → poll → D1 hit → return cached
// ============================================================

import { describe, it, expect, vi } from 'vitest';
import { customer_snapshot } from '../composites/customer_snapshot';

const CTX = { actor: 'vitest', correlation: 'test-corr' };

function makeDO(acquiredResponse: { acquired: boolean; waitMs?: number }) {
  const doFetch = vi.fn().mockResolvedValue(
    new Response(JSON.stringify(acquiredResponse), { status: 200 })
  );
  return {
    idFromName: vi.fn().mockReturnValue('do-id'),
    get: vi.fn().mockReturnValue({ fetch: doFetch }),
    _doFetch: doFetch,
  };
}

// DB where first() follows a FIFO queue per call site.
// Each prepare() call pops one value from the shared queue.
function makeDB(firstQueue: Array<unknown>) {
  const queue = [...firstQueue];
  return {
    prepare: vi.fn().mockImplementation(() => ({
      bind: vi.fn().mockReturnThis(),
      run: vi.fn().mockResolvedValue({ success: true }),
      first: vi.fn(() => Promise.resolve(queue.length > 0 ? queue.shift() : null)),
      all: vi.fn().mockResolvedValue({ results: [] }),
    })),
  };
}

function makeEnv(fetchImpl: (url: string, init?: RequestInit) => Promise<Response>, firstQueue: Array<unknown> = [], doOverride?: ReturnType<typeof makeDO>): any {
  const singleflightDO = doOverride ?? makeDO({ acquired: true });
  return {
    ST_PROXY: { fetch: vi.fn(fetchImpl) },
    MCP_SYNC_KEY: 'test-key',
    MCP_SERVICE_VERSION: '0.0.0-test',
    DB: makeDB(firstQueue),
    PROXY_STATE: {},
    SIRO_API_TOKEN: '',
    CUSTOMER_SNAPSHOT_FLIGHT: singleflightDO,
  };
}

function liveOk() {
  return async () => new Response(JSON.stringify({ data: [] }), { status: 200 });
}

function cacheHitRow(value: unknown) {
  return { snapshot: JSON.stringify(value), expires_at: Date.now() + 300_000 };
}

// ── Path 1: D1 cache hit ─────────────────────────────────────

describe('singleflight — D1 cache hit', () => {
  it('returns cached snapshot and skips DO acquire + fanout', async () => {
    const cachedSnapshot = {
      customerId: 42,
      _partial: false,
      _failures: [],
      customer: { id: 42, name: 'Cached Alice' },
      locations: [],
      jobs: [],
      memberships: [],
      estimates: [],
      invoices: [],
      _composite: 'customer_snapshot',
      _source: 'mixed',
      correlation: 'old-corr',
    };
    const do_ = makeDO({ acquired: true });
    const env = makeEnv(liveOk(), [cacheHitRow(cachedSnapshot)], do_);

    const result: any = await customer_snapshot.handler(env, { customerId: 42 }, CTX);

    // Served from D1 — source overridden
    expect(result._source).toBe('mv_d1');
    // Correlation updated to current request's
    expect(result.correlation).toBe('test-corr');
    // Data from cache
    expect(result.customer).toEqual({ id: 42, name: 'Cached Alice' });
    // DO and fanout NOT touched
    expect(do_.idFromName).not.toHaveBeenCalled();
    expect(env.ST_PROXY.fetch).not.toHaveBeenCalled();
  });
});

// ── Path 2: cache miss + lock acquired ───────────────────────

describe('singleflight — cache miss, lock acquired', () => {
  it('fires fanout, writes mv_customer_snapshot, returns live result', async () => {
    // DB returns null for first() on the initial cache read, then null again for any subsequent reads
    const env = makeEnv(liveOk(), [null], makeDO({ acquired: true }));

    const result: any = await customer_snapshot.handler(env, { customerId: 42 }, CTX);

    // Fanout fired
    expect(env.ST_PROXY.fetch).toHaveBeenCalled();
    // Live result returned
    expect(result._source).toBe('mixed');
    expect(result.customerId).toBe(42);
    // D1 write was attempted (INSERT OR REPLACE INTO mv_customer_snapshot)
    const prepareCalls: string[] = (env.DB.prepare as ReturnType<typeof vi.fn>).mock.calls.map(
      (call: unknown[]) => call[0] as string
    );
    expect(prepareCalls.some((s) => s.includes('mv_customer_snapshot'))).toBe(true);
  });

  it('acquires DO lock before fanout', async () => {
    const do_ = makeDO({ acquired: true });
    const env = makeEnv(liveOk(), [null], do_);

    await customer_snapshot.handler(env, { customerId: 77 }, CTX);

    expect(do_.idFromName).toHaveBeenCalledWith('77');
    expect(do_._doFetch).toHaveBeenCalledWith(
      'https://do/acquire',
      expect.objectContaining({ method: 'POST' })
    );
  });
});

// ── Path 3: cache miss + lock not acquired → poll → D1 hit ──

describe('singleflight — cache miss, lock not acquired, poll succeeds', () => {
  it('waits for D1 cache to be populated by the first caller and returns mv_d1_wait', async () => {
    const cachedSnapshot = {
      customerId: 55,
      _partial: false,
      _failures: [],
      customer: { id: 55 },
      locations: [],
      jobs: [],
      memberships: [],
      estimates: [],
      invoices: [],
      _composite: 'customer_snapshot',
      _source: 'mixed',
      correlation: 'first-caller-corr',
    };

    // DB: first call → null (initial cache miss), second call → valid row (written by first caller)
    let mvReadCount = 0;
    const db = {
      prepare: vi.fn().mockImplementation(() => ({
        bind: vi.fn().mockReturnThis(),
        run: vi.fn().mockResolvedValue({ success: true }),
        first: vi.fn(() => {
          mvReadCount++;
          if (mvReadCount === 1) return Promise.resolve(null); // initial miss
          return Promise.resolve(cacheHitRow(cachedSnapshot));  // populated by first caller
        }),
        all: vi.fn().mockResolvedValue({ results: [] }),
      })),
    };

    // DO returns not-acquired with short waitMs so the test doesn't actually wait 500ms
    const do_ = makeDO({ acquired: false, waitMs: 1 });
    const env: any = {
      ST_PROXY: { fetch: vi.fn(liveOk()) },
      MCP_SYNC_KEY: 'test-key',
      MCP_SERVICE_VERSION: '0.0.0-test',
      DB: db,
      PROXY_STATE: {},
      SIRO_API_TOKEN: '',
      CUSTOMER_SNAPSHOT_FLIGHT: do_,
    };

    const result: any = await customer_snapshot.handler(env, { customerId: 55 }, CTX);

    // Came from the wait-poll path
    expect(result._source).toBe('mv_d1_wait');
    // Correlation updated to current request
    expect(result.correlation).toBe('test-corr');
    // Fanout was NOT fired by this (waiting) caller
    expect(env.ST_PROXY.fetch).not.toHaveBeenCalled();
  });
});

// ── Degraded path: DO unreachable ───────────────────────────

describe('singleflight — DO unreachable (degraded path)', () => {
  it('fires fanout anyway when DO fetch throws', async () => {
    const doFetch = vi.fn().mockRejectedValue(new Error('DO unreachable'));
    const do_ = {
      idFromName: vi.fn().mockReturnValue('do-id'),
      get: vi.fn().mockReturnValue({ fetch: doFetch }),
      _doFetch: doFetch,
    };
    const env = makeEnv(liveOk(), [null], do_ as any);

    const result: any = await customer_snapshot.handler(env, { customerId: 99 }, CTX);

    // Still returns a live result despite DO failure
    expect(result._source).toBe('mixed');
    expect(result.customerId).toBe(99);
    expect(env.ST_PROXY.fetch).toHaveBeenCalled();
  });
});
