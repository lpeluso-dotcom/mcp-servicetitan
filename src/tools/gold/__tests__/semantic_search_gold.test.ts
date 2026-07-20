import { describe, it, expect, vi, afterEach } from 'vitest';
import { z } from 'zod';
import { semantic_search_gold } from '../semantic_search_gold';
import { TOOLS, toolsForRole, findTool } from '../../index';

function env(aiRun: any) {
  return { SUPABASE_URL: 'https://p.supabase.co', SUPABASE_PB_KEY: 'k', AI: { run: aiRun } } as any;
}
const ctx = { actor: 'test', correlation: 'c1' };

afterEach(() => vi.unstubAllGlobals());

describe('semantic_search_gold (Supabase vec.match_entities)', () => {
  it('embeds the query and calls vec.match_entities with ALL FIVE named params + the vec Content-Profile header', async () => {
    const aiRun = vi.fn(async () => ({ data: [[0.1, 0.2]] }));
    const fetchMock = vi.fn(async () => new Response(JSON.stringify([
      {
        entity_key: 'job', source_key: '56047989',
        content_text: 'No Heat · HVAC Install Residential · Completed',
        grain: 'job', trade_bu: 'HVAC Install Residential', similarity: 0.71,
      },
    ]), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock as any);

    const out: any = await semantic_search_gold.handler(env(aiRun), { query: 'tankless water heater install' }, ctx);

    expect(aiRun).toHaveBeenCalledWith('@cf/baai/bge-base-en-v1.5', { text: ['tankless water heater install'] });

    const [url, init] = (fetchMock.mock.calls as any[])[0];
    expect(url).toBe('https://p.supabase.co/rest/v1/rpc/match_entities');
    // vec.match_entities lives outside `public` — PostgREST needs the schema header or it 404s
    // (verified live 2026-07-18: identical call minus this header -> PGRST202).
    expect((init as any).headers['Content-Profile']).toBe('vec');

    const body = JSON.parse((init as any).body);
    // CRITICAL (#1 gotcha, verified live 2026-07-18): PostgREST resolves this function by the
    // EXACT set of provided arg names — omitting p_grain/p_trade silently drops the p_entity_key
    // filter (A/B-tested against the live RPC: identical query+filter, empty vs. correct rows,
    // the only difference being whether p_grain/p_trade were sent as explicit nulls).
    expect(Object.keys(body).sort()).toEqual(
      ['p_entity_key', 'p_grain', 'p_k', 'p_trade', 'query_embedding'].sort(),
    );
    expect(body.query_embedding).toEqual([0.1, 0.2]);
    expect(body.p_entity_key).toBeNull();
    expect(body.p_grain).toBeNull();
    expect(body.p_trade).toBeNull();
    expect(body.p_k).toBe(10);

    expect(out.matches).toHaveLength(1);
    expect(out.matches[0]).toEqual({
      entity_key: 'job', source_key: '56047989',
      content_text: 'No Heat · HVAC Install Residential · Completed',
      grain: 'job', trade_bu: 'HVAC Install Residential', similarity: 0.71,
    });
    expect(out.query).toBe('tankless water heater install');
    expect(out._source).toBe('supabase-vec-gold');
  });

  it('maps entity_key -> p_entity_key and trade -> p_trade, and still sends p_grain: null', async () => {
    const aiRun = vi.fn(async () => ({ data: [[0.1]] }));
    const fetchMock = vi.fn(async () => new Response('[]', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock as any);

    await semantic_search_gold.handler(
      env(aiRun),
      { query: 'drain cleaning', entity_key: 'pricebook', trade: 'Plumbing Service Residential', k: 5 },
      ctx,
    );

    const body = JSON.parse(((fetchMock.mock.calls as any[])[0][1] as any).body);
    expect(body.p_entity_key).toBe('pricebook');
    expect(body.p_trade).toBe('Plumbing Service Residential');
    expect(body.p_grain).toBeNull();
    expect(body.p_k).toBe(5);
  });

  it('caps k at 20 (defense-in-depth; Zod already rejects >20 at the MCP layer)', async () => {
    const aiRun = vi.fn(async () => ({ data: [[0.1]] }));
    const fetchMock = vi.fn(async () => new Response('[]', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock as any);
    await semantic_search_gold.handler(env(aiRun), { query: 'x', k: 999 }, ctx);
    expect(JSON.parse(((fetchMock.mock.calls as any[])[0][1] as any).body).p_k).toBe(20);
  });

  it('defaults k to 10 when omitted', async () => {
    const aiRun = vi.fn(async () => ({ data: [[0.1]] }));
    const fetchMock = vi.fn(async () => new Response('[]', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock as any);
    await semantic_search_gold.handler(env(aiRun), { query: 'x' }, ctx);
    expect(JSON.parse(((fetchMock.mock.calls as any[])[0][1] as any).body).p_k).toBe(10);
  });

  it('throws — no silent lexical fallback — when embedding fails; match_entities is pure-vector, unlike search_pricebook_hybrid', async () => {
    const aiRun = vi.fn(async () => { throw new Error('AI down'); });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock as any);

    await expect(semantic_search_gold.handler(env(aiRun), { query: 'x' }, ctx)).rejects.toThrow(/embedding failed/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('Zod schema requires a non-empty query', () => {
    const s = z.object(semantic_search_gold.zodSchema);
    expect(s.safeParse({}).success).toBe(false);
    expect(s.safeParse({ query: '' }).success).toBe(false);
    expect(s.safeParse({ query: 'water heater' }).success).toBe(true);
  });

  it('Zod schema rejects an entity_key outside the known gold nouns', () => {
    const s = z.object(semantic_search_gold.zodSchema);
    expect(s.safeParse({ query: 'x', entity_key: 'bogus_noun' }).success).toBe(false);
    // Original 12 nouns (shipped with the tool):
    for (const key of [
      'job', 'invoice_item', 'estimate', 'estimate_line', 'pricebook',
      'pricebook_category', 'business_unit', 'job_type', 'lead_source',
      'location', 'truck', 'membership',
    ]) {
      expect(s.safeParse({ query: 'x', entity_key: key }).success).toBe(true);
    }
    // Tier-3 nouns (shipped with qsc-vector migrations 0013-0014; 62,740 chunks embedded):
    for (const key of ['technician', 'account', 'tech_hours_week', 'labor', 'invoice']) {
      const result = s.safeParse({ query: 'x', entity_key: key });
      if (!result.success) throw new Error(`Tier-3 key "${key}" should be valid but Zod rejected it`);
    }
  });

  it('Zod schema rejects k outside 1..20', () => {
    const s = z.object(semantic_search_gold.zodSchema);
    expect(s.safeParse({ query: 'x', k: 0 }).success).toBe(false);
    expect(s.safeParse({ query: 'x', k: 21 }).success).toBe(false);
    expect(s.safeParse({ query: 'x', k: 20 }).success).toBe(true);
  });

  it('is registered in the TOOLS catalog', () => {
    expect(findTool('semantic_search_gold')).toBeDefined();
    expect(TOOLS.some((t) => t.name === 'semantic_search_gold')).toBe(true);
  });

  it('is read-only, not adminOnly, and visible to default/admin/lockdown/readonly alike (same shape as its Supabase-search siblings)', () => {
    expect(semantic_search_gold.isWrite).toBeFalsy();
    expect(semantic_search_gold.adminOnly).toBeFalsy();
    for (const role of ['default', 'admin', 'lockdown', 'readonly'] as const) {
      expect(toolsForRole(role).some((t) => t.name === 'semantic_search_gold')).toBe(true);
    }
  });
});
