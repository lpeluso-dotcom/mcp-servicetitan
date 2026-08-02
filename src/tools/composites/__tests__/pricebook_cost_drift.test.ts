// ============================================================
// pricebook_cost_drift — tests
// ============================================================
import { describe, it, expect, vi, beforeEach } from 'vitest';

const readD1Mock = vi.fn();
vi.mock('../../../d1', () => ({
  readD1: (...args: unknown[]) => readD1Mock(...args),
}));

import { pricebook_cost_drift } from '../pricebook_cost_drift';

const CTX = { actor: 'test', correlation: 'c1' };

function makeEnv(): any {
  return { ST_PROXY: { fetch: vi.fn() }, MCP_SYNC_KEY: 'k' };
}

beforeEach(() => {
  readD1Mock.mockReset();
});

describe('pricebook_cost_drift', () => {
  it('issues a SELECT-only query scoped to pb_materials + pb_equipment (no pb_services)', async () => {
    readD1Mock.mockResolvedValueOnce({ rows: [] });

    await pricebook_cost_drift.handler(makeEnv(), {}, CTX);

    const [, sql] = readD1Mock.mock.calls[0];
    expect(sql.trim().toUpperCase().startsWith('SELECT')).toBe(true);
    expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP|ALTER)\b/i);
    expect(sql).toContain('pb_materials');
    expect(sql).toContain('pb_equipment');
    expect(sql).not.toContain('pb_services');
  });

  it('uses the SQLite-safe substr(updated_at,1,10) >= date(\'now\', ?) pattern, not a raw datetime() compare', async () => {
    readD1Mock.mockResolvedValueOnce({ rows: [] });

    await pricebook_cost_drift.handler(makeEnv(), { windowDays: 45 }, CTX);

    const [, sql, params] = readD1Mock.mock.calls[0];
    expect(sql).toContain("substr(updated_at, 1, 10) >= date('now', ?)");
    expect(sql).not.toMatch(/datetime\(/i);
    // windowDays must arrive as a bound parameter, never interpolated into the SQL text.
    expect(sql).not.toContain('45');
    expect(params).toContain('-45 days');
  });

  it('defaults windowDays to 30 when omitted', async () => {
    readD1Mock.mockResolvedValueOnce({ rows: [] });

    const out: any = await pricebook_cost_drift.handler(makeEnv(), {}, CTX);

    const [, , params] = readD1Mock.mock.calls[0];
    expect(params).toContain('-30 days');
    expect(out.window_days).toBe(30);
  });

  it('clamps windowDays to the 1..365 range', async () => {
    readD1Mock.mockResolvedValueOnce({ rows: [] });
    let out: any = await pricebook_cost_drift.handler(makeEnv(), { windowDays: 5000 }, CTX);
    expect(out.window_days).toBe(365);
    let [, , params] = readD1Mock.mock.calls[0];
    expect(params).toContain('-365 days');

    readD1Mock.mockReset();
    readD1Mock.mockResolvedValueOnce({ rows: [] });
    out = await pricebook_cost_drift.handler(makeEnv(), { windowDays: -10 }, CTX);
    expect(out.window_days).toBe(1);
    [, , params] = readD1Mock.mock.calls[0];
    expect(params).toContain('-1 days');
  });

  it('maps rows to the documented shape and reports an honest count', async () => {
    readD1Mock.mockResolvedValueOnce({
      rows: [
        { id: 10, code: 'M1', name: 'Copper Fitting', category_name: 'Plumbing', cost: 12.5, price: 20, updated_at: '2026-07-05T10:00:00Z', kind: 'material' },
        { id: 20, code: 'E1', name: 'Condenser', category_name: 'HVAC Equip', cost: 800, price: 1200, updated_at: '2026-07-01T08:30:00Z', kind: 'equipment' },
      ],
    });

    const out: any = await pricebook_cost_drift.handler(makeEnv(), { windowDays: 14 }, CTX);

    expect(out.count).toBe(2);
    expect(out.items[0]).toMatchObject({
      id: 10, code: 'M1', name: 'Copper Fitting', kind: 'material',
      category: 'Plumbing', cost: 12.5, price: 20, updated_at: '2026-07-05T10:00:00Z',
    });
    expect(out.items[1].kind).toBe('equipment');
  });

  // ── Dynamic-pricing honesty ────────────────────────────────
  // QSC runs Pricebook Pro: a stored price of 0 does NOT mean "free", it means
  // "computed at invoice time from rules/BU/membership/labor". D1 stores a
  // literal 0 for 16,322 of 16,543 pb_materials rows (0 NULLs — verified live
  // 2026-07-28), so passing r.price through emitted `price: 0` on essentially
  // every row. Contrary to the original defect report, nothing here coalesced
  // null->0; the tool simply never applied the shaper the other pricebook tools
  // use (shapePriceRow in src/supabase.ts).
  it('never emits price: 0 — a zero stored price becomes null with a dynamic price_basis', async () => {
    readD1Mock.mockResolvedValueOnce({
      rows: [
        { id: 10, code: 'M1', name: 'PEX Clamp', category_name: null, cost: 0.32, price: 0, updated_at: '2026-07-27T14:00:00Z', kind: 'material' },
        { id: 20, code: 'E1', name: 'Condenser', category_name: 'HVAC Equip', cost: 3021.7, price: 0, updated_at: '2026-07-27T12:28:00Z', kind: 'equipment' },
      ],
    });

    const out: any = await pricebook_cost_drift.handler(makeEnv(), {}, CTX);

    for (const item of out.items) {
      expect(item.price, `item ${item.code} emitted a literal $0 price`).toBeNull();
      expect(item.price_basis).toBe('dynamic — computed at invoice');
      // cost is a real vendor cost and must survive untouched.
      expect(item.cost).toBeGreaterThan(0);
    }
  });

  it('keeps a genuine non-zero price and tags it as a stored reference', async () => {
    readD1Mock.mockResolvedValueOnce({
      rows: [
        { id: 30, code: 'M2', name: 'Priced Item', category_name: 'Plumbing', cost: 12.5, price: 20, updated_at: '2026-07-05T10:00:00Z', kind: 'material' },
      ],
    });

    const out: any = await pricebook_cost_drift.handler(makeEnv(), {}, CTX);

    expect(out.items[0].price).toBe(20);
    expect(out.items[0].price_basis).toBe('reference (stored ST price)');
  });

  it('carries the honest "modifiedOn is any-field-change, not a verified cost delta" _note', async () => {
    readD1Mock.mockResolvedValueOnce({ rows: [] });

    const out: any = await pricebook_cost_drift.handler(makeEnv(), {}, CTX);

    expect(out._composite).toBe('pricebook_cost_drift');
    expect(out._source).toBe('d1');
    expect(out._note).toMatch(/modifiedOn/i);
    expect(out._note).toMatch(/not verified cost/i);
  });

  it('description states D1 source, when-to-use, and dynamic-pricing services exclusion', () => {
    expect(pricebook_cost_drift.description).toMatch(/D1/);
    expect(pricebook_cost_drift.description).toMatch(/pb_materials/);
    expect(pricebook_cost_drift.description).toMatch(/dynamic/i);
    expect(pricebook_cost_drift.description).toMatch(/pric/i);
  });

  it('declares stEndpoint as a d1:// source and readOnlyHint', () => {
    expect(pricebook_cost_drift.stEndpoint?.source).toBe('d1');
    expect(pricebook_cost_drift.annotations?.readOnlyHint).toBe(true);
  });
});
