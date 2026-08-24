// ============================================================
// ap_inbox_reconcile_amount.test.ts — QUA-1167 / QUA-672.
//
// Every case here is a REAL bill that broke the st-apinbox skill, not a
// happy path. The skill implements two of the five reconciliation modes;
// each mode below has cost QSC money or throughput at least once.
// ============================================================
import { describe, it, expect } from 'vitest';
import { reconcileAmount, ap_inbox_reconcile_amount } from '../ap_inbox/ap_inbox_reconcile_amount';

const ctx = { actor: 'test', correlation: 'c1' };

describe('ap_inbox_reconcile_amount — mode 1 (unit cost)', () => {
  // Johnstone / McCall's print UNIT cost, so totalCost = cost * qty.
  it('reconciles Sum(cost x qty) + tax + shipping against the header', () => {
    const r = reconcileAmount({
      header_total: 1000.0,
      tax: 0,
      shipping: 28.0,
      items: [{ description: 'CAP TUBE', quantity: 8, unit_cost: 121.5 }],
    });
    expect(r.reconciles).toBe(true);
    expect(r.mode).toBe('unit');
    expect(r.computed_total).toBeCloseTo(1000.0, 2);
  });

  // THE FALSE-SKIP BUG. file-bills.js computes Sum(lines) + tax and omits
  // shipping entirely, so two Trane parts bills came up exactly $28 of
  // freight short and were skipped as "cannot reconcile". Fixed 2026-07-11,
  // never committed, re-broken by 2026-07-28.
  it('does NOT skip a bill whose freight lives only in the shipping field', () => {
    const r = reconcileAmount({
      header_total: 1000.0,
      tax: 0,
      shipping: 28.0,
      items: [{ description: 'CAP TUBE', quantity: 8, unit_cost: 121.5 }],
    });
    expect(r.reconciles).toBe(true);
    expect(r.applied.shipping).toBe(28.0);
    expect(r.freight_line_detected).toBe(false);
  });
});

describe('ap_inbox_reconcile_amount — mode 2 (extended cost)', () => {
  // CES prints EXTENDED line totals, so totalCost = cost (already multiplied).
  // Reading those as unit cost is what filed bill 83175675 at $810.82 when the
  // true total was $216.88 — the single most damaging silent error in this
  // project, and the reason gate 3 exists at all.
  it('reconciles CES bill 83175675 in extended mode, not unit mode', () => {
    const r = reconcileAmount({
      header_total: 216.88,
      tax: 17.89,
      shipping: 0,
      items: [
        { description: 'PVC COUPLING', quantity: 7, unit_cost: 98.99 },
        { description: 'CONDUIT', quantity: 2, unit_cost: 100.0 },
      ],
    });
    expect(r.mode).toBe('extended');
    expect(r.reconciles).toBe(true);
    expect(r.computed_total).toBeCloseTo(216.88, 2);
    // The unit-mode reading would have been wildly higher — assert we rejected it.
    expect(r.sums.unit).toBeGreaterThan(800);
  });
});

describe('ap_inbox_reconcile_amount — mode 3 (tax-inclusive)', () => {
  // Lowe's embeds sales tax in the line items AND ST's OCR separately
  // populates taxRate. Both documented modes fail; adding tax over-states.
  // Detect: Sum(cost x qty) equals the header exactly -> file with tax = 0.
  // Recovered 4 Lowe's bills ($289.43) the skill would have skipped.
  it('files with tax zeroed when the lines already include tax', () => {
    const r = reconcileAmount({
      header_total: 289.43,
      tax: 21.42,
      shipping: 0,
      items: [{ description: 'PVC PRIMER', quantity: 1, unit_cost: 289.43 }],
    });
    expect(r.reconciles).toBe(true);
    expect(r.mode).toBe('tax_inclusive');
    expect(r.applied.tax).toBe(0);
    expect(r.computed_total).toBeCloseTo(289.43, 2);
  });
});

describe('ap_inbox_reconcile_amount — mode 4 (bad-OCR taxRate)', () => {
  // Winsupply small plumbing invoices where billData.taxRate OCRs LARGER than
  // the header (e.g. $37.10 tax on a $19.70 bill). Recurring, 3 instances on
  // 2026-08-17 alone. The gap closes at exactly 8% SC sales tax — but using
  // that figure means INVENTING a number to force reconciliation, which
  // gate 3 forbids. This must HOLD, permanently, not auto-resolve.
  it('HOLDs when OCR tax exceeds the header total', () => {
    const r = reconcileAmount({
      header_total: 19.7,
      tax: 37.1,
      shipping: 0,
      items: [{ description: 'PVC NIPPLE', quantity: 1, unit_cost: 19.7 }],
    });
    expect(r.reconciles).toBe(false);
    expect(r.mode).toBeNull();
    expect(r.reason).toMatch(/tax/i);
  });

  it('never silently computes 8% to close the gap', () => {
    const r = reconcileAmount({
      header_total: 19.7,
      tax: 37.1,
      shipping: 0,
      items: [{ description: 'PVC NIPPLE', quantity: 1, unit_cost: 19.7 }],
    });
    // 19.70 * 1.08 = 21.28 — if this ever shows up as a computed total,
    // someone has invented a tax figure.
    expect(r.computed_total).not.toBeCloseTo(21.28, 2);
    expect(r.applied.tax).not.toBeCloseTo(1.58, 2);
  });
});

describe('ap_inbox_reconcile_amount — mode 5 (freight double-count)', () => {
  // Winsupply inv 397305 01 ($1,752.84) missed both documented modes by
  // exactly $56.00 == billData.shipping, because freight was ALREADY a line
  // item (FREIGHT FREIGHT EXPENSE, $2.00 x 28) AND ST populated shipping.
  // Adding the shipping field double-counts it.
  it('zeroes shipping when a FREIGHT line already carries the freight', () => {
    const r = reconcileAmount({
      header_total: 1752.84,
      tax: 129.84,
      shipping: 56.0,
      items: [
        { description: 'COPPER FITTING', quantity: 100, unit_cost: 15.67 },
        { description: 'FREIGHT FREIGHT EXPENSE', quantity: 28, unit_cost: 2.0 },
      ],
    });
    expect(r.reconciles).toBe(true);
    expect(r.freight_line_detected).toBe(true);
    expect(r.applied.shipping).toBe(0);
    expect(r.computed_total).toBeCloseTo(1752.84, 2);
  });

  // The mirror case: a freight line exists but ST left shipping at 0, so
  // nothing is double-counted. Must stay plain unit mode.
  it('leaves shipping alone when a freight line exists but shipping is 0', () => {
    const r = reconcileAmount({
      header_total: 1623.0,
      tax: 0,
      shipping: 0,
      items: [
        { description: 'COPPER FITTING', quantity: 100, unit_cost: 15.67 },
        { description: 'FREIGHT', quantity: 28, unit_cost: 2.0 },
      ],
    });
    expect(r.reconciles).toBe(true);
    expect(r.mode).toBe('unit');
    expect(r.applied.shipping).toBe(0);
  });
});

describe('ap_inbox_reconcile_amount — NEITHER is a first-class result', () => {
  // C.E.S. job 82200454: header $920.36 vs lines $840.36. The SAME $80.00 gap
  // as the freight bug, but shipping is $0 and there is no freight line — so
  // this is a genuine OCR line-capture miss needing a human, NOT something to
  // absorb. Skipped twice on purpose.
  it('refuses an $80 gap that has no freight explanation', () => {
    const r = reconcileAmount({
      header_total: 920.36,
      tax: 0,
      shipping: 0,
      items: [{ description: 'WIRE 12AWG', quantity: 1, unit_cost: 840.36 }],
    });
    expect(r.reconciles).toBe(false);
    expect(r.mode).toBeNull();
    expect(r.difference).toBeCloseTo(80.0, 2);
    expect(r.reason).toMatch(/reconcile/i);
  });

  it('reports NEITHER as data, not as a thrown error', async () => {
    await expect(
      ap_inbox_reconcile_amount.handler(
        {} as any,
        {
          header_total: 920.36,
          tax: 0,
          shipping: 0,
          items: [{ description: 'WIRE 12AWG', quantity: 1, unit_cost: 840.36 }],
        },
        ctx,
      ),
    ).resolves.toMatchObject({ reconciles: false, mode: null });
  });
});

describe('ap_inbox_reconcile_amount — tolerance', () => {
  it('accepts a gap under $0.05', () => {
    const r = reconcileAmount({
      header_total: 100.04,
      tax: 0,
      shipping: 0,
      items: [{ description: 'X', quantity: 1, unit_cost: 100.0 }],
    });
    expect(r.reconciles).toBe(true);
  });

  it('rejects a gap at or over $0.05', () => {
    // The $0.94 short on WinSupply bill 82627325 was held, not absorbed.
    const r = reconcileAmount({
      header_total: 100.94,
      tax: 0,
      shipping: 0,
      items: [{ description: 'X', quantity: 1, unit_cost: 100.0 }],
    });
    expect(r.reconciles).toBe(false);
  });
});

describe('ap_inbox_reconcile_amount — the {value,text} parser trap', () => {
  // ReadBillDocument returns billData.items[].quantity and .itemCost as
  // {value,text} WRAPPERS, not scalars. Reading them as scalars zeroes every
  // line total and makes ALL bills report "cannot reconcile" — a 0-of-N
  // reconciliation rate is a parser bug, not bad vendor data.
  it('unwraps {value,text} quantity and cost instead of reading zero', () => {
    const r = reconcileAmount({
      header_total: 1000.0,
      tax: 0,
      shipping: 28.0,
      items: [
        {
          description: { value: 'CAP TUBE', text: 'CAP TUBE' },
          quantity: { value: 8, text: '8' },
          unit_cost: { value: 121.5, text: '121.50' },
        } as any,
      ],
    });
    expect(r.sums.unit).toBeCloseTo(972.0, 2);
    expect(r.reconciles).toBe(true);
  });

  it('accepts numeric strings from the text side', () => {
    const r = reconcileAmount({
      header_total: 972.0,
      tax: 0,
      shipping: 0,
      items: [{ description: 'CAP TUBE', quantity: '8' as any, unit_cost: '121.50' as any }],
    });
    expect(r.sums.unit).toBeCloseTo(972.0, 2);
  });
});

describe('ap_inbox_reconcile_amount — tool contract', () => {
  it('is a read-only tool with a computed source', () => {
    expect(ap_inbox_reconcile_amount.isWrite).toBeFalsy();
    expect(ap_inbox_reconcile_amount.stEndpoint?.source).toBe('computed');
  });

  it('describes every schema field', () => {
    for (const [name, field] of Object.entries(ap_inbox_reconcile_amount.zodSchema)) {
      expect((field as any).description, `${name} needs .describe()`).toBeTruthy();
    }
  });
});
