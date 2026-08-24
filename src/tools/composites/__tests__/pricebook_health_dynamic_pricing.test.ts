// ============================================================
// pricebook_health_check_services — dynamic pricing is not a defect
// (Wave 2 / B).
//
// The tool did:
//     const zeroCost = services.filter((s) => (s.cost ?? 0) === 0);
//     healthy: zeroCost.length === 0 && noCategory.length === 0
//
// QSC runs ServiceTitan Pricebook Pro / dynamic pricing. A 0, null or absent
// `cost`/`price` on a service does NOT mean the item is unpriced or free —
// the number is computed at invoice time from rules, business unit,
// membership tier and labor. So the criterion above declares a correctly
// configured dynamic-priced pricebook UNHEALTHY, and hands Luke a
// "zeroCostServices" list of items that are working exactly as designed.
//
// The repo already encodes the right rule one file over — supabase.ts's
// shapePriceRow maps 0/null/'0' to null and tags it
// `price_basis: 'dynamic — computed at invoice'`. This tool contradicted it.
//
// Genuine defects on a service ARE checkable: a missing category breaks
// reporting and GL mapping regardless of how the price is computed.
// ============================================================
import { describe, it, expect, vi } from 'vitest';
import { pricebook_health_check_services } from '../pricebook_health_check_services';

const CTX = { actor: 'vitest', correlation: 'pb-corr' };

function harness(services: unknown[], hasMore = false) {
  const fetcher = vi.fn(async (url: any) => {
    const u = typeof url === 'string' ? url : url.toString();
    if (u.includes('/api/st/read')) {
      const endpoint = decodeURIComponent(new URL(u).searchParams.get('endpoint') ?? '');
      const page = Number(new URLSearchParams(endpoint.split('?')[1] ?? '').get('page') ?? '1');
      return new Response(
        JSON.stringify({ data: page === 1 ? services : [], hasMore: page === 1 ? hasMore : false }),
        { status: 200 },
      );
    }
    return new Response(JSON.stringify({ error: 'no route' }), { status: 500 });
  });
  return {
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
  } as any;
}

const CATEGORY = { id: 7, name: 'Plumbing' };

describe('pricebook_health_check_services — dynamic pricing', () => {
  it('does not flag a zero-cost service as unhealthy', async () => {
    const env = harness([{ id: 1, name: 'Drain clear', cost: 0, category: CATEGORY }]);
    const out: any = await pricebook_health_check_services.handler(env, {}, CTX);

    expect(out.summary.healthy).toBe(true);
  });

  it('does not flag a null- or absent-cost service as unhealthy either', async () => {
    const env = harness([
      { id: 1, name: 'Null cost', cost: null, category: CATEGORY },
      { id: 2, name: 'No cost key', category: CATEGORY },
    ]);
    const out: any = await pricebook_health_check_services.handler(env, {}, CTX);

    expect(out.summary.healthy).toBe(true);
  });

  it('never labels those services "zero cost" — the price is dynamic, not missing', async () => {
    const env = harness([{ id: 1, name: 'Drain clear', cost: 0, category: CATEGORY }]);
    const out: any = await pricebook_health_check_services.handler(env, {}, CTX);

    expect(out.zeroCostServices).toBeUndefined();
    expect(out.summary.zeroCostCount).toBeUndefined();
    expect(JSON.stringify(out)).not.toMatch(/zeroCost/);
  });

  it('reports them as informational dynamic-priced items, and says why', async () => {
    const env = harness([
      { id: 1, name: 'Drain clear', cost: 0, category: CATEGORY },
      { id: 2, name: 'Priced', cost: 42, category: CATEGORY },
    ]);
    const out: any = await pricebook_health_check_services.handler(env, {}, CTX);

    expect(out.summary.dynamicPricedCount).toBe(1);
    expect(String(out._note ?? '')).toMatch(/dynamic/i);
  });

  it('still fails health on a genuine defect — a service with no category', async () => {
    const env = harness([{ id: 1, name: 'Orphan', cost: 0 }]);
    const out: any = await pricebook_health_check_services.handler(env, {}, CTX);

    expect(out.summary.noCategoryCount).toBe(1);
    expect(out.summary.healthy).toBe(false);
  });
});

describe('pricebook_health_check_services — population honesty', () => {
  it('does not present one page as the whole pricebook', async () => {
    // ST says there are more pages; the verdict covers only what was read.
    const env = harness([{ id: 1, name: 'A', cost: 0, category: CATEGORY }], true);
    const out: any = await pricebook_health_check_services.handler(env, {}, CTX);

    expect(out.summary.total).toBe(1);
    expect(out._truncated).toBe(false); // drained: page 2 came back empty
    expect(out.pageCount).toBe(2);
  });

  it('labels `total` as the population actually examined', async () => {
    const env = harness([{ id: 1, name: 'A', cost: 0, category: CATEGORY }]);
    const out: any = await pricebook_health_check_services.handler(env, {}, CTX);

    expect(out.summary.total).toBe(1);
    expect(out.summary.populationComplete).toBe(true);
  });
});
