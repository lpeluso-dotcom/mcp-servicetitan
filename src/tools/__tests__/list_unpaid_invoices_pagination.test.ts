// ============================================================
// list_unpaid_invoices — the all-paid-first-page defect (QUA-1108, Urgent).
//
// ST's /accounting/v2/.../invoices silently ignores `balanceExcludeZero`, so the
// tool filters balance !== 0 CLIENT-side. But page/pageSize were being sent to
// ST and applied SERVER-side against the UNFILTERED set. Consequence: if ST's
// page 1 happened to be entirely paid invoices, the tool returned a bare `[]`
// while unpaid invoices sat on page 2 — indistinguishable from "nothing is
// outstanding".
//
// This is Jessica's A/R tool and JESSICA-CONNECTOR-RUNBOOK.md actively coaches
// her toward it, which is what makes it Urgent rather than a nit: the failure
// mode is a confident, plausible, wrong "you're all caught up". Before this
// change the only trace of the problem was a source comment at
// list_unpaid_invoices.ts:44 describing it as a known limitation.
//
// The fix drains ST pages until the requested window of FILTERED rows is filled
// (or the source is exhausted, or a page budget is hit), and discloses which of
// those three happened. The first test below is the exact fixture the audit
// asked for: page 1 all-paid, page 2 unpaid.
// ============================================================
import { describe, it, expect, vi } from 'vitest';
import { list_unpaid_invoices } from '../invoicing/list_unpaid_invoices';

const CTX = { actor: 'vitest', correlation: 'test-corr' };

function makeDB() {
  const stmt = {
    bind: vi.fn().mockReturnThis(),
    run: vi.fn().mockResolvedValue({ success: true }),
    first: vi.fn().mockResolvedValue(null), // cache always misses
  };
  return { prepare: vi.fn().mockReturnValue(stmt) };
}

function makeEnv(fetchImpl: (url: string) => Promise<Response>): any {
  return {
    ST_PROXY: { fetch: vi.fn((url: string) => fetchImpl(url)) },
    MCP_SYNC_KEY: 'test-key',
    MCP_SERVICE_VERSION: '0.0.0-test',
    DB: makeDB(),
    PROXY_STATE: {},
    SIRO_API_TOKEN: '',
  };
}

/** The real ST path+query rides double-encoded in the proxy's `endpoint` param. */
function pageFromUrl(url: string): number {
  const endpoint = new URL(url).searchParams.get('endpoint') ?? '';
  const qs = endpoint.split('?')[1] ?? '';
  return Number(new URLSearchParams(qs).get('page') ?? '1');
}

function inv(id: number, balance: number) {
  return { id, balance, total: 500 };
}

/** Serve `pages` keyed by page number; `hasMore` derived from what remains. */
function serve(pages: Record<number, unknown[]>) {
  const last = Math.max(...Object.keys(pages).map(Number));
  return async (url: string) => {
    const page = pageFromUrl(url);
    const data = pages[page] ?? [];
    return new Response(JSON.stringify({ data, hasMore: page < last }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
}

describe('list_unpaid_invoices pagination (QUA-1108)', () => {
  it('does NOT return a bare [] when page 1 is all-paid and page 2 has unpaid rows', async () => {
    const env = makeEnv(serve({
      1: [inv(1, 0), inv(2, 0), inv(3, 0)],       // every invoice paid
      2: [inv(4, 250.5), inv(5, 100)],            // the ones Jessica needs
    }));

    const out: any = await list_unpaid_invoices.handler(env, { pageSize: 10 }, CTX);

    expect(out.invoices.length).toBeGreaterThan(0);
    expect(out.invoices.map((i: any) => i.id).sort()).toEqual([4, 5]);
  });

  it('keeps draining across several all-paid pages', async () => {
    const env = makeEnv(serve({
      1: [inv(1, 0)], 2: [inv(2, 0)], 3: [inv(3, 0)], 4: [inv(4, 0)],
      5: [inv(5, 42)],
    }));

    const out: any = await list_unpaid_invoices.handler(env, { pageSize: 10 }, CTX);

    expect(out.invoices.map((i: any) => i.id)).toEqual([5]);
  });

  it('reports an honest empty result when the source really is all paid', async () => {
    const env = makeEnv(serve({ 1: [inv(1, 0), inv(2, 0)] }));

    const out: any = await list_unpaid_invoices.handler(env, { pageSize: 10 }, CTX);

    expect(out.invoices).toEqual([]);
    // Exhausted the source — this empty is trustworthy, and says so.
    expect(out._scan_complete).toBe(true);
  });

  it('distinguishes "nothing unpaid" from "gave up looking"', async () => {
    // Every page paid, more pages than the budget allows. The tool must NOT
    // present this as a clean all-caught-up.
    const pages: Record<number, unknown[]> = {};
    for (let p = 1; p <= 60; p++) pages[p] = [inv(p, 0)];
    const env = makeEnv(serve(pages));

    const out: any = await list_unpaid_invoices.handler(env, { pageSize: 10 }, CTX);

    expect(out.invoices).toEqual([]);
    expect(out._scan_complete).toBe(false);
    expect(String(out._warning ?? '')).toMatch(/page budget|incomplete|not exhaustive/i);
  });

  it('stops early once the requested window is filled', async () => {
    const pages: Record<number, unknown[]> = {};
    for (let p = 1; p <= 40; p++) pages[p] = [inv(p, 99)]; // all unpaid
    const env = makeEnv(serve(pages));

    const out: any = await list_unpaid_invoices.handler(env, { pageSize: 3 }, CTX);

    expect(out.invoices).toHaveLength(3);
    // Must not have walked all 40 pages to answer a 3-row request.
    expect(env.ST_PROXY.fetch.mock.calls.length).toBeLessThan(10);
  });

  it('keeps a malformed balance visible rather than silently hiding the row', async () => {
    const env = makeEnv(serve({ 1: [{ id: 7, balance: 'not-a-number' }, inv(8, 0)] }));

    const out: any = await list_unpaid_invoices.handler(env, { pageSize: 10 }, CTX);

    expect(out.invoices.map((i: any) => i.id)).toEqual([7]);
  });

  it('honours the page argument against the FILTERED set, not ST pages', async () => {
    const env = makeEnv(serve({
      1: [inv(1, 10), inv(2, 0), inv(3, 20)],
      2: [inv(4, 0), inv(5, 30)],
    }));

    // Filtered order is [1, 3, 5]; page 2 at pageSize 2 is the tail.
    const out: any = await list_unpaid_invoices.handler(env, { page: 2, pageSize: 2 }, CTX);

    expect(out.invoices.map((i: any) => i.id)).toEqual([5]);
  });
});
