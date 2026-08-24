import { describe, it, expect, vi, afterEach } from 'vitest';
import { search_pricebook_templates } from '../search_pricebook_templates';

const env = { SUPABASE_URL: 'https://p.supabase.co', SUPABASE_PB_KEY: 'k' } as any;
const ctx = { actor: 'test', correlation: 'c1' };
afterEach(() => vi.unstubAllGlobals());

describe('search_pricebook_templates', () => {
  it('calls search_templates and shapes total_price_ref', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(
      [{ kind: 'template', id: 5, name: 'HVAC Tune-Up', item_count: 4, total_price_ref: 0, rank: 0.8 }],
    ), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock as any);
    const out: any = await search_pricebook_templates.handler(env, { query: 'tune up', limit: 6 }, ctx);
    const [url, init] = (fetchMock.mock.calls as any[])[0];
    expect(url).toBe('https://p.supabase.co/rest/v1/rpc/search_templates');
    expect(JSON.parse((init as any).body)).toEqual({ query_text: 'tune up', limit_rows: 6 });
    expect(out.results[0].total_price_ref).toBeNull();
    expect(out.results[0].price_basis).toBe('dynamic — computed at invoice');
  });

  it('caps limit at 25 and defaults to 12', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify([]), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock as any);
    // Select the search_templates POSTs by URL rather than by call index: the
    // `_gold_as_of` watermark probe also fetches (a GET against the template
    // mirror), so positional indexing no longer identifies the RPC.
    const limits = () => (fetchMock.mock.calls as any[])
      .filter(([u]) => String(u).includes('/rpc/search_templates'))
      .map(([, init]) => JSON.parse(String((init as any).body)).limit_rows);

    await search_pricebook_templates.handler(env, { query: 'x', limit: 999 }, ctx);
    expect(limits()).toEqual([25]);
    await search_pricebook_templates.handler(env, { query: 'x' }, ctx);
    expect(limits()).toEqual([25, 12]);
  });
});
