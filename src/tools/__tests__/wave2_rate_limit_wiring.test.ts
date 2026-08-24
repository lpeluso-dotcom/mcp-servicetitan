// ============================================================
// Wave 2 / Workstream A — rate limiter wiring.
//
// At origin/main `checkRateLimit` had exactly ONE live caller
// (paged-st-read.ts), so `readST` / `readSTPost` / `readSTPaged` and every
// direct ST_PROXY write were completely ungoverned. These tests pin the
// wiring down:
//
//   1. the limiter is consulted exactly once per readST / readSTPost call
//   2. an ST 429 yields McpError('rate_limited') with a populated
//      retry_after_ms, and reports the backoff to the DO
//   3. an UNDECLARED endpoint family is capped (DEFAULT_FAMILY_CAP) rather
//      than being implicitly unlimited (`count >= undefined` === false)
//   4. the AGGREGATE cap trips across two DIFFERENT families — proof that
//      the aggregate counter lives in ONE DO instance, not one per family
// ============================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { StRateLimiter, DEFAULT_FAMILY_CAP } from '../../durable/st-rate-limiter';
import { familyFromEndpoint, checkRateLimit } from '../../rate-limit-guard';
import { readST, readSTPost } from '../../st';
import { McpError } from '../../errors';

// ── in-memory DO plumbing ───────────────────────────────────

function makeStorage() {
  const m = new Map<string, unknown>();
  return {
    map: m,
    get: vi.fn(async <T = unknown>(k: string) => m.get(k) as T),
    put: vi.fn(async (k: string, v: unknown) => {
      m.set(k, v);
    }),
    delete: vi.fn(async (k: string) => m.delete(k)),
  };
}

function makeDOState(storage: ReturnType<typeof makeStorage>): any {
  return {
    storage,
    blockConcurrencyWhile: async (fn: () => Promise<void>) => {
      await fn();
    },
  };
}

async function doCheck(rl: StRateLimiter, family: string) {
  const req = new Request('https://do/check', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ family }),
  });
  return rl.fetch(req).then((r) => r.json<{ allowed: boolean; retryAfter?: number }>());
}

/**
 * A DurableObjectNamespace that instantiates a REAL StRateLimiter per id
 * name. This is what makes the aggregate-cap test meaningful: if
 * checkRateLimit derives the id from the family, each family gets its own
 * instance and its own aggregate counter.
 */
function makeLiveLimiterNamespace() {
  const instances = new Map<string, StRateLimiter>();
  const idFromName = vi.fn((name: string) => name);
  const get = vi.fn((name: string) => {
    if (!instances.has(name)) {
      instances.set(name, new StRateLimiter(makeDOState(makeStorage())));
    }
    const rl = instances.get(name)!;
    return { fetch: (url: string, init: RequestInit) => rl.fetch(new Request(url, init)) };
  });
  return { ns: { idFromName, get } as any, instances, idFromName };
}

/** A limiter namespace that always allows, so we can count consultations. */
function makeAllowingLimiter() {
  const doFetch = vi.fn(async (url: string, _init?: any): Promise<Response> => {
    if (url.endsWith('/check')) {
      return new Response(JSON.stringify({ allowed: true }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  });
  return {
    doFetch,
    ns: {
      idFromName: vi.fn((n: string) => n),
      get: vi.fn(() => ({ fetch: doFetch })),
    } as any,
  };
}

const CTX = { actor: 'test', correlation: 'corr-1' };

function makeEnv(stProxyFetch: any, limiterNs: any) {
  return {
    ST_PROXY: { fetch: stProxyFetch },
    ST_RATE_LIMITER: limiterNs,
    MCP_SYNC_KEY: 'k',
    ST_TENANT_ID: '000000000',
  } as any;
}

// ── 1. one consultation per call ────────────────────────────

describe('readST / readSTPost are gated by the rate limiter', () => {
  let limiter: ReturnType<typeof makeAllowingLimiter>;
  beforeEach(() => {
    limiter = makeAllowingLimiter();
  });

  it('consults the limiter exactly once per readST call', async () => {
    const stFetch = vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 }));
    const env = makeEnv(stFetch, limiter.ns);

    await readST(env, CTX, '/crm/v2/tenant/000000000/customers');

    const checks = (limiter.doFetch.mock.calls as any[][]).filter((c) => String(c[0]).endsWith('/check'));
    expect(checks).toHaveLength(1);
    expect(stFetch).toHaveBeenCalledTimes(1);
  });

  it('passes the endpoint family to the limiter', async () => {
    const stFetch = vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 }));
    const env = makeEnv(stFetch, limiter.ns);

    await readST(env, CTX, '/pricebook/v2/tenant/000000000/services');

    const body = JSON.parse((limiter.doFetch.mock.calls[0] as any[])[1].body);
    expect(body.family).toBe('pricebook');
  });

  it('does not call ST at all when the limiter denies', async () => {
    const denying = {
      idFromName: vi.fn((n: string) => n),
      get: vi.fn(() => ({
        fetch: vi.fn(async () =>
          new Response(JSON.stringify({ allowed: false, retryAfter: 12 }), { status: 200 })
        ),
      })),
    } as any;
    const stFetch = vi.fn(async () => new Response('{}', { status: 200 }));
    const env = makeEnv(stFetch, denying);

    await expect(readST(env, CTX, '/crm/v2/tenant/000000000/customers')).rejects.toMatchObject({
      code: 'rate_limited',
      retry_after_ms: 12_000,
    });
    expect(stFetch).not.toHaveBeenCalled();
  });

  it('consults the limiter exactly once per readSTPost call', async () => {
    const stFetch = vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 }));
    const env = makeEnv(stFetch, limiter.ns);

    await readSTPost(env, CTX, '/reporting/v2/tenant/000000000/report-category/1/reports/2/data', {
      parameters: [],
    });

    const checks = (limiter.doFetch.mock.calls as any[][]).filter((c) => String(c[0]).endsWith('/check'));
    expect(checks).toHaveLength(1);
    expect(JSON.parse((limiter.doFetch.mock.calls[0] as any[])[1].body).family).toBe('reporting');
  });

  it('consults the limiter once per PAGE in readSTPaged', async () => {
    const { readSTPaged } = await import('../../st');
    let page = 0;
    const stFetch = vi.fn(async () => {
      page++;
      return new Response(JSON.stringify({ data: [{ id: page }], hasMore: page < 3 }), { status: 200 });
    });
    const env = makeEnv(stFetch, limiter.ns);

    const res = await readSTPaged(env, CTX, '/jpm/v2/tenant/000000000/jobs');

    expect(res.pagesFetched).toBe(3);
    const checks = (limiter.doFetch.mock.calls as any[][]).filter((c) => String(c[0]).endsWith('/check'));
    expect(checks).toHaveLength(3);
  });
});

// ── 2. 429 handling ─────────────────────────────────────────

describe('ST 429 handling', () => {
  it('readST turns a 429 into McpError(rate_limited) with retry_after_ms from Retry-After', async () => {
    const limiter = makeAllowingLimiter();
    const stFetch = vi.fn(
      async () => new Response('too many', { status: 429, headers: { 'Retry-After': '17' } })
    );
    const env = makeEnv(stFetch, limiter.ns);

    const err: any = await readST(env, CTX, '/crm/v2/tenant/000000000/customers').catch((e) => e);
    expect(err).toBeInstanceOf(McpError);
    expect(err.code).toBe('rate_limited');
    expect(err.retry_after_ms).toBe(17_000);

    const backoffs = (limiter.doFetch.mock.calls as any[][]).filter((c) => String(c[0]).endsWith('/backoff'));
    expect(backoffs).toHaveLength(1);
    expect(JSON.parse((backoffs[0] as any[])[1].body)).toEqual({ family: 'crm', retryAfter: 17 });
  });

  it('readST defaults retry_after_ms when Retry-After is absent', async () => {
    const limiter = makeAllowingLimiter();
    const stFetch = vi.fn(async () => new Response('too many', { status: 429 }));
    const env = makeEnv(stFetch, limiter.ns);

    const err: any = await readST(env, CTX, '/crm/v2/tenant/000000000/customers').catch((e) => e);
    expect(err.code).toBe('rate_limited');
    expect(err.retry_after_ms).toBe(60_000);
  });

  it('readSTPost reports backoff on 429', async () => {
    const limiter = makeAllowingLimiter();
    const stFetch = vi.fn(
      async () => new Response('slow down', { status: 429, headers: { 'Retry-After': '30' } })
    );
    const env = makeEnv(stFetch, limiter.ns);

    const err: any = await readSTPost(env, CTX, '/reporting/v2/tenant/000000000/x/data', {}).catch((e) => e);
    expect(err.code).toBe('rate_limited');
    expect(err.retry_after_ms).toBe(30_000);
    const backoffs = (limiter.doFetch.mock.calls as any[][]).filter((c) => String(c[0]).endsWith('/backoff'));
    expect(JSON.parse((backoffs[0] as any[])[1].body)).toEqual({ family: 'reporting', retryAfter: 30 });
  });

  it('non-429 upstream failures do NOT report a backoff', async () => {
    const limiter = makeAllowingLimiter();
    const stFetch = vi.fn(async () => new Response('boom', { status: 500 }));
    const env = makeEnv(stFetch, limiter.ns);

    await expect(readST(env, CTX, '/crm/v2/tenant/000000000/customers')).rejects.toThrow();
    const backoffs = (limiter.doFetch.mock.calls as any[][]).filter((c) => String(c[0]).endsWith('/backoff'));
    expect(backoffs).toHaveLength(0);
  });
});

// ── 3. undeclared families are capped, not unlimited ────────

describe('DEFAULT_FAMILY_CAP', () => {
  it('is exported and finite', () => {
    expect(Number.isFinite(DEFAULT_FAMILY_CAP)).toBe(true);
    expect(DEFAULT_FAMILY_CAP).toBeGreaterThan(0);
  });

  it('caps a family that is not in FAMILY_CAP instead of leaving it unlimited', async () => {
    const rl = new StRateLimiter(makeDOState(makeStorage()));
    for (let i = 0; i < DEFAULT_FAMILY_CAP; i++) {
      const r = await doCheck(rl, 'somethingnobodydeclared');
      expect(r.allowed).toBe(true);
    }
    const denied = await doCheck(rl, 'somethingnobodydeclared');
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfter).toBeGreaterThan(0);
  });

  it('gives the previously-undeclared real ST families an explicit cap', async () => {
    // sales / inventory / payroll / marketing / taskmanagement are real ST
    // path segments that FAMILY_CAP never declared.
    for (const family of ['sales', 'inventory', 'payroll', 'marketing', 'taskmanagement']) {
      const rl = new StRateLimiter(makeDOState(makeStorage()));
      let allowed = 0;
      for (let i = 0; i < 200; i++) {
        const r = await doCheck(rl, family);
        if (!r.allowed) break;
        allowed++;
      }
      expect(allowed).toBeLessThan(200);
      expect(allowed).toBeGreaterThan(0);
    }
  });
});

// ── 4. the aggregate cap is GLOBAL, not per-family ──────────

describe('aggregate cap', () => {
  it('trips across two DIFFERENT families (single aggregate DO instance)', async () => {
    const { ns, instances } = makeLiveLimiterNamespace();
    const env = { ST_RATE_LIMITER: ns } as any;

    // AGGREGATE_CAP is 80. crm and jpm each cap at 60, so 40 + 40 stays
    // under both per-family caps but exhausts the global budget.
    for (let i = 0; i < 40; i++) await checkRateLimit(env, 'crm');
    for (let i = 0; i < 40; i++) await checkRateLimit(env, 'jpm');

    // Every ST call routes to ONE limiter instance.
    expect(instances.size).toBe(1);

    await expect(checkRateLimit(env, 'crm')).rejects.toMatchObject({ code: 'rate_limited' });
    await expect(checkRateLimit(env, 'dispatch')).rejects.toMatchObject({ code: 'rate_limited' });
  });

  it('checkRateLimit and reportBackoff address the same DO id for every family', async () => {
    const { ns, idFromName } = makeLiveLimiterNamespace();
    const env = { ST_RATE_LIMITER: ns } as any;
    const { reportBackoff } = await import('../../rate-limit-guard');

    await checkRateLimit(env, 'crm');
    await checkRateLimit(env, 'pricebook');
    await reportBackoff(env, 'reporting', 30);

    const names = new Set((idFromName.mock.calls as any[][]).map((c) => c[0]));
    expect(names.size).toBe(1);
  });
});

// ── 5. guard-level details ──────────────────────────────────

describe('rate-limit-guard', () => {
  it('throws McpError(rate_limited) rather than a bare Error', async () => {
    const env = {
      ST_RATE_LIMITER: {
        idFromName: vi.fn(() => 'x'),
        get: vi.fn(() => ({
          fetch: vi.fn(async () =>
            new Response(JSON.stringify({ allowed: false, retryAfter: 45 }), { status: 200 })
          ),
        })),
      },
    } as any;

    const err: any = await checkRateLimit(env, 'crm').catch((e) => e);
    expect(err).toBeInstanceOf(McpError);
    expect(err.code).toBe('rate_limited');
    expect(err.retry_after_ms).toBe(45_000);
  });

  it('buckets an unmatched path into "other" rather than charging it to crm', () => {
    expect(familyFromEndpoint('/')).toBe('other');
    expect(familyFromEndpoint('no-leading-slash')).toBe('other');
    expect(familyFromEndpoint('/crm/v2/customers')).toBe('crm');
  });
});
