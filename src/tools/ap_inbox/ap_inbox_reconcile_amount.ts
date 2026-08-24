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

/**
 * Tolerance in INTEGER CENTS, not dollars.
 *
 * Luke's standing guard is +/- $0.05. Expressed as a float comparison
 * (`Math.abs(a - b) < 0.05`) it silently accepts a gap of exactly five cents:
 * 100.05 - 100 evaluates to 0.049999999999997. Comparing rounded cents makes
 * the boundary mean what the number says.
 */
export const TOLERANCE_CENTS = 5;

interface Parsed {
  value: number;
  ok: boolean;
}

const BAD: Parsed = { value: 0, ok: false };

/**
 * Unwrap ServiceTitan's `{value, text}` field wrapper to a number, REPORTING
 * whether the parse actually succeeded.
 *
 * THE PARSER TRAP. billData.items[].quantity and .itemCost are `{value,text}`
 * wrappers, not scalars — the same shape as every other billData field.
 * Reading them as scalars zeroes every line total and makes ALL bills report
 * "cannot reconcile". The general rule that cost real time on 2026-08-05: a
 * 0-of-N reconciliation rate is a parser bug, not bad vendor data.
 *
 * WHY `ok` EXISTS. The first version of this function returned 0 for anything
 * it could not parse. `Number('USD 50')` is NaN, so a line quietly vanished
 * from the total and the tool still reported "reconciles". On one constructed
 * bill that produced a confident file-it-at-$216.88 while dropping a $593.94
 * line — with sums.extended reading 810.82, the exact CES incident figure.
 * Unparseable is not zero. It is a HOLD.
 */
function parseNum(v: unknown): Parsed {
  if (v === null || v === undefined) return BAD;
  if (typeof v === 'number') return Number.isFinite(v) ? { value: v, ok: true } : BAD;
  if (typeof v === 'string') {
    const cleaned = v.replace(/[$,\s]/g, '');
    if (cleaned === '') return BAD;
    const n = Number(cleaned);
    return Number.isFinite(n) ? { value: n, ok: true } : BAD;
  }
  if (typeof v === 'object') {
    const o = v as { value?: unknown; text?: unknown };
    if (o.value !== undefined && o.value !== null) return parseNum(o.value);
    if (o.text !== undefined) return parseNum(o.text);
  }
  return BAD;
}

/** Optional money field: absent is a legitimate 0, but a malformed value is not. */
function parseMoneyOrZero(v: unknown): Parsed {
  if (v === null || v === undefined) return { value: 0, ok: true };
  return parseNum(v);
}

const cents = (n: number) => Math.round(n * 100);
const within = (a: number, b: number) => Math.abs(cents(a) - cents(b)) < TOLERANCE_CENTS;

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
  | 'tax_inclusive'
  | 'extended_tax_inclusive';

/**
 * Do two modes post the same per-line amounts?
 *
 * Unit-family modes derive each line as cost x qty; extended-family modes take
 * cost as the line total already. Two modes from the same family disagreeing
 * only on tax/shipping still split the LINES identically, so there is nothing
 * for a human to arbitrate.
 */
function sameLineBasis(a: ReconcileMode, b: ReconcileMode): boolean {
  const extended = (m: ReconcileMode) => m.startsWith('extended');
  return extended(a) === extended(b);
}

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
  /**
   * Other modes that ALSO landed inside tolerance with different per-line
   * amounts. Non-empty means the bill was held for ambiguity: `mode` decides
   * how each LINE is posted, and AP lines map to jobs, so guessing
   * misallocates cost across jobs — the exact thing this program exists to get
   * right.
   */
  also_matched: ReconcileMode[];
  /** Set only when reconciles === false. Null on success. */
  reason: string | null;
}

function hold(
  reason: string,
  base: Omit<ReconcileResult, 'reconciles' | 'mode' | 'reason' | 'also_matched'>,
): ReconcileResult {
  return { ...base, reconciles: false, mode: null, also_matched: [], reason };
}

export function reconcileAmount(input: ReconcileInput): ReconcileResult {
  const headerP = parseNum(input.header_total);
  const taxP = parseMoneyOrZero(input.tax);
  const shippingP = parseMoneyOrZero(input.shipping);

  const rawItems = input.items ?? [];
  const lines = rawItems.map((it) => ({
    description: toStr(it.description),
    quantity: parseNum(it.quantity),
    unit_cost: parseNum(it.unit_cost),
  }));

  const header = headerP.value;
  const tax = taxP.value;
  const shipping = shippingP.value;
  const sumUnit = lines.reduce((s, l) => s + l.unit_cost.value * l.quantity.value, 0);
  const sumExtended = lines.reduce((s, l) => s + l.unit_cost.value, 0);
  const freight = lines.some((l) => isFreightLine(l.description));
  const sums = { unit: round2(sumUnit), extended: round2(sumExtended) };
  const base = {
    header_total: round2(header),
    computed_total: round2(sumUnit + tax + shipping),
    difference: round2(header - (sumUnit + tax + shipping)),
    applied: { tax: round2(tax), shipping: round2(shipping) },
    freight_line_detected: freight,
    sums,
  };

  // ── Refuse to compute on input we cannot read ─────────────────────────
  // Everything below this block would otherwise treat "missing" as zero and
  // then report a confident verdict on data it never had.

  if (lines.length === 0) {
    return hold(
      'No line items supplied — there is nothing to reconcile. A bill with no readable lines ' +
        'must be opened by a human; 0 == 0 is not a reconciliation.',
      base,
    );
  }

  if (!headerP.ok || header === 0) {
    return hold(
      `Header total is ${headerP.ok ? '0' : 'unreadable'}. ap_inbox_list_documents floors a missing ` +
        `totalAmount to 0, so this most likely means the header never arrived — not that the bill is free.`,
      base,
    );
  }

  const unparseable = lines
    .map((l, i) => ({ i, l }))
    .filter(({ l }) => !l.quantity.ok || !l.unit_cost.ok);
  if (unparseable.length > 0) {
    const which = unparseable
      .map(({ i, l }) => `line ${i} (${l.description || 'no description'})`)
      .join(', ');
    return hold(
      `Could not parse quantity or cost on ${unparseable.length} line(s): ${which}. ` +
        `Unparseable is NOT zero — treating it as zero silently deletes the line from the total ` +
        `while still reporting success. HOLD and open the PDF.`,
      base,
    );
  }

  const nonPositiveQty = lines.filter((l) => l.quantity.value <= 0);
  if (nonPositiveQty.length > 0) {
    return hold(
      `${nonPositiveQty.length} line(s) have a quantity of zero or less. On a bill about to be filed ` +
        `that is not legitimate data — it removes the line from Sum(cost x qty) while leaving it in ` +
        `the extended sum, which is how a dropped line masquerades as a clean reconciliation.`,
      base,
    );
  }

  // ── Mode 4: bad-OCR taxRate. Checked before any candidate. ────────────
  // Winsupply small invoices where OCR reads tax at or above the whole bill
  // ($37.10 on a $19.70 header). The gap always closes at exactly 8% SC sales
  // tax — and using that figure means inventing a number to force
  // reconciliation, which gate 3 forbids.
  //
  // This MUST short-circuit: with tax excluded, the tax_inclusive candidate
  // (sumUnit + shipping) lands exactly on the header for these bills and would
  // "reconcile" them. Comparison is >= because a 100%-tax, 0%-material bill is
  // the same defect one cent further along.
  if (header > 0 && tax >= header) {
    return hold(
      `OCR tax (${tax.toFixed(2)}) is at or above the header total (${header.toFixed(2)}) — ` +
        `a known Winsupply misread. HOLD for human review. Computing the tax to close the ` +
        `gap would be inventing a number, which the reconciliation gate forbids.`,
      base,
    );
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
    // The extended half of mode 3. Without it a CES-style bill whose lines
    // already include tax cannot reconcile in ANY mode — a throughput
    // regression of exactly the kind mode 3 was added to fix. Every other mode
    // comes in a unit/extended pair; this one was missing its twin.
    {
      mode: 'extended_tax_inclusive',
      total: sumExtended + shipping,
      applied: { tax: 0, shipping },
      eligible: tax > 0,
    },
  ];

  const matches = candidates.filter((c) => c.eligible && within(c.total, header));

  if (matches.length > 0) {
    const winner = matches[0]; // unit-first precedence, as the skill has always done
    // AMBIGUITY. `mode` decides how each LINE is posted, not just the header
    // total, and AP lines map to jobs. Two modes can only both land inside
    // tolerance when their sums are within $0.10 of each other — but when they
    // do, picking the first silently misallocates cost across jobs.
    //
    // Identical sums are NOT ambiguous: with every quantity at 1, unit and
    // extended are the same arithmetic and produce the same per-line amounts.
    // Only a genuine per-line disagreement is worth holding for.
    const rivals = matches
      .slice(1)
      .filter((c) => Math.abs(cents(c.total) - cents(winner.total)) !== 0 || !sameLineBasis(c.mode, winner.mode))
      .filter((c) => cents(sums.unit) !== cents(sums.extended));

    if (rivals.length > 0) {
      return {
        ...hold(
          `Ambiguous: ${[winner, ...rivals].map((c) => c.mode).join(' and ')} all reconcile to the ` +
            `header within $0.05, but they imply DIFFERENT per-line amounts (unit sum ` +
            `${sums.unit.toFixed(2)} vs extended sum ${sums.extended.toFixed(2)}). The header would be ` +
            `right either way, but the line split would be a guess — and AP lines map to jobs. ` +
            `HOLD; a human must pick the basis.`,
          base,
        ),
        computed_total: round2(winner.total),
        difference: round2(header - winner.total),
        also_matched: rivals.map((c) => c.mode),
      };
    }

    return {
      reconciles: true,
      mode: winner.mode,
      header_total: round2(header),
      computed_total: round2(winner.total),
      difference: round2(header - winner.total),
      applied: { tax: round2(winner.applied.tax), shipping: round2(winner.applied.shipping) },
      freight_line_detected: freight,
      sums,
      also_matched: [],
      reason: null,
    };
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
    also_matched: [],
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
