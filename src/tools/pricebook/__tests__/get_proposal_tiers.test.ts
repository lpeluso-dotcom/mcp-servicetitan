import { describe, it, expect, vi, afterEach } from 'vitest';
import { get_proposal_tiers, TIERS_TTL_SEC } from '../get_proposal_tiers';

/** D1 stub with a real in-memory mcp_cache, so cacheGet actually caches. */
function realCacheDb() {
  const store = new Map<string, { value: string; expires_at: number }>();
  return {
    prepare: (sql: string) => ({
      bind: (...args: unknown[]) => ({
        first: async () => (sql.includes('SELECT') ? store.get(`${args[0]}|${args[1]}`) ?? null : null),
        run: async () => {
          if (sql.includes('INSERT')) {
            store.set(`${args[0]}|${args[1]}`, { value: args[2] as string, expires_at: args[3] as number });
          }
          return {};
        },
      }),
    }),
  };
}

/** The tool's own RPC calls, excluding the `_gold_as_of` watermark probe. */
const rpcCalls = (f: { mock: { calls: unknown[] } }) =>
  (f.mock.calls as any[]).map(([u]) => String(u)).filter((u) => u.includes('/rpc/get_proposal_tiers'));

const env = { SUPABASE_URL: 'https://p.supabase.co', SUPABASE_PB_KEY: 'k' } as any;
const ctx = { actor: 'test', correlation: 'c1' };
afterEach(() => vi.unstubAllGlobals());

describe('get_proposal_tiers', () => {
  it('passes pid and shapes tier prices', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify([
      { template_id: 10, name: 'Good', tier_rank: 1, tier_label: 'Good', item_count: 3, total_price_ref: 1200 },
      { template_id: 11, name: 'Best', tier_rank: 3, tier_label: 'Best', item_count: 6, total_price_ref: 0 },
    ]), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const out: any = await get_proposal_tiers.handler(env, { proposalId: 42 }, ctx);
    const call = fetchMock.mock.calls[0] as any;
    expect(call).toBeDefined();
    const [url, init] = call;
    expect(url).toBe('https://p.supabase.co/rest/v1/rpc/get_proposal_tiers');
    expect(JSON.parse((init.body as string) ?? '')).toEqual({ pid: 42 });
    expect(out.tiers[0].total_price_ref).toBe(1200);
    expect(out.tiers[0].price_basis).toBe('reference (stored ST price)');
    expect(out.tiers[1].total_price_ref).toBeNull();
    expect(out.tiers[1].price_basis).toBe('dynamic — computed at invoice');
  });
});

// This was the one Supabase RPC in the repo with no cache at all, while the
// data behind it moves once a night.
describe('get_proposal_tiers caching', () => {
  const tiers = [{ template_id: 10, name: 'Good', tier_rank: 1, tier_label: 'Good', item_count: 3, total_price_ref: 1200 }];
  const stub = () => {
    const f = vi.fn(async (u: string) =>
      new Response(JSON.stringify(u.includes('select=synced_at') ? [{ synced_at: new Date().toISOString() }] : tiers),
        { status: 200 }));
    vi.stubGlobal('fetch', f as any);
    return f;
  };

  it('serves a repeat call for the same proposal from the cache', async () => {
    const f = stub();
    const e = { ...env, DB: realCacheDb() } as any;
    const a: any = await get_proposal_tiers.handler(e, { proposalId: 42 }, ctx);
    const b: any = await get_proposal_tiers.handler(e, { proposalId: 42 }, ctx);
    expect(b.tiers).toEqual(a.tiers);
    expect(rpcCalls(f)).toHaveLength(1);
  });

  it('keys on the proposal id — one ladder is never served for another', async () => {
    const f = stub();
    const e = { ...env, DB: realCacheDb() } as any;
    await get_proposal_tiers.handler(e, { proposalId: 42 }, ctx);
    await get_proposal_tiers.handler(e, { proposalId: 43 }, ctx);
    expect(rpcCalls(f)).toHaveLength(2);
  });

  it('the TTL is short enough to pick up a same-day template edit', () => {
    expect(TIERS_TTL_SEC).toBeGreaterThan(0);
    expect(TIERS_TTL_SEC).toBeLessThanOrEqual(3600);
  });

  it('a dead cache degrades to a live RPC rather than an error', async () => {
    const f = stub();
    const broken = { prepare: () => { throw new Error('D1 down'); } };
    const out: any = await get_proposal_tiers.handler({ ...env, DB: broken } as any, { proposalId: 42 }, ctx);
    expect(out.tiers).toHaveLength(1);
    expect(rpcCalls(f)).toHaveLength(1);
  });
});
