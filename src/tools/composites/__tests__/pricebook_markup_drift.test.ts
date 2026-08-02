// ============================================================
// pricebook_markup_drift — tests
//
// Mocks readD1 directly (vi.mock('../../../d1')) so we can assert on the
// exact SQL/params sent, independent of the servicetitan-proxy transport.
// The handler issues up to four queries per call (markup UNION, the
// fetchTableMax probe, equipment cost/no-price, placeholder COUNT) — the
// mock routes by SQL shape rather than call order.
// ============================================================
import { describe, it, expect, vi, beforeEach } from 'vitest';

const readD1Mock = vi.fn();
vi.mock('../../../d1', () => ({
  readD1: (...args: unknown[]) => readD1Mock(...args),
}));

import { pricebook_markup_drift } from '../pricebook_markup_drift';

const CTX = { actor: 'test', correlation: 'c1' };

function makeEnv(): any {
  return { ST_PROXY: { fetch: vi.fn() }, MCP_SYNC_KEY: 'k' };
}

const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

interface WireOpts {
  markup?: Array<Record<string, unknown>>;
  equipNoPrice?: Array<Record<string, unknown>>;
  placeholders?: Array<Record<string, unknown>>;
  tableMax?: { pb_materials?: string | null; pb_equipment?: string | null; pb_categories?: string | null };
}

/** Route all four query shapes; tableMax defaults to fresh (1h) per table. */
function wire(opts: WireOpts = {}) {
  readD1Mock.mockImplementation(async (_e: unknown, sql: string) => {
    if (/ AS t,/.test(sql)) {
      return {
        rows: [
          { t: 'pb_materials', m: opts.tableMax?.pb_materials !== undefined ? opts.tableMax.pb_materials : hoursAgo(1) },
          { t: 'pb_equipment', m: opts.tableMax?.pb_equipment !== undefined ? opts.tableMax.pb_equipment : hoursAgo(1) },
          { t: 'pb_categories', m: opts.tableMax?.pb_categories !== undefined ? opts.tableMax.pb_categories : hoursAgo(1) },
        ],
      };
    }
    if (/COUNT\(\*\)/.test(sql)) return { rows: opts.placeholders ?? [{ cnt: 0, synced_at: null }] };
    if (/price\s*=\s*0/.test(sql)) return { rows: opts.equipNoPrice ?? [] };
    return { rows: opts.markup ?? [] };
  });
}

/** The non-probe calls — what the pre-redesign tests reasoned about. */
function dataCalls() {
  return readD1Mock.mock.calls.filter(([, sql]) => !/ AS t,/.test(sql as string));
}

beforeEach(() => {
  readD1Mock.mockReset();
});

describe('pricebook_markup_drift', () => {
  it('issues a SELECT-only query scoped to pb_materials + pb_equipment only (no pb_services)', async () => {
    wire();

    await pricebook_markup_drift.handler(makeEnv(), {}, CTX);

    const [, sql, params] = readD1Mock.mock.calls[0];
    expect(sql.trim().toUpperCase().startsWith('SELECT')).toBe(true);
    expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP|ALTER)\b/i);
    expect(sql).toContain('pb_materials');
    expect(sql).toContain('pb_equipment');
    expect(sql).not.toContain('pb_services');
    // category-relative grouping resolves the real category name via
    // categories_json[0] -> pb_categories (category_name column is empty
    // fleet-wide), so the markup query MUST join pb_categories.
    expect(sql).toContain('pb_categories');
    expect(sql).toContain('json_extract');
    expect(Array.isArray(params)).toBe(true);
  });

  it('never string-interpolates threshold into the SQL text (fully parameterized)', async () => {
    wire();

    await pricebook_markup_drift.handler(makeEnv(), { threshold: 0.987654 }, CTX);

    const [, sql] = readD1Mock.mock.calls[0];
    expect(sql).not.toContain('0.987654');
  });

  it('computes per-category median markup and flags deviation outliers only in categories with enough peers', async () => {
    const rows = [
      // Category "Widgets" — 5 items (meets default minCategoryPeers=5).
      { id: 1, code: 'W1', name: 'Widget 1', category_name: 'Widgets', cost: 100, price: 150, kind: 'material' },
      { id: 2, code: 'W2', name: 'Widget 2', category_name: 'Widgets', cost: 100, price: 150, kind: 'material' },
      { id: 3, code: 'W3', name: 'Widget 3', category_name: 'Widgets', cost: 100, price: 150, kind: 'material' },
      { id: 4, code: 'W4', name: 'Widget 4', category_name: 'Widgets', cost: 100, price: 150, kind: 'material' },
      // Outlier: markup 3.0 vs category median 0.5 → deviation 2.5 > 0.5 threshold.
      { id: 5, code: 'W5', name: 'Widget 5 (outlier)', category_name: 'Widgets', cost: 100, price: 400, kind: 'equipment' },
      // Category "Gadgets" — only 3 items, below minCategoryPeers=5 → skipped entirely,
      // even though this item has an enormous markup.
      { id: 6, code: 'G1', name: 'Gadget 1', category_name: 'Gadgets', cost: 10, price: 10000, kind: 'material' },
      { id: 7, code: 'G2', name: 'Gadget 2', category_name: 'Gadgets', cost: 10, price: 12, kind: 'material' },
      { id: 8, code: 'G3', name: 'Gadget 3', category_name: 'Gadgets', cost: 10, price: 11, kind: 'material' },
    ];
    wire({ markup: rows });

    const out: any = await pricebook_markup_drift.handler(makeEnv(), {}, CTX);

    expect(out.summary.items_examined).toBe(8);
    expect(out.summary.categories_examined).toBe(1);
    expect(out.summary.categories_skipped_insufficient_peers).toBe(1);
    expect(out.summary.outliers_found).toBe(1);
    expect(out.outliers).toHaveLength(1);
    expect(out.outliers[0].id).toBe(5);
    expect(out.outliers[0].kind).toBe('equipment');
    expect(out.outliers[0].category).toBe('Widgets');
    expect(out.outliers[0].category_median).toBeCloseTo(0.5, 4);
    expect(out.outliers[0].deviation).toBeCloseTo(2.5, 4);
    // Gadgets category never surfaces despite a 1000x markup on G1.
    expect(out.outliers.find((o: any) => o.category === 'Gadgets')).toBeUndefined();
  });

  it('surfaces marginRisk populations: equipment cost>0/price=0 and material (0,0) placeholder count', async () => {
    wire({
      equipNoPrice: [
        { id: 501, code: 'E1', name: 'Unbilled Equip 1', cost: 900 },
        { id: 502, code: 'E2', name: 'Unbilled Equip 2', cost: 450 },
      ],
      placeholders: [{ cnt: 2074, synced_at: null }],
    });

    const out: any = await pricebook_markup_drift.handler(makeEnv(), {}, CTX);

    expect(out.marginRisk).toBeDefined();
    expect(out.marginRisk.equipmentCostNoPriceCount).toBe(2);
    expect(out.marginRisk.equipmentCostNoPrice).toHaveLength(2);
    expect(out.marginRisk.equipmentCostNoPrice[0].id).toBe(501);
    expect(out.marginRisk.materialPlaceholderCount).toBe(2074);

    // The equipment cost-no-price query must never touch price>0 in its WHERE —
    // it is explicitly looking for the price=0 unbilled-cost bug population.
    const equipSql = dataCalls()
      .map((c) => c[1] as string)
      .find((s) => /price\s*=\s*0/.test(s) && !/COUNT\(\*\)/.test(s));
    expect(equipSql).toBeDefined();
    expect(equipSql!).toContain('pb_equipment');
  });

  it('omits marginRisk when includeMarginRisk=false and only fires the main data query', async () => {
    wire();

    const out: any = await pricebook_markup_drift.handler(makeEnv(), { includeMarginRisk: false }, CTX);

    expect(out.marginRisk).toBeUndefined();
    // One data query (markup UNION); the fetchTableMax probe rides alongside.
    expect(dataCalls()).toHaveLength(1);
  });

  it('carries the honest dynamic-pricing exclusion _note and _source/_composite envelope', async () => {
    wire();

    const out: any = await pricebook_markup_drift.handler(makeEnv(), {}, CTX);

    expect(out._composite).toBe('pricebook_markup_drift');
    expect(out._source).toBe('d1');
    expect(out._note).toMatch(/dynamic/i);
    expect(out._note).toMatch(/pric/i);
    expect(out._note).toMatch(/excluded/i);
  });

  it('description states the D1 source, when-to-use, and the dynamic-pricing exclusion', () => {
    expect(pricebook_markup_drift.description).toMatch(/D1/);
    expect(pricebook_markup_drift.description).toMatch(/pb_materials/);
    expect(pricebook_markup_drift.description).toMatch(/dynamic/i);
    expect(pricebook_markup_drift.description).toMatch(/pric/i);
  });

  it('declares stEndpoint as a d1:// source and readOnlyHint', () => {
    expect(pricebook_markup_drift.stEndpoint?.source).toBe('d1');
    expect(pricebook_markup_drift.stEndpoint?.path).toContain('pb_materials');
    expect(pricebook_markup_drift.annotations?.readOnlyHint).toBe(true);
  });
});

// ── Mirror-freshness disclosure (MB-1 / QUA-1141, v2 table-level) ────
// Freshness comes from the fetchTableMax probe over every table this
// composite reads (pb_materials, pb_equipment AND the pb_categories join),
// so a zero-computable-rows run on live tables is an honest zero and a
// frozen table is named even when a sibling is fresh (F2/F5).

describe('pricebook_markup_drift freshness disclosure (MB-1 / QUA-1141)', () => {
  it('all data queries carry synced_at, and the probe covers all three tables read', async () => {
    wire();

    await pricebook_markup_drift.handler(makeEnv(), {}, CTX);

    expect(readD1Mock).toHaveBeenCalledTimes(4);
    for (const [, sql] of readD1Mock.mock.calls) {
      expect(sql).toContain('synced_at');
    }
    const probeSql = readD1Mock.mock.calls.map((c) => c[1] as string).find((s) => / AS t,/.test(s));
    expect(probeSql).toBeDefined();
    expect(probeSql!).toMatch(/MAX\(synced_at\)/);
    expect(probeSql!).toMatch(/FROM pb_materials/);
    expect(probeSql!).toMatch(/FROM pb_equipment/);
    expect(probeSql!).toMatch(/FROM pb_categories/);
    // The COUNT(*) query still carries MAX(synced_at) for degraded-mode fidelity.
    const countSql = readD1Mock.mock.calls.map((c) => c[1] as string).find((s) => /COUNT\(\*\)/.test(s));
    expect(countSql).toMatch(/MAX\(synced_at\)/);
  });

  it('live tables are stamped fresh and summary metrics are authoritative', async () => {
    wire({
      markup: [
        { id: 1, code: 'M1', name: 'A', category_name: 'Plumbing', cost: 10, price: 20, kind: 'material', synced_at: hoursAgo(2) },
      ],
    });

    const out: any = await pricebook_markup_drift.handler(makeEnv(), {}, CTX);

    expect(out._mirror_table).toBe('pb_materials+pb_equipment');
    expect(out._freshness).toBe('fresh');
    expect(out.summary.metrics_are_authoritative).toBe(true);
    expect(out._warning).toBeUndefined();
  });

  it('a frozen table is flagged unknown (quiet-or-frozen) by name and authority is withheld (F2)', async () => {
    wire({
      markup: [
        { id: 1, code: 'M1', name: 'A', category_name: 'Plumbing', cost: 10, price: 20, kind: 'material', synced_at: hoursAgo(24 * 25) },
      ],
      tableMax: { pb_equipment: hoursAgo(24 * 25) },
    });

    const out: any = await pricebook_markup_drift.handler(makeEnv(), {}, CTX);

    expect(out._freshness).toBe('unknown');
    expect(out.summary.metrics_are_authoritative).toBe(false);
    expect(out._warning).toMatch(/no row change in|indistinguishable/);
    expect(out._warning).toMatch(/pb_equipment/);
    expect(out._tables.pb_materials.freshness).toBe('fresh');
  });

  it('with zero computable rows, live tables still prove freshness — an honest zero (F5)', async () => {
    wire({ placeholders: [{ cnt: 2074, synced_at: hoursAgo(3) }] });

    const out: any = await pricebook_markup_drift.handler(makeEnv(), {}, CTX);

    expect(out._freshness).toBe('fresh');
    expect(out.summary.metrics_are_authoritative).toBe(true);
    expect(out._warning).toBeUndefined();
  });

  it('OLD rows on live tables are not called stale — the probe decides (F1)', async () => {
    wire({
      markup: [
        { id: 1, code: 'M1', name: 'A', category_name: 'Plumbing', cost: 10, price: 20, kind: 'material', synced_at: hoursAgo(24 * 90) },
      ],
    });

    const out: any = await pricebook_markup_drift.handler(makeEnv(), {}, CTX);

    expect(out._freshness).toBe('fresh');
    expect(out.summary.metrics_are_authoritative).toBe(true);
  });

  it('an unprovable probe (all MAX null) stays unknown', async () => {
    wire({ tableMax: { pb_materials: null, pb_equipment: null, pb_categories: null } });

    const out: any = await pricebook_markup_drift.handler(makeEnv(), {}, CTX);

    expect(out._freshness).toBe('unknown');
    expect(out.summary.metrics_are_authoritative).toBe(false);
    expect(out._warning).toMatch(/not proof/i);
  });

  it('marginRisk equipment rows do not leak synced_at — it feeds the stamp, not the payload', async () => {
    wire({
      equipNoPrice: [{ id: 9, code: 'E9', name: 'Coil', cost: 500, synced_at: hoursAgo(1) }],
    });

    const out: any = await pricebook_markup_drift.handler(makeEnv(), {}, CTX);

    expect(out.marginRisk.equipmentCostNoPrice[0]).not.toHaveProperty('synced_at');
  });
});
