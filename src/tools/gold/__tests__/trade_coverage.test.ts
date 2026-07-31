// ============================================================
// trade_coverage — runtime derivation of vec.entity_chunks trade_bu coverage.
//
// Why this module exists: the `trade_filter_excludes_untagged` warning used to
// hardcode "62.3% of the index (217,581 of 348,996 chunks)". Two re-embeds
// later (QUA-1059 gold widening, QUA-1060 chunk-template enrichment) the real
// figure was 8.9% and invoice_item had gone from 100% untagged to 0% — so the
// warning was actively lying to callers, and its "re-run without trade to
// search the full corpus" advice had become wrong. A frozen number in a
// warning about a table that gets rebuilt nightly is a defect by construction.
// These tests pin the behaviours that stop it recurring.
// ============================================================
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  measureTradeCoverage,
  getTradeCoverage,
  buildTradeWarning,
  COVERAGE_TTL_SEC,
  type TradeCoverage,
} from '../trade_coverage';

function env(extra: Record<string, unknown> = {}) {
  return { SUPABASE_URL: 'https://p.supabase.co', SUPABASE_PB_KEY: 'k', ...extra } as any;
}

/** A D1 stub that always misses, so cacheGet falls through to the live miss(). */
function missingCacheDb() {
  return {
    prepare: () => ({
      bind: () => ({ first: async () => null, run: async () => ({}) }),
    }),
  };
}

/** PostgREST returns the exact count in `content-range` as `<range>/<total>`. */
function countResponse(total: number) {
  return new Response('[]', {
    status: 206,
    headers: { 'content-range': total === 0 ? `*/0` : `0-0/${total}` },
  });
}

/**
 * Routes the live shape of the coverage probe: one count over the whole table,
 * one over the NULL-trade_bu subset, the noun registry, then per-noun counts.
 * `nulls`/`totals` are keyed by entity_key.
 */
function stubCoverageFetch(opts: {
  total: number;
  untagged: number;
  nouns: string[];
  nulls: Record<string, number>;
  totals?: Record<string, number>;
  fail?: (url: string) => boolean;
}) {
  const fetchMock = vi.fn(async (url: string) => {
    if (opts.fail?.(url)) return new Response('boom', { status: 500 });

    if (url.includes('pii_allowlist')) {
      return new Response(JSON.stringify(opts.nouns.map((entity_key) => ({ entity_key }))), { status: 200 });
    }
    const entity = /entity_key=eq\.([a-z_]+)/.exec(url)?.[1];
    const isNullFilter = url.includes('trade_bu=is.null');

    if (entity && isNullFilter) return countResponse(opts.nulls[entity] ?? 0);
    if (entity) return countResponse(opts.totals?.[entity] ?? 0);
    if (isNullFilter) return countResponse(opts.untagged);
    return countResponse(opts.total);
  });
  vi.stubGlobal('fetch', fetchMock as any);
  return fetchMock;
}

/** The live shape measured against nlaaliehqpgskjmiuzze on 2026-07-28. */
const LIVE: TradeCoverage = {
  measured_at: '2026-07-28T04:00:00.000Z',
  total_chunks: 349036,
  untagged_chunks: 31203,
  untagged_share: 31203 / 349036,
  discovered_noun_count: 22,
  fully_tagged_noun_count: 10,
  other_untagged_chunks: 325,
  nouns: [
    { entity_key: 'pricebook', untagged_chunks: 11043, total_chunks: 11043, untagged_share: 1, by_design: true },
    { entity_key: 'pricebook_category', untagged_chunks: 10378, total_chunks: 10378, untagged_share: 1, by_design: true },
    { entity_key: 'location', untagged_chunks: 5803, total_chunks: 14479, untagged_share: 5803 / 14479, by_design: false },
    { entity_key: 'estimate_line', untagged_chunks: 1590, total_chunks: 43725, untagged_share: 1590 / 43725, by_design: false },
    { entity_key: 'estimate', untagged_chunks: 658, total_chunks: 16724, untagged_share: 658 / 16724, by_design: false },
  ],
};

afterEach(() => vi.unstubAllGlobals());

describe('measureTradeCoverage — derives the figures instead of hardcoding them', () => {
  it('reports the live share from counts, not a frozen constant', async () => {
    stubCoverageFetch({
      total: 349036,
      untagged: 31203,
      nouns: ['job', 'invoice_item', 'pricebook', 'pricebook_category', 'location', 'estimate_line', 'membership'],
      nulls: { pricebook: 11043, pricebook_category: 10378, location: 5803, estimate_line: 1590, membership: 25 },
      totals: { pricebook: 11043, pricebook_category: 10378, location: 14479, estimate_line: 43725, membership: 2948 },
    });

    const c = await measureTradeCoverage(env());

    expect(c.total_chunks).toBe(349036);
    expect(c.untagged_chunks).toBe(31203);
    expect(c.untagged_share).toBeCloseTo(0.0894, 4);
    expect(c.measured_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('names only the nouns that are untagged NOW — a noun at 0 untagged is never named', async () => {
    stubCoverageFetch({
      total: 349036,
      untagged: 31203,
      nouns: ['job', 'invoice_item', 'pricebook', 'pricebook_category', 'location'],
      // invoice_item was 100% untagged before QUA-1060 and is 0% after.
      nulls: { pricebook: 11043, pricebook_category: 10378, location: 5803, invoice_item: 0, job: 0 },
      totals: { pricebook: 11043, pricebook_category: 10378, location: 14479 },
    });

    const c = await measureTradeCoverage(env());
    const named = c.nouns.map((n) => n.entity_key);

    expect(named).toContain('location');
    expect(named).not.toContain('invoice_item');
    expect(named).not.toContain('job');
    expect(c.fully_tagged_noun_count).toBe(2);
  });

  it('discovers the noun list from the DB rather than a hardcoded array', async () => {
    const fetchMock = stubCoverageFetch({
      total: 100, untagged: 10,
      nouns: ['brand_new_noun'],
      nulls: { brand_new_noun: 10 },
      totals: { brand_new_noun: 40 },
    });

    const c = await measureTradeCoverage(env());

    expect(fetchMock.mock.calls.some(([u]: any[]) => String(u).includes('pii_allowlist'))).toBe(true);
    expect(c.nouns.map((n) => n.entity_key)).toEqual(['brand_new_noun']);
  });

  it('accounts for untagged chunks in nouns the registry did not list', async () => {
    stubCoverageFetch({
      total: 349036,
      untagged: 31203,
      nouns: ['pricebook', 'pricebook_category', 'location'],
      nulls: { pricebook: 11043, pricebook_category: 10378, location: 5803 },
      totals: { pricebook: 11043, pricebook_category: 10378, location: 14479 },
    });

    const c = await measureTradeCoverage(env());
    expect(c.other_untagged_chunks).toBe(31203 - 11043 - 10378 - 5803);
  });

  it('classifies pricebook + pricebook_category as untagged BY DESIGN, not as a gap', async () => {
    stubCoverageFetch({
      total: 349036, untagged: 31203,
      nouns: ['pricebook', 'pricebook_category', 'location'],
      nulls: { pricebook: 11043, pricebook_category: 10378, location: 5803 },
      totals: { pricebook: 11043, pricebook_category: 10378, location: 14479 },
    });

    const c = await measureTradeCoverage(env());
    const byKey = Object.fromEntries(c.nouns.map((n) => [n.entity_key, n.by_design]));
    expect(byKey.pricebook).toBe(true);
    expect(byKey.pricebook_category).toBe(true);
    expect(byKey.location).toBe(false);
  });
});

describe('getTradeCoverage — cheap and fail-soft', () => {
  it('serves a cached measurement without re-counting', async () => {
    const cached: TradeCoverage = { ...LIVE };
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock as any);
    const db = {
      prepare: () => ({
        bind: () => ({
          first: async () => ({ value: JSON.stringify(cached), expires_at: Date.now() + 60_000 }),
          run: async () => ({}),
        }),
      }),
    };

    const c = await getTradeCoverage(env({ DB: db }));

    expect(c?.untagged_chunks).toBe(31203);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('is cached for hours, not per-call — a count over ~349k rows per search is unacceptable', () => {
    expect(COVERAGE_TTL_SEC).toBeGreaterThanOrEqual(3600);
  });

  it('returns null instead of throwing when a count request fails', async () => {
    stubCoverageFetch({
      total: 349036, untagged: 31203, nouns: ['pricebook'], nulls: { pricebook: 11043 },
      fail: (u) => u.includes('trade_bu=is.null') && !u.includes('entity_key'),
    });

    await expect(getTradeCoverage(env({ DB: missingCacheDb() }))).resolves.toBeNull();
  });

  it('returns null instead of throwing when there is no D1 binding at all', async () => {
    stubCoverageFetch({ total: 0, untagged: 0, nouns: [], nulls: {}, fail: () => true });
    await expect(getTradeCoverage(env())).resolves.toBeNull();
  });
});

describe('buildTradeWarning — proportionate, derived wording', () => {
  it('reports the real current share and never the stale 62.3% figure', () => {
    const w = buildTradeWarning(LIVE, 'HVAC Service Residential')!;
    expect(w).toContain('8.9%');
    expect(w).toContain('31,203');
    expect(w).toContain('349,036');
    expect(w).not.toContain('62.3');
    expect(w).not.toContain('217,581');
  });

  it('splits untagged-by-design from untagged-as-a-gap', () => {
    const w = buildTradeWarning(LIVE, 'HVAC Service Residential')!;
    expect(w).toMatch(/by design/i);
    expect(w).toMatch(/pricebook/);
    expect(w).toMatch(/gap/i);
    expect(w).toMatch(/location/);
  });

  it('drops the "re-run without trade to search the full corpus" advice at a low untagged share', () => {
    const w = buildTradeWarning(LIVE, 'HVAC Service Residential')!;
    expect(w).not.toMatch(/search the full corpus/i);
  });

  it('keeps that advice when the untagged share really is most of the index', () => {
    const stale: TradeCoverage = {
      ...LIVE,
      total_chunks: 348996,
      untagged_chunks: 217581,
      untagged_share: 217581 / 348996,
    };
    const w = buildTradeWarning(stale, 'HVAC Service Residential')!;
    expect(w).toContain('62.3%');
    expect(w).toMatch(/search the full corpus/i);
  });

  it('emits nothing when there is no material untagged content', () => {
    const clean: TradeCoverage = {
      measured_at: '2026-07-28T04:00:00.000Z',
      total_chunks: 349036,
      untagged_chunks: 120,
      untagged_share: 120 / 349036,
      discovered_noun_count: 22,
      fully_tagged_noun_count: 21,
      other_untagged_chunks: 0,
      nouns: [{ entity_key: 'membership', untagged_chunks: 120, total_chunks: 2948, untagged_share: 120 / 2948, by_design: false }],
    };
    expect(buildTradeWarning(clean, 'HVAC Service Residential')).toBeNull();
  });

  it('degrades to a figure-free note rather than inventing numbers when coverage is unavailable', () => {
    const w = buildTradeWarning(null, 'HVAC Service Residential')!;
    expect(w).toMatch(/trade/i);
    expect(w).not.toMatch(/\d+\.\d%/);
  });

  it('states the staleness window so a reader knows the figures are a cached measurement', () => {
    const w = buildTradeWarning(LIVE, 'HVAC Service Residential')!;
    expect(w).toContain('2026-07-28T04:00:00.000Z');
  });

  it('names a bounded head of nouns and rolls the long tail into one clause', () => {
    // The live index has 17 nouns with at least one untagged chunk. Listing all
    // of them turned the warning into an unreadable wall a caller will skip.
    const tail = ['account', 'job_type', 'soron_reference', 'labor', 'soron_benchmark',
      'technician', 'lead_source', 'membership', 'soron_labor_stat', 'soron_weather_signal', 'soron_local_event'];
    const tailChunks = [353, 264, 199, 118, 110, 76, 32, 25, 7, 7, 2];
    const wide: TradeCoverage = {
      ...LIVE,
      other_untagged_chunks: 0,
      nouns: [
        ...LIVE.nouns,
        { entity_key: 'tech_hours_week', untagged_chunks: 538, total_chunks: 538, untagged_share: 1, by_design: false },
        ...tail.map((entity_key, i) => ({
          entity_key, untagged_chunks: tailChunks[i], total_chunks: null, untagged_share: null, by_design: false,
        })),
      ],
    };

    const w = buildTradeWarning(wide, 'HVAC Service Residential')!;

    expect(w).toContain('location');           // in the head
    expect(w).toContain('tech_hours_week');    // last of the head
    expect(w).not.toContain('soron_local_event'); // in the tail — rolled up, not named
    expect(w).not.toContain('membership');
    // The rolled-up clause carries the tail's real weight, not a bare noun count.
    expect(w).toContain(String(tailChunks.reduce((a, b) => a + b, 0).toLocaleString('en-US')));
    expect(w).toContain('11');
    // ...and never claims a nonsense "0 chunks across N nouns".
    expect(w).not.toMatch(/Plus 0 /);
  });

  it('frames safety by corpus share, not by noun count — most nouns can be small', () => {
    const w = buildTradeWarning(LIVE, 'HVAC Service Residential')!;
    // 91.1% of chunks ARE tagged; "5 of 22 nouns are fully tagged" says the opposite.
    expect(w).toContain('91.1%');
  });
});
