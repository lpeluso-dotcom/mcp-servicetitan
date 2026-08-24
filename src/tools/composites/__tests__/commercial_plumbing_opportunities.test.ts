// ============================================================
// commercial_plumbing_opportunities — wrong on three axes (Wave 2 / B).
//
//  1. INVERTED COHORT. The tool asked ST for jobs `completedBefore` the
//     cutoff, deduped by customer, and called every one of them an
//     "opportunity". It never asked whether that customer had been served
//     SINCE. Any customer with a job history at all appears — including one
//     serviced last week, whose old job still sits in the completedBefore
//     window. The claim in the description ("haven't booked in 90+ days") was
//     the exact opposite of what the code computed.
//
//  2. UNVERIFIED FILTER. `jobTypeName: 'Plumbing'` is not a parameter
//     /jpm/v2/tenant/{tid}/jobs recognises. ST does not 400 on an unknown
//     query param — it ignores it and returns HTTP 200 with an unfiltered
//     page, which is indistinguishable from a real match. That is the
//     QUA-1054 / QUA-951 defect class rejectUnsupportedSTFilters exists to
//     stop: if a filter cannot be applied server-side, FAIL LOUDLY.
//     Same for the plural `businessUnitIds`, live-verified 2026-07-09 as
//     silently ignored on this endpoint (the singular `businessUnitId` works).
//
//  3. NO COMMERCIAL FILTER, NO PAGINATION. One page of 200, no hasMore check,
//     and nothing anywhere restricting the result to commercial customers.
// ============================================================
import { describe, it, expect, vi } from 'vitest';
import { commercial_plumbing_opportunities } from '../commercial_plumbing_opportunities';

const CTX = { actor: 'vitest', correlation: 'cpo-corr' };
const DAY = 86_400_000;

interface Job {
  id: number;
  customerId: number;
  completedOn: string;
}

interface Harness {
  env: any;
  queries: URLSearchParams[];
}

/**
 * Serve the jobs endpoint from a single job list, honouring the
 * completedBefore / completedOnOrAfter window the handler asks for — so the
 * test cannot pass by accident when the handler queries only one window.
 */
function harness(jobs: Job[], opts: { pageSize?: number } = {}): Harness {
  const pageSize = opts.pageSize ?? 200;
  const queries: URLSearchParams[] = [];
  const fetcher = vi.fn(async (url: any) => {
    const u = typeof url === 'string' ? url : url.toString();
    if (!u.includes('/api/st/read')) {
      return new Response(JSON.stringify({ error: 'no route' }), { status: 500 });
    }
    const endpoint = decodeURIComponent(new URL(u).searchParams.get('endpoint') ?? '');
    const qs = new URLSearchParams(endpoint.split('?')[1] ?? '');
    queries.push(qs);

    const before = qs.get('completedBefore');
    const onOrAfter = qs.get('completedOnOrAfter');
    const matched = jobs.filter((j) => {
      const t = Date.parse(j.completedOn);
      if (before && t >= Date.parse(before)) return false;
      if (onOrAfter && t < Date.parse(onOrAfter)) return false;
      return true;
    });

    const page = Number(qs.get('page') ?? '1');
    const slice = matched.slice((page - 1) * pageSize, page * pageSize);
    return new Response(
      JSON.stringify({ data: slice, hasMore: page * pageSize < matched.length }),
      { status: 200 },
    );
  });

  return {
    env: {
      ST_PROXY: { fetch: fetcher },
      ST_RATE_LIMITER: {
        idFromName: vi.fn().mockReturnValue('rl-id'),
        get: vi.fn().mockReturnValue({
          fetch: vi.fn(async () => new Response(JSON.stringify({ allowed: true }), { status: 200 })),
        }),
      },
      ST_TENANT_ID: '000000000',
      MCP_SYNC_KEY: 'k',
      MCP_SERVICE_VERSION: '0.0.0-test',
    } as any,
    queries,
  };
}

const daysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString();

describe('commercial_plumbing_opportunities — cohort direction', () => {
  it('excludes a customer whose last job is RECENT, even though they also have an old one', async () => {
    const h = harness([
      { id: 1, customerId: 100, completedOn: daysAgo(400) }, // old job, in the window
      { id: 2, customerId: 100, completedOn: daysAgo(7) },   // ...but served last week
      { id: 3, customerId: 200, completedOn: daysAgo(400) }, // genuinely lapsed
    ]);
    const out: any = await commercial_plumbing_opportunities.handler(h.env, {}, CTX);

    expect(out.opportunities.map((o: any) => o.customerId)).toEqual([200]);
  });

  it('reports the customer\'s most recent qualifying job, not the first row ST returned', async () => {
    const h = harness([
      { id: 1, customerId: 200, completedOn: daysAgo(800) },
      { id: 2, customerId: 200, completedOn: daysAgo(300) },
    ]);
    const out: any = await commercial_plumbing_opportunities.handler(h.env, {}, CTX);

    expect(out.opportunities).toHaveLength(1);
    expect(out.opportunities[0].lastJobId).toBe(2);
    expect(out.opportunities[0].daysSinceLastJob).toBeGreaterThanOrEqual(299);
    expect(out.opportunities[0].daysSinceLastJob).toBeLessThanOrEqual(301);
  });

  it('queries BOTH windows — the recent window is what makes the exclusion possible', async () => {
    const h = harness([{ id: 1, customerId: 200, completedOn: daysAgo(400) }]);
    await commercial_plumbing_opportunities.handler(h.env, {}, CTX);

    expect(h.queries.some((q) => q.get('completedBefore'))).toBe(true);
    expect(h.queries.some((q) => q.get('completedOnOrAfter'))).toBe(true);
  });

  it('honours lookbackDays when deciding what counts as recent', async () => {
    const jobs = [
      { id: 1, customerId: 100, completedOn: daysAgo(200) },
      { id: 2, customerId: 200, completedOn: daysAgo(400) },
    ];

    // 90-day default: neither customer has been served inside the window, so
    // both are lapsed.
    const short: any = await commercial_plumbing_opportunities.handler(harness(jobs).env, {}, CTX);
    expect(short.opportunities.map((o: any) => o.customerId).sort()).toEqual([100, 200]);

    // 365-day lookback: customer 100's 200-day-old job now falls INSIDE the
    // window, so they are no longer an opportunity.
    const long: any = await commercial_plumbing_opportunities.handler(
      harness(jobs).env,
      { lookbackDays: 365 },
      CTX,
    );
    expect(long.opportunities.map((o: any) => o.customerId)).toEqual([200]);
  });
});

describe('commercial_plumbing_opportunities — unsupported ST filters', () => {
  it('rejects jobTypeName rather than sending a param ST silently discards', async () => {
    const h = harness([]);
    await expect(
      commercial_plumbing_opportunities.handler(h.env, { jobTypeName: 'Plumbing' } as any, CTX),
    ).rejects.toThrow(/does not support filtering by/i);
  });

  it('rejects customerType for the same reason', async () => {
    const h = harness([]);
    await expect(
      commercial_plumbing_opportunities.handler(h.env, { customerType: 'Commercial' } as any, CTX),
    ).rejects.toThrow(/does not support filtering by/i);
  });

  it('never puts jobTypeName on the wire itself', async () => {
    const h = harness([{ id: 1, customerId: 200, completedOn: daysAgo(400) }]);
    await commercial_plumbing_opportunities.handler(h.env, {}, CTX);

    for (const q of h.queries) expect(q.get('jobTypeName')).toBeNull();
  });

  it('uses the singular businessUnitId — the plural form is silently ignored here', async () => {
    const h = harness([{ id: 1, customerId: 200, completedOn: daysAgo(400) }]);
    await commercial_plumbing_opportunities.handler(h.env, { businessUnitId: 42 }, CTX);

    expect(h.queries.every((q) => q.get('businessUnitId') === '42')).toBe(true);
    expect(h.queries.every((q) => q.get('businessUnitIds') === null)).toBe(true);
  });
});

describe('commercial_plumbing_opportunities — scope honesty', () => {
  it('states in the payload that the result is NOT restricted to commercial plumbing', async () => {
    const h = harness([{ id: 1, customerId: 200, completedOn: daysAgo(400) }]);
    const out: any = await commercial_plumbing_opportunities.handler(h.env, {}, CTX);

    expect(String(out._scope ?? '')).toMatch(/all job types/i);
    expect(String(out._scope ?? '')).toMatch(/residential/i);
  });

  it('states it in the tool description too', () => {
    expect(commercial_plumbing_opportunities.description).toMatch(/all job types/i);
  });
});

describe('commercial_plumbing_opportunities — pagination', () => {
  it('drains past the first page instead of returning the oldest 200 jobs', async () => {
    const jobs = Array.from({ length: 12 }, (_, i) => ({
      id: i + 1,
      customerId: i + 1,
      completedOn: daysAgo(400 + i),
    }));
    const h = harness(jobs, { pageSize: 5 });
    const out: any = await commercial_plumbing_opportunities.handler(h.env, {}, CTX);

    expect(out.opportunities).toHaveLength(12);
    expect(out._truncated).toBe(false);
    expect(out.pageCount).toBeGreaterThan(1);
  });

  it('warns loudly when the RECENT window is truncated — exclusions are then incomplete', async () => {
    // 25 pages of recent jobs at pageSize 1 blows past pagedStRead's 20-page
    // cap, so some recently-served customers cannot be excluded.
    const jobs = [
      { id: 1, customerId: 1, completedOn: daysAgo(400) },
      ...Array.from({ length: 25 }, (_, i) => ({
        id: 100 + i,
        customerId: 500 + i,
        completedOn: daysAgo(i + 1),
      })),
    ];
    const h = harness(jobs, { pageSize: 1 });
    const out: any = await commercial_plumbing_opportunities.handler(h.env, {}, CTX);

    expect(out._truncated).toBe(true);
    expect(String(out._warnings ?? [])).toMatch(/recent/i);
  });
});
