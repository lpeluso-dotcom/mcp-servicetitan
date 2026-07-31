// ============================================================
// invoice-verify.ts — post-write verify-read for the invoice write tools.
//
// FOUNDING LESSON (2026-07-31, twice in one day): BIND-SUCCESS IS NOT EFFECT.
// ServiceTitan's ASP.NET model binding silently drops any body field it does
// not know and still answers HTTP 200. Both invoice-write tools shipped a
// wrong field name (`price` instead of `unitPrice`; `lineItems` instead of
// `items`) and reported success while writing a $0.00 line and a zero-item
// $0.00 adjustment invoice. Neither the proxy's status code nor a 400-probe
// bind-echo can distinguish "ST persisted what I sent" from "ST accepted my
// request and ignored the part that mattered". Only a re-read can.
//
// Hence: after any dryRun=false write, the tool re-reads the invoice and
// asserts the MONETARY effect. Outcomes (see McpErrorCode):
//   verified          → success, with the actual observed amounts echoed back
//   silent_noop       → effect absent (items missing / item id not found)
//   amount_mismatch   → effect present but the money is wrong
//   verify_unavailable→ could not observe (lag, read error, ids not honored)
//
// READ-SIDE FIELD NAME: on the WRITE side the monetary field is `unitPrice`;
// on the READ side ST returns it as `price` (cf. invoice 84399973, item
// `price: -13674.00`). itemPrice() reads `price` first and tolerates
// `unitPrice` in case a future ST read model uses the write-side name.
//
// NEVER auto-retry the write from here. A verify failure means the state is
// unknown or wrong, not that nothing happened — re-sending is how you get two
// $9,771 lines. Every error raised here must NAME the ids that were created or
// modified, so nothing is stranded invisibly (adjustment invoices in
// particular are NOT deletable via the ST API).
// ============================================================

import { McpError } from '../../errors';
import { readST } from '../../st';
import type { Env } from '../../env';

// NOTE: ST's read side serializes numeric fields as JSON STRINGS ("9771.00",
// "1.0000000000000000000") — every numeric field here admits both, and all
// comparisons must go through toMoney(), never typeof-number checks.
export interface VerifyInvoiceItem {
  id?: number;
  skuName?: string;
  description?: string;
  quantity?: number | string;
  cost?: number | string;
  /** READ-side monetary field. */
  price?: number | string;
  /** WRITE-side monetary field name; tolerated on read in case ST unifies. */
  unitPrice?: number | string;
  total?: number | string;
  [key: string]: unknown;
}

export interface VerifyInvoice {
  id?: number;
  /**
   * ST returns `items: null` on an invoice with no lines (that is exactly what
   * the stray adjustment invoice 84402274 looked like). `undefined` — the key
   * absent altogether — means the read did not carry items at all and NOTHING
   * can be concluded from it: that is verify_unavailable, never silent_noop.
   */
  items?: VerifyInvoiceItem[] | null;
  subTotal?: number | string;
  total?: number | string;
  [key: string]: unknown;
}

/** Half a cent — invoice money is 2dp, so this is a pure float-noise guard. */
export const MONEY_EPSILON = 0.005;

export function moneyEquals(a: number, b: number): boolean {
  return Math.abs(a - b) <= MONEY_EPSILON;
}

/**
 * Coerce a read-side numeric field to a number, or undefined if absent/junk.
 *
 * ST RETURNS MONEY AND QUANTITY AS JSON *STRINGS* ON THE READ SIDE — live
 * reads this session show items[].price="-13674.00", cost="0.0000000000",
 * quantity="1.0000000000000000000", subTotal/total as strings too. A
 * `typeof v === 'number'` check therefore reads every live value as absent,
 * which made every successful nonzero write report amount_mismatch (and made
 * the null-overwrite baseline guard silently unable to fire). Accept both
 * number and numeric string; empty string and non-numeric junk → undefined.
 */
export function toMoney(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

/** Monetary value of a read-side invoice item, or undefined if ST sent none. */
export function itemPrice(item: VerifyInvoiceItem): number | undefined {
  return toMoney(item.price) ?? toMoney(item.unitPrice);
}

/** price × quantity for a read-side item; absent price/quantity counts as 0. */
export function itemAmount(item: VerifyInvoiceItem): number {
  const qty = toMoney(item.quantity) ?? 0;
  return (itemPrice(item) ?? 0) * qty;
}

/** unitPrice × quantity for a submitted (write-side) line. */
export function intendedAmount(line: { unitPrice?: number; quantity: number }): number {
  return (line.unitPrice ?? 0) * line.quantity;
}

/**
 * Read-after-write backoff schedule. Production default is the spec's
 * 2s → 10s; `env.VERIFY_BACKOFF_MS` overrides it (test seam).
 */
export function verifyBackoffMs(env: Env): number[] {
  const raw = env.VERIFY_BACKOFF_MS;
  if (Array.isArray(raw) && raw.every((n) => typeof n === 'number')) return raw;
  return [2000, 10000];
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Body-level failure check for the /api/st/write proxy. The REAL envelope
 * (taylor-ai gate-st.js handleSTWrite, verified against source 2026-07-31) is:
 *   success → { success: true, endpoint, method, response: <ST raw response> }
 *   failure → { error: "ST API 4xx"/message, ... } with a NON-2xx status
 * Failures normally arrive as non-2xx (resp.ok catches them), so this check is
 * defense-in-depth for any 200 whose body still signals failure — `success:
 * false`, an `error` string, or the legacy `ok: false` shape.
 */
export function proxyEnvelopeError(body: unknown): string | undefined {
  if (body === null || typeof body !== 'object') return undefined;
  const rec = body as Record<string, unknown>;
  if (rec.ok === false || rec.success === false || typeof rec.error === 'string') {
    const detail =
      typeof rec.error === 'string' ? rec.error :
      typeof rec.message === 'string' ? rec.message :
      JSON.stringify(rec).slice(0, 300);
    return `proxy returned HTTP 200 with a failure envelope: ${detail}`;
  }
  return undefined;
}

/**
 * Pull a created entity's id (invoice id, invoice-item id) out of whatever
 * shape ST/the proxy returned. Used to name what was written in error
 * messages — an id we learned and then dropped is an id someone has to hunt
 * for in the ST UI.
 *
 * THE REAL SHAPE (verified live 2026-07-31 + taylor-ai gate-st.js source): the
 * proxy wraps ST's response as { success, endpoint, method, response: <raw> },
 * and ST's POST /invoices (create adjustment) returns the new invoice id as a
 * BARE NUMBER — so the live create envelope is { ..., response: 84402274 }.
 * `rec.response` (bare number or {id}) is therefore the FIRST candidate; the
 * others cover direct-ST and test shapes. (The items PATCH returns an empty
 * body → { response: { raw: "" } } → correctly yields undefined here; the
 * line-item tool verifies by baseline diff instead.)
 */
export function extractEntityId(body: unknown): number | undefined {
  if (typeof body === 'number' || typeof body === 'string') {
    const n = Number(body);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  }
  if (body === null || typeof body !== 'object') return undefined;
  const rec = body as Record<string, unknown>;
  const response = rec.response;
  const candidates: unknown[] = [
    typeof response === 'number' || typeof response === 'string' ? response : undefined,
    (response as Record<string, unknown> | undefined)?.id,
    rec.id,
    rec.invoiceId,
    (rec.data as Record<string, unknown> | undefined)?.id,
    (rec.result as Record<string, unknown> | undefined)?.id,
    (rec.invoice as Record<string, unknown> | undefined)?.id,
  ];
  for (const c of candidates) {
    const n = Number(c);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return undefined;
}

export interface VerifyContext {
  actor: string;
  correlation: string;
}

/**
 * Re-read an invoice for verification, with the ids-honored guard and the
 * read-after-write backoff. Throws `verify_unavailable` (never silent_noop)
 * when the invoice cannot be observed — the write may still have landed, so
 * `stranded` MUST describe exactly what was written so the operator can find
 * it. The write is never re-sent from here.
 *
 * `accept` extends the backoff to ITEM-LEVEL lag: for a write against an
 * EXISTING invoice, the row itself is returned immediately on every read, so
 * without a predicate the backoff never engages and the caller's item
 * assertions run against a zero-delay, possibly stale read — turning ordinary
 * replication lag into a false silent_noop on a successful write. A returned
 * row that does not satisfy `accept` is treated like a miss and retried
 * through the same schedule. On exhaustion the LAST OBSERVED row is returned
 * anyway (the invoice WAS observed — the caller adjudicates silent_noop vs
 * amount_mismatch on real data); verify_unavailable is thrown only when no
 * valid row was ever observed.
 */
export async function reReadInvoiceForVerify(
  env: Env,
  ctx: VerifyContext,
  tenant: string,
  invoiceId: number,
  opts: { tool: string; stranded: string; accept?: (inv: VerifyInvoice) => boolean },
): Promise<VerifyInvoice> {
  const delays = verifyBackoffMs(env);
  let lastReason = 'invoice not returned by the verify-read';
  let lastObserved: VerifyInvoice | undefined;

  for (let attempt = 0; ; attempt++) {
    try {
      const data = await readST<{ data?: VerifyInvoice[] }>(
        env,
        ctx,
        `/accounting/v2/tenant/${tenant}/invoices`,
        { ids: invoiceId },
      );
      const row = data.data?.[0];
      if (row && Number(row.id) === invoiceId) {
        if (!opts.accept || opts.accept(row)) return row;
        lastObserved = row;
        lastReason = `invoice ${invoiceId} observed but the expected write effect is not visible yet (read-after-write lag)`;
      } else {
        // Same guard as the pre-write read: if ST ever stops honoring `ids`,
        // data[0] is an arbitrary invoice — verifying against it would be worse
        // than not verifying at all.
        lastReason = row
          ? `ids filter not honored on the verify-read: asked ${invoiceId}, got ${row.id}`
          : `invoice ${invoiceId} not present in the verify-read (empty data — the normal read-after-write-lag signature)`;
      }
    } catch (err) {
      lastReason = `verify-read failed: ${(err as Error).message}`;
    }

    if (attempt >= delays.length) break;
    await sleep(delays[attempt]);
  }

  // The row was seen but never satisfied `accept` — hand it to the caller for
  // a verdict on real observed data rather than hiding it behind
  // verify_unavailable.
  if (lastObserved) return lastObserved;

  throw new McpError(
    'verify_unavailable',
    `${opts.tool}: the write was sent and may have taken effect, but it could NOT be verified — ${lastReason}. ` +
      `${opts.stranded} Do NOT re-run this write; check ServiceTitan first (a retry would duplicate the line/invoice).`,
    { correlation: ctx.correlation, details: { invoiceId, reason: lastReason } },
  );
}
