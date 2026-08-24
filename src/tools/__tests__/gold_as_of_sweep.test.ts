// ============================================================
// gold_as_of_sweep.test.ts — every Supabase-backed tool discloses data age.
//
// Before this, ALL NINE published nothing: a grep for
// `as_of|_gold_as_of|measured_at|synced_at|updated_at` across them returned
// zero hits, and a QSC analytical answer reached the owner's inbox with a
// wrong headline because the age of the warehouse was invisible at write-up
// time. The sweep is deliberately a SWEEP rather than nine per-tool
// assertions: the failure mode is a tenth tool shipping without the stamp,
// and only a list that has to be edited catches that.
// ============================================================
import { describe, it, expect, vi, afterEach } from 'vitest';
import { gold_margin_by_bu } from '../gold/gold_margin_by_bu';
import { semantic_search_gold } from '../gold/semantic_search_gold';
import { titan_advisor_score } from '../gold/titan_advisor_score';
import { get_proposal_tiers } from '../pricebook/get_proposal_tiers';
import { get_service_breakout } from '../pricebook/get_service_breakout';
import { find_packages_with_item } from '../pricebook/find_packages_with_item';
import { search_pricebook_templates } from '../pricebook/search_pricebook_templates';
import { search_pricebook_semantic } from '../pricebook/search_pricebook_semantic';
import { measureTradeCoverage } from '../gold/trade_coverage';
import { GOLD_STALE_THRESHOLD_HOURS } from '../../gold-watermark';
import { DEFAULT_EXCLUDED_FIELDS, defaultShaper } from '../../response-shape';

const ctx = { actor: 'test', correlation: 'c1' } as any;

const NOW = Date.now();
const BUILT_AT = new Date(NOW - 3 * 3_600_000).toISOString();
const LONG_AGO = new Date(NOW - (GOLD_STALE_THRESHOLD_HOURS + 10) * 3_600_000).toISOString();

/** Always-miss D1 stub, so each call probes for real and the routing is exercised. */
const missingCacheDb = () => ({
  prepare: () => ({ bind: () => ({ first: async () => null, run: async () => ({}) }) }),
});

function env(overrides: Record<string, unknown> = {}) {
  return {
    SUPABASE_URL: 'https://p.supabase.co',
    SUPABASE_PB_KEY: 'k',
    DB: missingCacheDb(),
    AI: { run: vi.fn(async () => ({ data: [[0.1, 0.2, 0.3]] })) },
    ...overrides,
  } as any;
}

/**
 * Routes every request these tools make. `watermarkAt` drives BOTH watermark
 * probe shapes (vec.refresh_state rows and the `?select=synced_at` max reads);
 * `payload` answers everything else.
 */
function stubAll(payload: unknown, watermarkAt: string | null = BUILT_AT) {
  const f = vi.fn(async (url: string) => {
    if (url.includes('refresh_state')) {
      return new Response(JSON.stringify(watermarkAt === null ? [] : [
        { key: 'gold_build_complete_at', value: watermarkAt, updated_at: watermarkAt },
        { key: 'taylor_jobs_synced_at', value: '2026-08-24 05:00:00', updated_at: watermarkAt },
      ]), { status: 200 });
    }
    if (url.includes('select=synced_at')) {
      return new Response(JSON.stringify(watermarkAt === null ? [] : [{ synced_at: watermarkAt }]), { status: 200 });
    }
    return new Response(JSON.stringify(payload), { status: 200 });
  });
  vi.stubGlobal('fetch', f as any);
  return f;
}

afterEach(() => vi.unstubAllGlobals());

/** name -> a call that exercises the tool's handler against `stubAll`. */
const TOOLS: Array<{ name: string; payload: unknown; run: (e: any) => Promise<any> }> = [
  {
    name: 'gold_margin_by_bu',
    payload: [{ business_unit_id: 10, revenue_cents: 1, cost_cents: 0, gp_cents: 1, gp_pct: 100, job_count: 1 }],
    run: (e) => gold_margin_by_bu.handler(e, { from: '2026-06-01', to: '2026-06-30' }, ctx),
  },
  {
    name: 'semantic_search_gold',
    payload: [{ entity_key: 'job', source_key: 'j1', content_text: 'condenser fan motor', grain: 'job', trade_bu: 'HVAC', similarity: 0.9 }],
    run: (e) => semantic_search_gold.handler(e, { query: 'condenser fan motor', k: 5 }, ctx),
  },
  {
    name: 'titan_advisor_score',
    payload: [{ snapshot_date: '2026-08-23', earned: 300, available: 476, pct: 63, feature_count: 131, checkpoint_count: 8 }],
    run: (e) => titan_advisor_score.handler(e, { from: '2026-08-01', to: '2026-08-23' }, ctx),
  },
  {
    name: 'get_proposal_tiers',
    payload: [{ template_id: 10, name: 'Good', tier_rank: 1, tier_label: 'Good', item_count: 3, total_price_ref: 1200 }],
    run: (e) => get_proposal_tiers.handler(e, { proposalId: 42 }, ctx),
  },
  {
    name: 'get_service_breakout',
    payload: [{ st_id: 1, code: 'SVC-1', name: 'Tune-Up', item_type: 'service' }],
    run: (e) => get_service_breakout.handler(e, { code: 'SVC-1' }, ctx),
  },
  {
    name: 'find_packages_with_item',
    payload: [{ st_id: 1, code: 'CAP-240', name: 'Capacitor' }],
    run: (e) => find_packages_with_item.handler(e, { code: 'CAP-240' }, ctx),
  },
  {
    name: 'search_pricebook_templates',
    payload: [{ kind: 'template', id: 5, name: 'HVAC Tune-Up', item_count: 4, total_price_ref: 0, rank: 0.8 }],
    run: (e) => search_pricebook_templates.handler(e, { query: 'tune up' }, ctx),
  },
  {
    name: 'search_pricebook_semantic',
    payload: [{ code: 'CAP-240', name: 'Capacitor', match_kind: 'vector' }],
    run: (e) => search_pricebook_semantic.handler(e, { query: 'capacitor' }, ctx),
  },
];

describe('every Supabase-backed tool publishes _gold_as_of', () => {
  for (const t of TOOLS) {
    it(`${t.name} stamps the build time`, async () => {
      stubAll(t.payload);
      const out = await t.run(env());
      expect(out).toHaveProperty('_gold_as_of');
      expect(out._gold_as_of).toBe(BUILT_AT);
      expect(out._gold_freshness).toBe('fresh');
      expect(out._gold_watermark_source).toBeTruthy();
    });

    it(`${t.name} warns loudly when the build is stale`, async () => {
      stubAll(t.payload, LONG_AGO);
      const out = await t.run(env());
      expect(out._gold_freshness).toBe('stale');
      expect(out._gold_warning).toMatch(/STALE/);
    });

    it(`${t.name} says unknown — not "now" — when there is no watermark`, async () => {
      stubAll(t.payload, null);
      const out = await t.run(env());
      expect(out._gold_as_of).toBeNull();
      expect(out._gold_freshness).toBe('unknown');
    });

    it(`${t.name} still returns its data when the watermark probe dies`, async () => {
      // Fail-soft is the whole contract: a disclosure that can break the tool
      // it rides on gets deleted the first time it does.
      const f = vi.fn(async (url: string) => {
        if (url.includes('refresh_state') || url.includes('select=synced_at')) {
          return new Response('boom', { status: 400 });
        }
        return new Response(JSON.stringify(t.payload), { status: 200 });
      });
      vi.stubGlobal('fetch', f as any);
      const out = await t.run(env());
      expect(out._gold_freshness).toBe('unknown');
      expect(out._gold_warning).toBeTruthy();
    });
  }
});

describe('the watermark is the BUILD time, not the call time', () => {
  it('_gold_as_of never equals "now" — that is the trap trade_coverage.measured_at sets', async () => {
    stubAll(TOOLS[0].payload);
    const before = new Date().toISOString();
    const out = await TOOLS[0].run(env());
    const after = new Date().toISOString();
    expect(out._gold_as_of).toBe(BUILT_AT);
    expect(out._gold_as_of >= before && out._gold_as_of <= after).toBe(false);
    expect(out._gold_age_hours).toBeGreaterThan(2.5);
  });

  it('trade_coverage carries the index build time ALONGSIDE its own measured_at', async () => {
    // measured_at is when the coverage probe ran (always "now" — correct for
    // what it is). It is NOT a data-age watermark, so the payload has to carry
    // a real one next to it or the warning reads as if the index were seconds old.
    const f = vi.fn(async (url: string) => {
      if (url.includes('refresh_state')) {
        return new Response(JSON.stringify([
          { key: 'gold_build_complete_at', value: BUILT_AT, updated_at: BUILT_AT },
          { key: 'taylor_jobs_synced_at', value: 'x', updated_at: BUILT_AT },
        ]), { status: 200 });
      }
      if (url.includes('pii_allowlist')) return new Response(JSON.stringify([{ entity_key: 'job' }]), { status: 200 });
      return new Response('[]', { status: 206, headers: { 'content-range': '0-0/100' } });
    });
    vi.stubGlobal('fetch', f as any);
    const cov = await measureTradeCoverage(env());
    expect(cov.gold_as_of).toBe(BUILT_AT);
    expect(cov.measured_at).not.toBe(cov.gold_as_of);
  });
});

describe('titan_advisor_score publishes the snapshot date it already had in hand', () => {
  it('reports the newest snapshot_date separately from the build time', async () => {
    // It orders `snap_titan_advisor_daily` by snapshot_date.desc, so the newest
    // DATA date is free. It answers a different question from the build time —
    // "how current is the data" vs "did the pipeline run" — and both were
    // invisible. Naming them apart is the same fix mirror-freshness made when
    // it split _rows_synced_hours out of _stale_hours.
    stubAll([
      { snapshot_date: '2026-08-23', earned: 300, available: 476, pct: 63, feature_count: 131, checkpoint_count: 8 },
      { snapshot_date: '2026-08-20', earned: 295, available: 476, pct: 62, feature_count: 131, checkpoint_count: 8 },
    ]);
    const out: any = await titan_advisor_score.handler(env(), { from: '2026-08-01', to: '2026-08-23' }, ctx);
    expect(out._gold_rows_as_of).toBe('2026-08-23');
    expect(out._gold_as_of).toBe(BUILT_AT);
  });

  it('_gold_rows_as_of is null when the window returned no snapshots', async () => {
    stubAll([]);
    const out: any = await titan_advisor_score.handler(env(), { from: '2026-08-01', to: '2026-08-23' }, ctx);
    expect(out._gold_rows_as_of).toBeNull();
  });
});

describe('the stamp survives the response shaper', () => {
  // `_gold_as_of` is an underscore-prefixed key sitting one line away from
  // `_links` and `_meta` in every response the shaper walks. Those two ARE
  // stripped, so the plausible future regression is someone tidying this one
  // into the same list — which would silently delete the disclosure while
  // every other test kept passing.
  it('_gold_* keys are not in DEFAULT_EXCLUDED_FIELDS', () => {
    for (const k of ['_gold_as_of', '_gold_age_hours', '_gold_freshness', '_gold_watermark_source', '_gold_warning']) {
      expect(DEFAULT_EXCLUDED_FIELDS.has(k)).toBe(false);
    }
  });

  it('defaultShaper passes the stamp through on a real tool response', async () => {
    stubAll(TOOLS[0].payload);
    const out = await TOOLS[0].run(env());
    const shaped: any = defaultShaper(out);
    expect(shaped._gold_as_of).toBe(BUILT_AT);
    expect(shaped._gold_freshness).toBe('fresh');
    // …while the ST noise it exists to strip still goes.
    expect(defaultShaper({ _meta: { a: 1 }, keep: 2 } as any)).not.toHaveProperty('_meta');
  });
});
