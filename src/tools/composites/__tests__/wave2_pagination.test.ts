// ============================================================
// wave2_pagination.test.ts — the five single-page composites (Wave 2 / B).
//
// Each of these tools issued ONE `readST` with `pageSize: 100|200` and then
// presented what came back as the whole answer:
//
//   dispatch_override_audit         appointments in a date range
//   call_quality_review             calls in a date range
//   membership_jackpot_leaderboard  YTD contest entrants -> a LEADERBOARD
//   membership_outreach_list        an outreach CALL LIST
//   pricebook_health_check_services a health verdict over "total" services
//
// None checked `hasMore`; none emitted `truncated`. So the 201st membership
// sold in the Jackpot Drive silently did not count, the 201st expiring member
// silently never got called, and `summary.total` was the size of a page
// rather than the size of the pricebook. A number that is quietly a page is
// worse than no number — it is wrong in a way that looks right.
//
// Every one now drains via pagedStRead and discloses `pageCount` +
// `_truncated`. These tests are the gate: with ST reporting more pages, the
// tool must say so.
// ============================================================
import { describe, it, expect, vi } from 'vitest';

import { dispatch_override_audit } from '../dispatch_override_audit';
import { call_quality_review } from '../call_quality_review';
import { membership_jackpot_leaderboard } from '../membership_jackpot_leaderboard';
import { membership_outreach_list } from '../membership_outreach_list';
import { pricebook_health_check_services } from '../pricebook_health_check_services';
import { fetchMirrorTableMax, readMirror } from '../../../mirror-pg';

vi.mock('../../../mirror-pg', () => ({
  readMirror: vi.fn(),
  fetchMirrorTableMax: vi.fn(),
}));

const CTX = { actor: 'vitest', correlation: 'wave2-corr' };

/** pagedStRead's default page cap — the point at which it must set truncated. */
const MAX_PAGES = 20;

interface Harness {
  env: any;
  stCalls: string[];
}

/**
 * ST_PROXY mock that serves paginated /api/st/read pages. The dispatch audit's
 * Supabase mirror join is stubbed separately below.
 * `pageFor` receives the 1-based page number parsed out of the encoded
 * ST endpoint and returns the raw page body.
 */
function harness(pageFor: (page: number) => { data: unknown[]; hasMore?: boolean }): Harness {
  const stCalls: string[] = [];
  const fetcher = vi.fn(async (url: any) => {
    const u = typeof url === 'string' ? url : url.toString();
    if (u.includes('/api/st/read')) {
      stCalls.push(u);
      const endpoint = decodeURIComponent(new URL(u).searchParams.get('endpoint') ?? '');
      const page = Number(new URLSearchParams(endpoint.split('?')[1] ?? '').get('page') ?? '1');
      return new Response(JSON.stringify(pageFor(page)), { status: 200 });
    }
    return new Response(JSON.stringify({ error: 'no route' }), { status: 500 });
  });

  const rateLimiter = {
    idFromName: vi.fn().mockReturnValue('rl-id'),
    get: vi.fn().mockReturnValue({
      fetch: vi.fn(async () => new Response(JSON.stringify({ allowed: true }), { status: 200 })),
    }),
  };
  vi.mocked(readMirror).mockResolvedValue([]);
  vi.mocked(fetchMirrorTableMax).mockResolvedValue({ appointment_assignments: new Date().toISOString() });

  return {
    env: {
      ST_PROXY: { fetch: fetcher },
      ST_RATE_LIMITER: rateLimiter,
      ST_TENANT_ID: '000000000',
      MCP_SYNC_KEY: 'test-key',
      MCP_SERVICE_VERSION: '0.0.0-test',
    } as any,
    stCalls,
  };
}

const item = (n: number) => ({
  id: n,
  jobId: n,
  soldById: n,
  customerId: n,
  cost: 1,
  category: { id: 1 },
});

/** ST always claims another page — the shape that used to be invisible. */
const alwaysMore = (page: number) => ({ data: [item(page)], hasMore: true });

/** ST is done after one page. */
const oneAndDone = () => ({ data: [item(1)], hasMore: false });

/**
 * Each entry: how to invoke the tool, and where its item count lives.
 * Kept table-driven so a new single-page composite is one row, not a new file.
 */
const CASES: Array<{
  name: string;
  run: (env: any) => Promise<any>;
  countOf: (out: any) => number;
}> = [
  {
    name: 'dispatch_override_audit',
    run: (env) =>
      dispatch_override_audit.handler(env, { from: '2026-01-01', to: '2026-08-01' }, CTX) as any,
    countOf: (o) => o.appointments.length,
  },
  {
    name: 'call_quality_review',
    run: (env) =>
      call_quality_review.handler(env, { from: '2026-01-01', to: '2026-08-01' }, CTX) as any,
    countOf: (o) => o.reviews.length,
  },
  {
    name: 'membership_jackpot_leaderboard',
    run: (env) => membership_jackpot_leaderboard.handler(env, { limit: 50 }, CTX) as any,
    countOf: (o) => o.entrantCount,
  },
  {
    name: 'membership_outreach_list',
    run: (env) => membership_outreach_list.handler(env, { segment: 'expiring_30' }, CTX) as any,
    countOf: (o) => o.contacts.length,
  },
  {
    name: 'pricebook_health_check_services',
    run: (env) => pricebook_health_check_services.handler(env, {}, CTX) as any,
    countOf: (o) => o.summary.total,
  },
];

describe.each(CASES)('$name pagination (Wave 2 / B)', ({ run, countOf }) => {
  it('reports truncated: true when ServiceTitan still has more pages', async () => {
    const h = harness(alwaysMore);
    const out = await run(h.env);

    expect(out._truncated).toBe(true);
    expect(out.pageCount).toBe(MAX_PAGES);
    // The gate: it drained past page 1 instead of presenting one page as all.
    expect(countOf(out)).toBe(MAX_PAGES);
    expect(h.stCalls.length).toBeGreaterThanOrEqual(MAX_PAGES);
    expect(String(out._warnings ?? [])).toMatch(/truncated/);
  });

  it('does not claim truncation when one page was the whole answer', async () => {
    const h = harness(oneAndDone);
    const out = await run(h.env);

    expect(out._truncated).toBe(false);
    expect(out.pageCount).toBe(1);
    expect(countOf(out)).toBe(1);
  });

  it('walks pages with an incrementing page param rather than refetching page 1', async () => {
    const h = harness((page) => ({ data: [item(page)], hasMore: page < 3 }));
    const out = await run(h.env);

    expect(out.pageCount).toBe(3);
    const pages = h.stCalls.map((u) => {
      const endpoint = decodeURIComponent(new URL(u).searchParams.get('endpoint') ?? '');
      return new URLSearchParams(endpoint.split('?')[1] ?? '').get('page');
    });
    expect(pages.slice(0, 3)).toEqual(['1', '2', '3']);
  });
});
