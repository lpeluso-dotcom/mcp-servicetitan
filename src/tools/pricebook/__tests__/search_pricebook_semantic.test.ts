import { describe, it, expect, vi, afterEach } from 'vitest';
import { search_pricebook_semantic } from '../search_pricebook_semantic';

function env(aiRun: any) {
  return { SUPABASE_URL: 'https://p.supabase.co', SUPABASE_PB_KEY: 'k', AI: { run: aiRun } } as any;
}
const ctx = { actor: 'test', correlation: 'c1' };

afterEach(() => vi.unstubAllGlobals());

describe('search_pricebook_semantic (Supabase hybrid)', () => {
  it('embeds the query and passes the vector to the hybrid RPC; shapes $0 prices', async () => {
    const aiRun = vi.fn(async () => ({ data: [[0.1, 0.2]] }));
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(
      [{ code: 'CAULK-1', name: 'Silicone', item_type: 'material', st_price: 0, match_kind: 'vector', rank: 0.9 }],
    ), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock as any);

    const out: any = await search_pricebook_semantic.handler(env(aiRun), { query: 'shower caulk', topK: 5 }, ctx);

    expect(aiRun).toHaveBeenCalledWith('@cf/baai/bge-base-en-v1.5', { text: ['shower caulk'] }, expect.objectContaining({ gateway: expect.objectContaining({ cacheTtl: 86400 }) }));  // 3rd arg: AI Gateway (Wave 2 item 5)
    const body = JSON.parse(((fetchMock.mock.calls as any[])[0][1] as any).body);
    expect(body.query_text).toBe('shower caulk');
    expect(body.query_embedding).toEqual([0.1, 0.2]);
    expect(body.limit_rows).toBe(5);
    expect(out.matches[0].st_price).toBeNull();
    expect(out.matches[0].price_basis).toBe('dynamic — computed at invoice');
    expect(out._source).toBe('supabase-hybrid');
  });

  it('falls back to lexical (query_embedding=null) when embedding fails', async () => {
    const aiRun = vi.fn(async () => { throw new Error('AI down'); });
    const fetchMock = vi.fn(async () => new Response(JSON.stringify([]), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock as any);

    await search_pricebook_semantic.handler(env(aiRun), { query: 'diagnostic fee' }, ctx);

    const body = JSON.parse(((fetchMock.mock.calls as any[])[0][1] as any).body);
    expect(body.query_embedding).toBeNull();
  });

  it('caps topK at 20', async () => {
    const aiRun = vi.fn(async () => ({ data: [[0.1]] }));
    const fetchMock = vi.fn(async () => new Response(JSON.stringify([]), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock as any);
    await search_pricebook_semantic.handler(env(aiRun), { query: 'x', topK: 999 }, ctx);
    expect(JSON.parse(((fetchMock.mock.calls as any[])[0][1] as any).body).limit_rows).toBe(20);
  });
});
