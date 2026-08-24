// ============================================================
// semantic_search_gold — post-retrieval layer (dedup / quota / floor / warnings).
//
// The handler used to return the RPC verbatim (`matches: rows ?? []`). That one
// gap produced four separate live defects, all reproduced against prod
// 2026-07-28 before this layer existed:
//
//  1. DEDUP — "condenser fan motor replacement" returned 10 rows that were all
//     the identical string "Replace OEM Condenser Fan Motor · Service". A single
//     content_text value has as many as 71 copies in the index, so the naive
//     "over-fetch k x 5" is provably insufficient.
//  2. QUOTA — invoice_item + estimate_line are 50.6% of the 348,996-chunk index
//     (132,684 + 43,725), so the line grains monopolise every unfiltered call.
//  3. FLOOR — the nonsense query "asdkjqwoeiuzxcv" returned 5 confident-looking
//     matches at similarity 0.723-0.735.
//  4. TRADE WARNING — chunks with a NULL trade_bu can never match `trade`, so
//     passing it silently excludes them. Verified live 2026-07-18: the same
//     query with trade="HVAC Service Residential" dropped the 0.886
//     estimate_line hits entirely and returned only job rows. These tools feed
//     Miss Dawn (Retell), so a silently-truncated answer can reach a customer
//     on a call.
//
//     That warning originally hardcoded the share (62.3%, 217,581 of 348,996
//     chunks). QUA-1059 + QUA-1060 re-embedded the index and the real figure
//     became 8.9% with invoice_item at 0.0%, so prod was both misstating the
//     number and giving inverted advice ("re-run without trade to search the
//     full corpus"). The figures are now derived at runtime — see
//     trade_coverage.ts and its tests.
// ============================================================
import { describe, it, expect, vi, afterEach } from 'vitest';
import { semantic_search_gold } from '../semantic_search_gold';

function env(aiRun: any) {
  return { SUPABASE_URL: 'https://p.supabase.co', SUPABASE_PB_KEY: 'k', AI: { run: aiRun } } as any;
}
const ctx = { actor: 'test', correlation: 'c1' };
const ai = () => vi.fn(async () => ({ data: [[0.1, 0.2]] }));

function rpcReturning(rows: unknown[]) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(rows), { status: 200 }));
  vi.stubGlobal('fetch', fetchMock as any);
  return fetchMock;
}

/** n copies of one content_text, as the live index really returns them. */
function dupes(n: number, text: string, entity_key = 'estimate_line', sim = 0.886) {
  return Array.from({ length: n }, (_, i) => ({
    entity_key,
    source_key: String(1000 + i),
    content_text: text,
    grain: 'line',
    trade_bu: null,
    similarity: sim - i * 0.0001,
  }));
}

afterEach(() => vi.unstubAllGlobals());

describe('semantic_search_gold post-retrieval: dedup', () => {
  it('collapses duplicate content_text into one match with an occurrence_count', async () => {
    rpcReturning(dupes(71, 'Replace OEM Condenser Fan Motor · Service'));

    const out: any = await semantic_search_gold.handler(
      env(ai()), { query: 'condenser fan motor replacement', k: 10 }, ctx,
    );

    expect(out.matches).toHaveLength(1);
    expect(out.matches[0].content_text).toBe('Replace OEM Condenser Fan Motor · Service');
    expect(out.matches[0].occurrence_count).toBe(71);
    // Keeps a bounded sample of the underlying keys rather than all 71.
    expect(out.matches[0].source_keys.length).toBeGreaterThan(0);
    expect(out.matches[0].source_keys.length).toBeLessThanOrEqual(5);
    // Best similarity of the group is the one reported.
    expect(out.matches[0].similarity).toBeCloseTo(0.886, 4);
  });

  it('over-fetches far beyond k x 5 so dedup has material to work with', async () => {
    const fetchMock = rpcReturning([]);

    await semantic_search_gold.handler(env(ai()), { query: 'x', k: 10 }, ctx);

    const body = JSON.parse((fetchMock.mock.calls as any[])[0][1].body);
    // 71 duplicates of one string were measured live, so k*5 (=50) cannot fill k=10.
    expect(body.p_k).toBeGreaterThan(10 * 5);
  });

  it('still returns distinct rows untouched', async () => {
    rpcReturning([
      { entity_key: 'job', source_key: '1', content_text: 'A', grain: 'job', trade_bu: 'HVAC', similarity: 0.90 },
      { entity_key: 'job', source_key: '2', content_text: 'B', grain: 'job', trade_bu: 'HVAC', similarity: 0.88 },
    ]);

    const out: any = await semantic_search_gold.handler(env(ai()), { query: 'x', k: 10 }, ctx);

    expect(out.matches).toHaveLength(2);
    expect(out.matches.map((m: any) => m.content_text)).toEqual(['A', 'B']);
    expect(out.matches[0].occurrence_count).toBe(1);
  });
});

describe('semantic_search_gold post-retrieval: per-entity quota', () => {
  it('stops line grains from monopolising an unfiltered search', async () => {
    // 30 distinct estimate_line chunks outrank a handful of other nouns.
    const lines = Array.from({ length: 30 }, (_, i) => ({
      entity_key: 'estimate_line', source_key: `L${i}`, content_text: `line ${i}`,
      grain: 'line', trade_bu: null, similarity: 0.89 - i * 0.0001,
    }));
    const others = [
      { entity_key: 'job', source_key: 'J1', content_text: 'job one', grain: 'job', trade_bu: 'HVAC', similarity: 0.80 },
      { entity_key: 'pricebook', source_key: 'P1', content_text: 'pb one', grain: 'dim', trade_bu: null, similarity: 0.79 },
      { entity_key: 'business_unit', source_key: 'B1', content_text: 'bu one', grain: 'dim', trade_bu: 'HVAC', similarity: 0.78 },
    ];
    rpcReturning([...lines, ...others]);

    const out: any = await semantic_search_gold.handler(env(ai()), { query: 'x', k: 10 }, ctx);

    const byEntity = out.matches.reduce((acc: any, m: any) => {
      acc[m.entity_key] = (acc[m.entity_key] ?? 0) + 1;
      return acc;
    }, {});
    expect(byEntity.estimate_line).toBeLessThan(10);
    // The lower-scoring non-line nouns must survive into the result set.
    expect(Object.keys(byEntity).length).toBeGreaterThan(1);
  });

  it('does NOT apply the quota when the caller asked for one entity explicitly', async () => {
    const lines = Array.from({ length: 30 }, (_, i) => ({
      entity_key: 'estimate_line', source_key: `L${i}`, content_text: `line ${i}`,
      grain: 'line', trade_bu: null, similarity: 0.89 - i * 0.0001,
    }));
    rpcReturning(lines);

    const out: any = await semantic_search_gold.handler(
      env(ai()), { query: 'x', entity_key: 'estimate_line', k: 10 }, ctx,
    );

    expect(out.matches).toHaveLength(10);
    expect(out.matches.every((m: any) => m.entity_key === 'estimate_line')).toBe(true);
  });
});

describe('semantic_search_gold post-retrieval: relevance floor', () => {
  it('returns no matches and says so for a nonsense query', async () => {
    // The real scores the live index returned for "asdkjqwoeiuzxcv".
    rpcReturning([
      { entity_key: 'location', source_key: '57249303', content_text: 'Awendaw · SC · 29429', grain: 'dim', trade_bu: null, similarity: 0.735240594338428 },
      { entity_key: 'location', source_key: '76792560', content_text: 'Mc Bee · SC · 29101', grain: 'dim', trade_bu: null, similarity: 0.730682691343107 },
      { entity_key: 'job', source_key: '79624937', content_text: 'sukjgjgjk · HVAC Service - No Cool Residential', grain: 'job', trade_bu: 'HVAC Service Residential', similarity: 0.723498065703992 },
    ]);

    const out: any = await semantic_search_gold.handler(env(ai()), { query: 'asdkjqwoeiuzxcv' }, ctx);

    expect(out.matches).toEqual([]);
    expect(out._warnings.join(' ')).toMatch(/no confident matches/i);
  });

  it('keeps genuinely strong matches', async () => {
    rpcReturning([
      { entity_key: 'estimate_line', source_key: '1', content_text: 'Replace OEM Condenser Fan Motor · Service', grain: 'line', trade_bu: null, similarity: 0.886 },
    ]);

    const out: any = await semantic_search_gold.handler(env(ai()), { query: 'condenser fan motor replacement' }, ctx);

    expect(out.matches).toHaveLength(1);
  });
});

describe('semantic_search_gold post-retrieval: trade warning', () => {
  const HIT = { entity_key: 'job', source_key: '19142515', content_text: 'condenser fan motor · HVAC Service Residential', grain: 'job', trade_bu: 'HVAC Service Residential', similarity: 0.827913305266409 };

  /** match_entities returns rows; the coverage probes answer with PostgREST counts. */
  function rpcPlusCoverage(nulls: Record<string, number>, totals: Record<string, number>, total: number, untagged: number) {
    const count = (n: number) => new Response('[]', {
      status: 206, headers: { 'content-range': n === 0 ? '*/0' : `0-0/${n}` },
    });
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/rpc/match_entities')) return new Response(JSON.stringify([HIT]), { status: 200 });
      if (url.includes('pii_allowlist')) {
        return new Response(JSON.stringify(Object.keys(nulls).map((entity_key) => ({ entity_key }))), { status: 200 });
      }
      const entity = /entity_key=eq\.([a-z_]+)/.exec(url)?.[1];
      const isNull = url.includes('trade_bu=is.null');
      if (entity && isNull) return count(nulls[entity] ?? 0);
      if (entity) return count(totals[entity] ?? 0);
      return count(isNull ? untagged : total);
    });
    vi.stubGlobal('fetch', fetchMock as any);
    return fetchMock;
  }

  it('reports the CURRENT untagged share, derived at runtime — not the frozen 62.3% figure', async () => {
    rpcPlusCoverage(
      { pricebook: 11043, pricebook_category: 10378, location: 5803, invoice_item: 0 },
      { pricebook: 11043, pricebook_category: 10378, location: 14479, invoice_item: 132684 },
      349036, 31203,
    );

    const out: any = await semantic_search_gold.handler(
      env(ai()), { query: 'condenser fan motor replacement', trade: 'HVAC Service Residential' }, ctx,
    );

    const warned = out._warnings.join(' ');
    expect(warned).toMatch(/trade/i);
    expect(warned).toContain('8.9%');
    // The stale hardcoded claim must be gone in every form.
    expect(warned).not.toContain('62.3');
    expect(warned).not.toContain('217,581');
    expect(warned).not.toMatch(/invoice_item[^.]*100%/);
    // At 8.9% the old blanket "go search everything instead" advice is wrong.
    expect(warned).not.toMatch(/search the full corpus/i);
    // Still returns the actual search result.
    expect(out.matches).toHaveLength(1);
  });

  it('fails SOFT — a broken coverage probe degrades the warning but never the search', async () => {
    const fetchMock = vi.fn(async (url: string) => (
      url.includes('/rpc/match_entities')
        ? new Response(JSON.stringify([HIT]), { status: 200 })
        : new Response('nope', { status: 500 })
    ));
    vi.stubGlobal('fetch', fetchMock as any);

    const out: any = await semantic_search_gold.handler(
      env(ai()), { query: 'condenser fan motor replacement', trade: 'HVAC Service Residential' }, ctx,
    );

    expect(out.matches).toHaveLength(1);
    expect(out.matches[0].content_text).toBe(HIT.content_text);
    const warned = (out._warnings ?? []).join(' ');
    expect(warned).toMatch(/trade/i);
    // Degraded means figure-free, not a guessed percentage.
    expect(warned).not.toMatch(/\d+\.\d%/);
  });

  it('does not emit a trade warning — or pay for a coverage probe — when no trade filter was passed', async () => {
    const fetchMock = rpcReturning([
      { entity_key: 'job', source_key: '1', content_text: 'A', grain: 'job', trade_bu: 'HVAC', similarity: 0.90 },
    ]);

    const out: any = await semantic_search_gold.handler(env(ai()), { query: 'x' }, ctx);

    const warned = (out._warnings ?? []).join(' ');
    expect(warned).not.toMatch(/trade/i);
    // The claim under test is that no COVERAGE probe was paid for — no count
    // over ~349k rows. The `_gold_as_of` watermark read is a separate, cheap,
    // cached single-row lookup and is expected on every call, so it is
    // excluded by name rather than by a raw call count.
    const coverageProbes = (fetchMock.mock.calls as any[])
      .map(([u]) => String(u))
      .filter((u) => u.includes('entity_chunks') || u.includes('pii_allowlist'));
    expect(coverageProbes).toHaveLength(0);
  });
});

describe('semantic_search_gold post-retrieval: preserved invariants', () => {
  it('still sends all five named RPC params and the vec Content-Profile header', async () => {
    const fetchMock = rpcReturning([]);

    await semantic_search_gold.handler(
      env(ai()), { query: 'x', entity_key: 'pricebook', trade: 'Plumbing', k: 5 }, ctx,
    );

    const [url, init] = (fetchMock.mock.calls as any[])[0];
    expect(url).toBe('https://p.supabase.co/rest/v1/rpc/match_entities');
    expect(init.headers['Content-Profile']).toBe('vec');
    const body = JSON.parse(init.body);
    expect(Object.keys(body).sort()).toEqual(
      ['p_entity_key', 'p_grain', 'p_k', 'p_trade', 'query_embedding'].sort(),
    );
    expect(body.p_entity_key).toBe('pricebook');
    expect(body.p_trade).toBe('Plumbing');
    expect(body.p_grain).toBeNull();
  });

  it('never returns more than k matches', async () => {
    rpcReturning(
      Array.from({ length: 200 }, (_, i) => ({
        entity_key: 'job', source_key: `J${i}`, content_text: `distinct ${i}`,
        grain: 'job', trade_bu: 'HVAC', similarity: 0.9 - i * 0.0001,
      })),
    );

    const out: any = await semantic_search_gold.handler(env(ai()), { query: 'x', k: 7 }, ctx);
    expect(out.matches).toHaveLength(7);
  });
});
