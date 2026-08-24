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
import {
  StRateLimiter,
  DEFAULT_FAMILY_CAP,
  AGGREGATE_CAP,
  AGGREGATE_WINDOW_MS,
  ST_DOCUMENTED_CALLS_PER_SECOND,
  IDENTITY_WINDOW_MS,
  capForFamily,
} from '../../durable/st-rate-limiter';
import { MAX_PACE_WAIT_MS, MAX_PACE_ATTEMPTS, _setPacingSleep } from '../../rate-limit-guard';
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

async function doCheck(rl: StRateLimiter, family: string, identity?: string) {
  const req = new Request('https://do/check', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(identity === undefined ? { family } : { family, identity }),
  });
  return rl
    .fetch(req)
    .then((r) => r.json<{ allowed: boolean; retryAfter?: number; reason?: string }>());
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

    // Split the aggregate budget across two families, keeping each side under
    // its own per-family fairness cap so ONLY the aggregate can deny the next
    // call.
    const half = Math.floor(AGGREGATE_CAP / 2);
    const rest = AGGREGATE_CAP - half;
    expect(half).toBeLessThan(DEFAULT_FAMILY_CAP);
    expect(rest).toBeLessThan(DEFAULT_FAMILY_CAP);

    for (let i = 0; i < half; i++) await checkRateLimit(env, 'crm');
    for (let i = 0; i < rest; i++) await checkRateLimit(env, 'jpm');

    // Every ST call routes to ONE limiter instance.
    expect(instances.size).toBe(1);

    // Read that instance's verdict directly rather than through
    // checkRateLimit: the guard PACES a sub-second budget denial (see the
    // pacing tests below), which would refill the window and hide the very
    // thing this test exists to prove.
    const rl = instances.values().next().value as StRateLimiter;
    // A THIRD family, untouched so far — under the old per-family DO ids its
    // instance would have been empty and this would be allowed.
    const verdict = await doCheck(rl, 'dispatch');
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toBe('aggregate');
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

// ── 4b. the aggregate is shaped like ST's REAL limit ────────
//
// ServiceTitan documents 60 calls per SECOND per application per tenant for
// regular APIs. A 60-second aggregate window is the wrong shape for a
// per-second limit: it either throttles a burst that is comfortably legal, or
// waves through 3,600 calls inside one second.

describe('aggregate window shape and headroom', () => {
  it('measures the aggregate over a ~1s window, not a minute', () => {
    expect(AGGREGATE_WINDOW_MS).toBeLessThanOrEqual(1_000);
  });

  it("leaves real headroom under ST's documented 60/s even at a window boundary", () => {
    expect(ST_DOCUMENTED_CALLS_PER_SECOND).toBe(60);
    // Worst case for a fixed window: a full budget at the end of one window
    // and another full budget at the start of the next, inside ~1 second.
    expect(AGGREGATE_CAP * 2).toBeLessThan(ST_DOCUMENTED_CALLS_PER_SECOND);
    // ...and we must NOT budget the whole tenant quota for this worker —
    // taylor-ai and other callers share it.
    expect(AGGREGATE_CAP).toBeLessThanOrEqual(ST_DOCUMENTED_CALLS_PER_SECOND / 2);
  });

  it('is no longer ~45x stricter than ST — sustained ceiling is well above the old 80/min', () => {
    const sustainedPerMinute = AGGREGATE_CAP * (60_000 / AGGREGATE_WINDOW_MS);
    expect(sustainedPerMinute).toBeGreaterThanOrEqual(1_000);
  });

  it('refills after the window elapses instead of locking out for a minute', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-08-24T12:00:00.000Z'));
      const rl = new StRateLimiter(makeDOState(makeStorage()));

      // Spread across families so the per-family fairness cap never fires.
      for (let i = 0; i < AGGREGATE_CAP; i++) {
        const r = await doCheck(rl, i % 2 === 0 ? 'crm' : 'jpm');
        expect(r.allowed).toBe(true);
      }
      expect((await doCheck(rl, 'crm')).allowed).toBe(false);

      vi.setSystemTime(new Date(Date.now() + AGGREGATE_WINDOW_MS + 1));
      expect((await doCheck(rl, 'crm')).allowed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── 4c. reporting carries no invented volume cap ────────────
//
// ST documents NO per-family volume limit. The reporting constraint it does
// document is "1 of the same report per minute per tenant" — an identity
// rule, not a bucket. `reporting: 20/min` modelled a limit that never existed.

describe('reporting family', () => {
  it('gets the same fairness cap as every other family — no special number', () => {
    expect(capForFamily('reporting')).toBe(DEFAULT_FAMILY_CAP);
    for (const f of ['crm', 'jpm', 'pricebook', 'accounting', 'sales', 'whatever']) {
      expect(capForFamily(f)).toBe(DEFAULT_FAMILY_CAP);
    }
  });
});

// ── 4d. same-report-within-60s (ST's real reporting limit) ──

describe('same-report identity limit', () => {
  it('exposes a 60s identity window', () => {
    expect(IDENTITY_WINDOW_MS).toBe(60_000);
  });

  it('rejects the SAME identity inside the window with an accurate retryAfter', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-08-24T12:00:00.000Z'));
      const rl = new StRateLimiter(makeDOState(makeStorage()));

      expect((await doCheck(rl, 'reporting', 'report:7:params-a')).allowed).toBe(true);

      vi.setSystemTime(new Date(Date.now() + 20_000));
      const again = await doCheck(rl, 'reporting', 'report:7:params-a');
      expect(again.allowed).toBe(false);
      expect(again.reason).toBe('same_report_within_window');
      expect(again.retryAfter).toBe(40);
    } finally {
      vi.useRealTimers();
    }
  });

  it('allows a DIFFERENT identity immediately', async () => {
    const rl = new StRateLimiter(makeDOState(makeStorage()));
    expect((await doCheck(rl, 'reporting', 'report:7:params-a')).allowed).toBe(true);
    expect((await doCheck(rl, 'reporting', 'report:7:params-b')).allowed).toBe(true);
    expect((await doCheck(rl, 'reporting', 'report:8:params-a')).allowed).toBe(true);
  });

  it('allows the same identity again once the window has passed', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-08-24T12:00:00.000Z'));
      const rl = new StRateLimiter(makeDOState(makeStorage()));
      expect((await doCheck(rl, 'reporting', 'r')).allowed).toBe(true);
      vi.setSystemTime(new Date(Date.now() + IDENTITY_WINDOW_MS + 1));
      expect((await doCheck(rl, 'reporting', 'r')).allowed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does NOT spend aggregate or family budget on an identity rejection', async () => {
    const storage = makeStorage();
    const rl = new StRateLimiter(makeDOState(storage));

    await doCheck(rl, 'reporting', 'r');
    const afterFirst = (storage.map.get('ratelimit') as any).aggregateCount;
    await doCheck(rl, 'reporting', 'r'); // rejected
    await doCheck(rl, 'reporting', 'r'); // rejected
    expect((storage.map.get('ratelimit') as any).aggregateCount).toBe(afterFirst);
  });

  it('surfaces the identity rejection through checkRateLimit as rate_limited', async () => {
    const { ns } = makeLiveLimiterNamespace();
    const env = { ST_RATE_LIMITER: ns } as any;

    await checkRateLimit(env, 'reporting', { identity: 'report:7' });
    const err: any = await checkRateLimit(env, 'reporting', { identity: 'report:7' }).catch((e) => e);
    expect(err).toBeInstanceOf(McpError);
    expect(err.code).toBe('rate_limited');
    expect(err.retry_after_ms).toBeGreaterThan(0);
    expect(err.message).toMatch(/same report/i);
  });

  it('does not track identities for ordinary non-report calls', async () => {
    const storage = makeStorage();
    const rl = new StRateLimiter(makeDOState(storage));
    for (let i = 0; i < 5; i++) expect((await doCheck(rl, 'crm')).allowed).toBe(true);
    const stored: any = storage.map.get('ratelimit');
    expect(stored.identities ?? []).toHaveLength(0);
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

// ── 6. bounded pacing on sub-second budget denials ──────────
//
// The aggregate window is ~1s, so a burst that overshoots refills almost
// immediately. Throwing at the caller would turn an extra second into a hard
// failure — `get_configurable_equipment_children` fans out up to 25 parallel
// readST calls, which is a legitimate bounded operation that must not fail
// just because it exceeds a one-second budget.

function pacingLimiter(replies: Array<{ allowed: boolean; retryAfterMs?: number; retryAfter?: number; reason?: string }>) {
  let i = 0;
  const doFetch = vi.fn(async (url: string): Promise<Response> => {
    if (!url.endsWith('/check')) return new Response('{}', { status: 200 });
    const reply = replies[Math.min(i, replies.length - 1)];
    i++;
    return new Response(JSON.stringify(reply), { status: 200 });
  });
  return {
    doFetch,
    ns: { idFromName: vi.fn((n: string) => n), get: vi.fn(() => ({ fetch: doFetch })) } as any,
    checks: () => (doFetch.mock.calls as any[][]).filter((c) => String(c[0]).endsWith('/check')).length,
  };
}

describe('bounded pacing', () => {
  it('exposes its bounds so the worst-case added latency is auditable', () => {
    expect(MAX_PACE_WAIT_MS).toBeGreaterThan(0);
    expect(MAX_PACE_WAIT_MS).toBeLessThanOrEqual(2_000);
    expect(MAX_PACE_ATTEMPTS).toBeGreaterThanOrEqual(1);
    expect(MAX_PACE_ATTEMPTS).toBeLessThanOrEqual(5);
  });

  it('waits out a SHORT budget denial instead of failing the caller', async () => {
    const limiter = pacingLimiter([
      { allowed: false, retryAfterMs: 5, retryAfter: 1, reason: 'aggregate' },
      { allowed: true },
    ]);
    const env = { ST_RATE_LIMITER: limiter.ns } as any;

    await expect(checkRateLimit(env, 'crm')).resolves.toBeUndefined();
    expect(limiter.checks()).toBe(2);
  });

  it('gives up after MAX_PACE_ATTEMPTS rather than waiting forever', async () => {
    const limiter = pacingLimiter([
      { allowed: false, retryAfterMs: 2, retryAfter: 1, reason: 'family' },
    ]);
    const env = { ST_RATE_LIMITER: limiter.ns } as any;

    await expect(checkRateLimit(env, 'crm')).rejects.toMatchObject({ code: 'rate_limited' });
    // one initial check + MAX_PACE_ATTEMPTS retries
    expect(limiter.checks()).toBe(1 + MAX_PACE_ATTEMPTS);
  });

  it('does NOT wait when the refill is far away — fails fast instead', async () => {
    const limiter = pacingLimiter([
      { allowed: false, retryAfterMs: 45_000, retryAfter: 45, reason: 'aggregate' },
      { allowed: true },
    ]);
    const env = { ST_RATE_LIMITER: limiter.ns } as any;

    const started = Date.now();
    await expect(checkRateLimit(env, 'crm')).rejects.toMatchObject({
      code: 'rate_limited',
      retry_after_ms: 45_000,
    });
    expect(limiter.checks()).toBe(1);
    expect(Date.now() - started).toBeLessThan(MAX_PACE_WAIT_MS);
  });

  it('NEVER paces a same-report rejection, even a short one', async () => {
    // Waiting out ST's one-per-minute report rule would hold a request open
    // for up to a minute. Fail fast and let the caller use the cache.
    const limiter = pacingLimiter([
      { allowed: false, retryAfterMs: 5, retryAfter: 1, reason: 'same_report_within_window' },
      { allowed: true },
    ]);
    const env = { ST_RATE_LIMITER: limiter.ns } as any;

    await expect(checkRateLimit(env, 'reporting', { identity: 'r' })).rejects.toMatchObject({
      code: 'rate_limited',
    });
    expect(limiter.checks()).toBe(1);
  });

  it('lets a 25-wide parallel burst through instead of failing part of it', async () => {
    // The get_configurable_equipment_children shape: one bounded fan-out,
    // wider than the per-second budget, all on one family. Driven against a
    // virtual clock — the pacing loop is real, the seconds are not.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-24T12:00:00.000Z'));
    const restore = _setPacingSleep(async (ms: number) => {
      vi.setSystemTime(new Date(Date.now() + ms));
    });
    try {
      const { ns } = makeLiveLimiterNamespace();
      const env = { ST_RATE_LIMITER: ns } as any;

      const results = await Promise.allSettled(
        Array.from({ length: 25 }, () => checkRateLimit(env, 'pricebook')),
      );
      expect(results.filter((r) => r.status === 'rejected')).toHaveLength(0);
    } finally {
      _setPacingSleep(restore);
      vi.useRealTimers();
    }
  });
});
