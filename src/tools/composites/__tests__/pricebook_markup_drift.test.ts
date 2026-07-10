// ============================================================
// pricebook_markup_drift — tests
//
// Mocks readD1 directly (vi.mock('../../../d1')) so we can assert on the
// exact SQL/params sent, independent of the servicetitan-proxy transport.
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

beforeEach(() => {
  readD1Mock.mockReset();
});

describe('pricebook_markup_drift', () => {
  it('issues a SELECT-only query scoped to pb_materials + pb_equipment only (no pb_services)', async () => {
    readD1Mock.mockResolvedValueOnce({ rows: [] });
    readD1Mock.mockResolvedValueOnce({ rows: [] });
    readD1Mock.mockResolvedValueOnce({ rows: [{ cnt: 0 }] });

    await pricebook_markup_drift.handler(makeEnv(), {}, CTX);

    const [, sql, params] = readD1Mock.mock.calls[0];
    expect(sql.trim().toUpperCase().startsWith('SELECT')).toBe(true);
    expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP|ALTER)\b/i);
    expect(sql).toContain('pb_materials');
    expect(sql).toContain('pb_equipment');
    expect(sql).not.toContain('pb_services');
    expect(Array.isArray(params)).toBe(true);
  });

  it('never string-interpolates threshold into the SQL text (fully parameterized)', async () => {
    readD1Mock.mockResolvedValueOnce({ rows: [] });
    readD1Mock.mockResolvedValueOnce({ rows: [] });
    readD1Mock.mockResolvedValueOnce({ rows: [{ cnt: 0 }] });

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
    readD1Mock.mockResolvedValueOnce({ rows });
    readD1Mock.mockResolvedValueOnce({ rows: [] });
    readD1Mock.mockResolvedValueOnce({ rows: [{ cnt: 0 }] });

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
    readD1Mock.mockResolvedValueOnce({ rows: [] }); // main markup query
    readD1Mock.mockResolvedValueOnce({
      rows: [
        { id: 501, code: 'E1', name: 'Unbilled Equip 1', cost: 900 },
        { id: 502, code: 'E2', name: 'Unbilled Equip 2', cost: 450 },
      ],
    }); // equipment cost>0/price=0
    readD1Mock.mockResolvedValueOnce({ rows: [{ cnt: 2074 }] }); // material placeholder count

    const out: any = await pricebook_markup_drift.handler(makeEnv(), {}, CTX);

    expect(out.marginRisk).toBeDefined();
    expect(out.marginRisk.equipmentCostNoPriceCount).toBe(2);
    expect(out.marginRisk.equipmentCostNoPrice).toHaveLength(2);
    expect(out.marginRisk.equipmentCostNoPrice[0].id).toBe(501);
    expect(out.marginRisk.materialPlaceholderCount).toBe(2074);

    // The equipment cost-no-price query must never touch price>0 in its WHERE —
    // it is explicitly looking for the price=0 unbilled-cost bug population.
    const [, equipSql] = readD1Mock.mock.calls[1];
    expect(equipSql).toContain('pb_equipment');
    expect(equipSql).toMatch(/price\s*=\s*0/);
  });

  it('omits marginRisk when includeMarginRisk=false and only fires the main query', async () => {
    readD1Mock.mockResolvedValueOnce({ rows: [] });

    const out: any = await pricebook_markup_drift.handler(makeEnv(), { includeMarginRisk: false }, CTX);

    expect(out.marginRisk).toBeUndefined();
    expect(readD1Mock).toHaveBeenCalledTimes(1);
  });

  it('carries the honest dynamic-pricing exclusion _note and _source/_composite envelope', async () => {
    readD1Mock.mockResolvedValueOnce({ rows: [] });
    readD1Mock.mockResolvedValueOnce({ rows: [] });
    readD1Mock.mockResolvedValueOnce({ rows: [{ cnt: 0 }] });

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
