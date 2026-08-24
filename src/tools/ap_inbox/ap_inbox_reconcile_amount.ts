// ============================================================
// ap_inbox_reconcile_amount — QUA-1167 / QUA-672.
//
// Decides whether an AP-inbox document's line items reconcile to its header
// total, and in WHICH mode, so a caller can file it with the right numbers —
// or refuse.
//
// Pure computation: no network, no ServiceTitan call, no session cookie. The
// caller already holds the line items (ReadBillDocument) and the header total
// (GetBillDocuments row). Keeping it pure is what makes the five modes
// testable against the real bills that broke each one.
//
// WHY FIVE MODES. The skill implements two (unit, extended). Each of the
// other three cost real money or real throughput:
//   3. tax-inclusive — Lowe's; 4 bills / $289.43 wrongly skipped
//   4. bad-OCR taxRate — Winsupply; MUST hold, never auto-resolve
//   5. freight double-count — Winsupply inv 397305 01; $56.00 over-posted
// A two-mode reconciler is a regression, not a simplification.
// ============================================================

import { z } from 'zod';
import type { ToolDef } from '../index';

/** Absolute tolerance, in dollars. Luke's standing guard: reconciliation +/- $0.05. */
export const TOLERANCE = 0.05;

/**
 * Unwrap ServiceTitan's `{value, text}` field wrapper to a number.
 *
 * THE PARSER TRAP. billData.items[].quantity and .itemCost are `{value,text}`
 * wrappers, not scalars — the same shape as every other billData field.
 * Reading them as scalars zeroes every line total and makes ALL bills report
 * "cannot reconcile". The general rule that cost real time on 2026-08-05: a
 * 0-of-N reconciliation rate is a parser bug, not bad vendor data.
 */
function toNum(v: unknown): number {
  if (v === null || v === undefined) return 0;
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  if (typeof v === 'string') {
    const n = Number(v.replace(/[$,\s]/g, ''));
    return Number.isFinite(n) ? n : 0;
  }
  if (typeof v === 'object') {
    const o = v as { value?: unknown; text?: unknown };
    if (o.value !== undefined && o.value !== null) return toNum(o.value);
    if (o.text !== undefined) return toNum(o.text);
  }
  return 0;
}

function toStr(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'object') {
    const o = v as { value?: unknown; text?: unknown };
    if (typeof o.value === 'string') return o.value;
    if (typeof o.text === 'string') return o.text;
  }
  return String(v);
}

/**
 * Does this line already carry the freight charge?
 *
 * Deliberately broad. Over-matching is safe here because mode 5 additionally
 * requires shipping > 0 AND that the bill reconciles once shipping is removed
 * — a triple condition no ordinary material line satisfies by accident.
 *
 * Screen on the VENDOR's description. Never on `sku.text`: that is
 * ServiceTitan's fuzzy pricebook match, not the vendor's line text (a
 * Johnstone line reading '1/2" HUB' carried a cast-iron coupling as sku.text).
 */
function isFreightLine(description: string): boolean {
  return /\b(FREIGHT|SHIPPING|DELIVERY)\b/i.test(description);
}

export type ReconcileMode =
  | 'unit'
  | 'extended'
  | 'unit_freight_in_lines'
  | 'extended_freight_in_lines'
  | 'tax_inclusive';

export interface ReconcileInput {
  header_total: number;
  tax?: unknown;
  shipping?: unknown;
  items: Array<{ description?: unknown; quantity?: unknown; unit_cost?: unknown }>;
}

export interface ReconcileResult {
  reconciles: boolean;
  mode: ReconcileMode | null;
  header_total: number;
  computed_total: number;
  /** header_total - computed_total. Non-zero on a refusal tells the human how far off it is. */
  difference: number;
  /** What to actually send when filing. Mode 3 zeroes tax; mode 5 zeroes shipping. */
  applied: { tax: number; shipping: number };
  freight_line_detected: boolean;
  sums: { unit: number; extended: number };
  /** Set only when reconciles === false. Null on success. */
  reason: string | null;
}

export function reconcileAmount(input: ReconcileInput): ReconcileResult {
  const header = toNum(input.header_total);
  const tax = toNum(input.tax);
  const shipping = toNum(input.shipping);

  const lines = (input.items ?? []).map((it) => ({
    description: toStr(it.description),
    quantity: toNum(it.quantity),
    unit_cost: toNum(it.unit_cost),
  }));

  const sumUnit = lines.reduce((s, l) => s + l.unit_cost * l.quantity, 0);
  const sumExtended = lines.reduce((s, l) => s + l.unit_cost, 0);
  const freight = lines.some((l) => isFreightLine(l.description));
  const sums = { unit: round2(sumUnit), extended: round2(sumExtended) };

  // ── Mode 4 FIRST: bad-OCR taxRate. ────────────────────────────────────
  // Winsupply small invoices where OCR reads tax LARGER than the whole bill
  // ($37.10 on a $19.70 header). The gap always closes at exactly 8% SC sales
  // tax — and using that figure means inventing a number to force
  // reconciliation, which gate 3 forbids. Short-circuit before any candidate
  // so no later mode can accidentally rescue it.
  if (header > 0 && tax > header) {
    return {
      reconciles: false,
      mode: null,
      header_total: round2(header),
      computed_total: round2(sumUnit + tax + shipping),
      difference: round2(header - (sumUnit + tax + shipping)),
      applied: { tax: round2(tax), shipping: round2(shipping) },
      freight_line_detected: freight,
      sums,
      reason:
        `OCR tax (${tax.toFixed(2)}) exceeds the header total (${header.toFixed(2)}) — ` +
        `a known Winsupply misread. HOLD for human review. Computing the tax to close the ` +
        `gap would be inventing a number, which the reconciliation gate forbids.`,
    };
  }

  // Ordered candidates. Unit is tried first and wins ties, matching the
  // skill's existing precedence so behavior does not shift under vendors that
  // already file correctly.
  const candidates: Array<{
    mode: ReconcileMode;
    total: number;
    applied: { tax: number; shipping: number };
    eligible: boolean;
  }> = [
    {
      mode: 'unit',
      total: sumUnit + tax + shipping,
      applied: { tax, shipping },
      eligible: true,
    },
    {
      mode: 'extended',
      total: sumExtended + tax + shipping,
      applied: { tax, shipping },
      eligible: true,
    },
    // Mode 5, both readings: freight is already a line item AND ST populated
    // shipping. Counting both double-posts the freight onto the job.
    {
      mode: 'unit_freight_in_lines',
      total: sumUnit + tax,
      applied: { tax, shipping: 0 },
      eligible: freight && shipping > 0,
    },
    {
      mode: 'extended_freight_in_lines',
      total: sumExtended + tax,
      applied: { tax, shipping: 0 },
      eligible: freight && shipping > 0,
    },
    // Mode 3: lines already include sales tax; adding ST's taxRate overstates.
    {
      mode: 'tax_inclusive',
      total: sumUnit + shipping,
      applied: { tax: 0, shipping },
      eligible: tax > 0,
    },
  ];

  for (const c of candidates) {
    if (!c.eligible) continue;
    if (Math.abs(c.total - header) < TOLERANCE) {
      return {
        reconciles: true,
        mode: c.mode,
        header_total: round2(header),
        computed_total: round2(c.total),
        difference: round2(header - c.total),
        applied: { tax: round2(c.applied.tax), shipping: round2(c.applied.shipping) },
        freight_line_detected: freight,
        sums,
        reason: null,
      };
    }
  }

  // NEITHER. Report against the closest eligible candidate so the human sees
  // how far off it is — the C.E.S. $80.00 case looked like the freight bug but
  // was a genuine OCR line-capture miss, and that distinction is only visible
  // with the arithmetic attached.
  const eligible = candidates.filter((c) => c.eligible);
  const closest = eligible.reduce((best, c) =>
    Math.abs(c.total - header) < Math.abs(best.total - header) ? c : best,
  );
  const gap = header - closest.total;

  return {
    reconciles: false,
    mode: null,
    header_total: round2(header),
    computed_total: round2(closest.total),
    difference: round2(gap),
    applied: { tax: round2(tax), shipping: round2(shipping) },
    freight_line_detected: freight,
    sums,
    reason:
      `Cannot reconcile to the header in any of the 5 known modes — closest is ` +
      `${closest.mode} at ${closest.total.toFixed(2)} vs header ${header.toFixed(2)} ` +
      `(off by ${Math.abs(gap).toFixed(2)}). DO NOT FILE. ` +
      (freight
        ? `A freight line is present but zeroing shipping does not close the gap either.`
        : `No freight line and shipping is ${shipping.toFixed(2)}, so this is most likely an ` +
          `OCR line-capture miss — open the PDF.`),
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

const LineItem = z
  .object({
    description: z
      .unknown()
      .optional()
      .describe(
        "Vendor's line description. Use billData.items[].description — NEVER sku.text, which is ServiceTitan's fuzzy pricebook match rather than the vendor's own text. Accepts a raw string or ST's {value,text} wrapper.",
      ),
    quantity: z
      .unknown()
      .optional()
      .describe(
        "Line quantity. Accepts a number, a numeric string, or ST's {value,text} wrapper — billData returns these wrapped, and reading them as scalars zeroes every line.",
      ),
    unit_cost: z
      .unknown()
      .optional()
      .describe(
        'Line cost as printed (billData.items[].itemCost). Whether this is a unit or an extended price is exactly what this tool determines — do not pre-multiply it.',
      ),
  })
  .passthrough();

interface Args {
  header_total: number;
  tax?: unknown;
  shipping?: unknown;
  items: Array<{ description?: unknown; quantity?: unknown; unit_cost?: unknown }>;
}

export const ap_inbox_reconcile_amount: ToolDef<Args> = {
  name: 'ap_inbox_reconcile_amount',
  description:
    'Decide whether an AP-inbox bill reconciles to its header total, and in which of 5 modes ' +
    '(unit, extended, tax-inclusive, freight-in-lines, or bad-OCR-tax). Returns the computed total, ' +
    'which mode matched, and the tax/shipping values to file with — or an explicit refusal with the ' +
    'arithmetic attached. Tolerance is $0.05. A refusal is a normal result, not an error: DO NOT FILE ' +
    'a bill this tool refuses. Source: computed — pure arithmetic over the line items you pass in, ' +
    'no ServiceTitan call and no session needed.',
  zodSchema: {
    header_total: z
      .number()
      .describe(
        'The invoice header total to reconcile against — the `totalAmount` field on the GetBillDocuments row (NOT in billData).',
      ),
    tax: z
      .unknown()
      .optional()
      .describe(
        'billData.taxRate. Despite the name this is a tax AMOUNT, not a rate. Accepts ST\'s {value,text} wrapper. Omit or 0 if untaxed.',
      ),
    shipping: z
      .unknown()
      .optional()
      .describe(
        "billData.shipping — the header-level freight charge, separate from items[]. Accepts ST's {value,text} wrapper. Omit or 0 if none.",
      ),
    items: z
      .array(LineItem)
      .describe('Line items from billData.items[]. Pass them as ST returned them; wrappers are unwrapped here.'),
  },
  stEndpoint: { method: 'GET', path: '(computed — no ServiceTitan call)', source: 'computed' },
  async handler(_env, args) {
    return reconcileAmount(args);
  },
};
