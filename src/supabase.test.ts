import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  EMBED_MODEL_ID, embedInputFor, embedQuery, sbRpc, sbSelect, sbWriteEmbedding, shapePriceRow,
} from './supabase';

type FetchMock = (url: string | URL, init: RequestInit & { headers: Record<string, string>; body?: string }) => Promise<Response>;

function env(overrides: Record<string, unknown> = {}) {
  return {
    SUPABASE_URL: 'https://proj.supabase.co',
    SUPABASE_PB_KEY: 'sb-key',
    AI: { run: vi.fn(async () => ({ data: [[0.1, 0.2, 0.3]] })) },
    ...overrides,
  } as any;
}

describe('supabase helpers', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('EMBED_MODEL_ID is the locked model', () => {
    expect(EMBED_MODEL_ID).toBe('@cf/baai/bge-base-en-v1.5');
  });

  it('embedInputFor matches the app projection and truncates to 1500', () => {
    expect(embedInputFor({ name: 'Capacitor', description: 'Dual run', category_name: 'HVAC' }))
      .toBe('Capacitor — Dual run — HVAC');
    expect(embedInputFor({ name: 'X', description: null, category_name: null })).toBe('X');
    expect(embedInputFor({ name: 'A'.repeat(2000) }).length).toBe(1500);
  });

  it('embedQuery returns the vector on success', async () => {
    const e = env();
    await expect(embedQuery(e, 'shower caulk')).resolves.toEqual([0.1, 0.2, 0.3]);
    expect(e.AI.run).toHaveBeenCalledWith('@cf/baai/bge-base-en-v1.5', { text: ['shower caulk'] });
  });

  it('embedQuery returns null when AI throws', async () => {
    const e = env({ AI: { run: vi.fn(async () => { throw new Error('rate limit'); }) } });
    await expect(embedQuery(e, 'x')).resolves.toBeNull();
  });

  it('sbRpc POSTs to /rest/v1/rpc/<fn> with apikey headers', async () => {
    const fetchImpl: FetchMock = async () => new Response(JSON.stringify([{ code: 'CAP-240' }]), { status: 200 });
    const fetchMock = vi.fn(fetchImpl);
    vi.stubGlobal('fetch', fetchMock);
    const out = await sbRpc(env(), 'search_pricebook_hybrid', { query_text: 'cap' });
    expect(out).toEqual([{ code: 'CAP-240' }]);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://proj.supabase.co/rest/v1/rpc/search_pricebook_hybrid');
    expect(init.method).toBe('POST');
    expect(init.headers.apikey).toBe('sb-key');
    expect(init.headers.Authorization).toBe('Bearer sb-key');
  });

  it('sbRpc throws on non-2xx', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })));
    await expect(sbRpc(env(), 'fn', {})).rejects.toThrow(/supabase rpc fn failed 500/);
  });

  it('sbRpc omits Content-Profile when no schema is given (default public-schema RPCs unaffected)', async () => {
    const fetchImpl: FetchMock = async () => new Response('[]', { status: 200 });
    const fetchMock = vi.fn(fetchImpl);
    vi.stubGlobal('fetch', fetchMock);
    await sbRpc(env(), 'search_pricebook_hybrid', { query_text: 'cap' });
    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers['Content-Profile']).toBeUndefined();
  });

  it('sbRpc sets Content-Profile to the given schema (non-public PostgREST schema selection)', async () => {
    const fetchImpl: FetchMock = async () => new Response('[]', { status: 200 });
    const fetchMock = vi.fn(fetchImpl);
    vi.stubGlobal('fetch', fetchMock);
    await sbRpc(env(), 'match_entities', { query_embedding: [0.1] }, 'vec');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://proj.supabase.co/rest/v1/rpc/match_entities');
    expect(init.headers['Content-Profile']).toBe('vec');
    // apikey/Authorization still present — schema selection is additive, not a replacement
    expect(init.headers.apikey).toBe('sb-key');
  });

  it('sbSelect GETs /rest/v1/<pathAndQuery>', async () => {
    const fetchImpl: FetchMock = async () => new Response(JSON.stringify([{ st_id: 1 }]), { status: 200 });
    const fetchMock = vi.fn(fetchImpl);
    vi.stubGlobal('fetch', fetchMock);
    const out = await sbSelect(env(), 'pricebook_items?st_id=eq.1');
    expect(out).toEqual([{ st_id: 1 }]);
    expect(fetchMock.mock.calls[0][0]).toBe('https://proj.supabase.co/rest/v1/pricebook_items?st_id=eq.1');
  });

  it('sbSelect sends Accept-Profile when a schema is given', async () => {
    const seen: Record<string, string> = {};
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      for (const [k, v] of Object.entries(init.headers as Record<string, string>)) seen[k.toLowerCase()] = v;
      return new Response(JSON.stringify([{ id: 1 }]), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const env = { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_PB_KEY: 'k' } as any;
    await sbSelect(env, 'dim_business_unit?select=*', 'gold');
    expect(seen['accept-profile']).toBe('gold');
  });

  it('sbSelect omits Accept-Profile when no schema is given (public)', async () => {
    const seen: Record<string, string> = {};
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      for (const [k, v] of Object.entries(init.headers as Record<string, string>)) seen[k.toLowerCase()] = v;
      return new Response(JSON.stringify([]), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const env = { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_PB_KEY: 'k' } as any;
    await sbSelect(env, 'pricebook_items?select=code');
    expect(seen['accept-profile']).toBeUndefined();
  });

  it('sbWriteEmbedding PATCHes by (code,item_type) with a bracketed vector literal', async () => {
    const fetchImpl: FetchMock = async () => new Response(null, { status: 204 });
    const fetchMock = vi.fn(fetchImpl);
    vi.stubGlobal('fetch', fetchMock);
    await sbWriteEmbedding(env(), 'CAP-240', 'material', [0.5, 0.6]);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://proj.supabase.co/rest/v1/pricebook_items?code=eq.CAP-240&item_type=eq.material');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body as string)).toEqual({ embedding: '[0.5,0.6]' });
  });

  it('shapePriceRow nulls zero/absent prices and tags basis dynamic', () => {
    const r = shapePriceRow({ code: 'X', st_price: 0, member_price: null });
    expect(r.st_price).toBeNull();
    expect(r.member_price).toBeNull();
    expect(r.price_basis).toBe('dynamic — computed at invoice');
  });

  it('shapePriceRow keeps a non-zero price and tags basis reference', () => {
    const r = shapePriceRow({ code: 'X', st_price: 3278.24 });
    expect(r.st_price).toBe(3278.24);
    expect(r.price_basis).toBe('reference (stored ST price)');
  });
});
