import { describe, it, expect, vi, afterEach } from 'vitest';
import { get_proposal_tiers } from '../get_proposal_tiers';

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
