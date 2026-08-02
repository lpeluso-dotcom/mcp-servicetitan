// ============================================================
// st_create_adjustment_invoice — create an adjustment invoice against a
// parent invoice (Posted/Exported only), per ST's own documented behavior
// (help.servicetitan.com/docs/create-an-adjustment-invoice).
// F3: dryRun=true (default) → confirmation_token → dryRun=false → write via
// /api/st/write (NOT durableWrite — the durable-write proxy only maps 4
// pricebook operations; there is no proxy-side mapping for invoice creation)
// → POST-WRITE VERIFY-READ (invoice-verify.ts). HTTP 200 from the proxy is
// NOT evidence the adjustment carries any money; the re-read is.
//
// ENDPOINT and BODY SHAPE are both CONFIRMED by live probing of prod tenant
// 431848990 (2026-07-31): POST /accounting/v2/tenant/{tid}/invoices.
//
// ┌──────────────────────────────────────────────────────────────────────┐
// │ WIRE CONTRACT — POST /accounting/v2/tenant/{tid}/invoices            │
// │ TOP LEVEL accepted:  adjustmentToId (REQUIRED), summary, items       │
// │ items[] accepted:    skuName, description, quantity, cost, unitPrice │
// │                                                                      │
// │ DANGER: ASP.NET model binding SILENTLY DROPS anything else and still │
// │ returns HTTP 200. Known-dropped, do NOT reintroduce:                 │
// │   top level — lineItems, invoiceItems, invoiceDate, businessUnitId   │
// │   items[]   — skuId, price, total, type, generalLedgerAccountId,     │
// │               businessUnitId, technicianId, serviceDate,             │
// │               membershipTypeId                                       │
// │ The outbound body is built from the explicit allow-list below rather │
// │ than spread from caller input, so a rename can't ride along unseen.  │
// │ The line-item schema is `.strict()`, so a dropped-field name arrives │
// │ as a LOUD validation error rather than being silently stripped.      │
// └──────────────────────────────────────────────────────────────────────┘
//
// TWO SILENT DROPS CAUSED REAL DAMAGE (both fixed here):
//  1. The line array is `items`, NOT `lineItems`. Sending `lineItems` created
//     adjustment invoice 84402274 against parent 83058736 with ZERO items and
//     a $0.00 total, behind an HTTP 200. It is not deletable via the API.
//  2. The monetary field is `unitPrice`, NOT `price`. `price` is dropped and
//     the line lands at $0.00. NEGATIVE unitPrice is allowed and is exactly
//     how an offsetting adjustment line is expressed (cf. real invoice
//     84399973, unit price -13674.00 on sku HI1). On the READ side ST returns
//     that value as `price` — the verify-read accounts for the asymmetry.
//
// SKU NAMES ARE RESOLVED BEFORE THE WRITE (sku-resolve.ts). On the items-PATCH
// endpoint an unresolvable SKU fails loudly (HTTP 500 "Sku (Name:) is not
// found."); HERE it fails silently — the line is dropped and the adjustment is
// created empty at $0.00, and it CANNOT be deleted via the API. A typo'd name
// is indistinguishable from a missing one to ST, so presence-validation is not
// enough: the name is checked against the D1 pricebook mirror first, and a
// definite miss is a validation_error at dryRun time, before any undeletable
// invoice exists. The check fails OPEN if the mirror is unreachable or empty
// (surfaced as skuResolution.unverified), so infrastructure trouble cannot
// block a legitimate write.
//
// ASYMMETRY vs. st_add_invoice_line_item: that endpoint ACCEPTS `skuId`; this
// one does NOT — adjustment lines resolve by `skuName` only. Do not unify the
// two item shapes.
// ============================================================

import { z } from 'zod';
import { McpError } from '../../errors';
import { WriteGate } from '../../write-gate';
import { readST } from '../../st';
import { rewriteTenantPlaceholders } from '../../tenant';
import { resolveSkuName, type SkuResolution } from './sku-resolve';
import {
  extractEntityId,
  intendedAmount,
  itemAmount,
  proxyEnvelopeError,
  reReadInvoiceForVerify,
} from './invoice-verify';
import type { Env } from '../../env';
import type { ToolDef } from '../index';

// NOTE: this tool's line-item shape is intentionally NOT shared with
// st_add_invoice_line_item's InvoiceLineItemInput. Both were live-probed
// 2026-07-31 and they genuinely differ: the items-PATCH endpoint accepts
// `skuId` and `technicianId`; this endpoint's items[] silently drops both and
// resolves the line by `skuName`. Unifying them would smuggle dropped fields
// onto one wire or wrongly forbid accepted fields on the other.
interface AdjustmentLineItemInput {
  skuName: string;
  description?: string;
  quantity: number;
  cost?: number;
  unitPrice?: number;
}

interface Args {
  parentInvoiceId: number;
  lineItems: AdjustmentLineItemInput[];
  summary?: string;
  offsetAmount?: number;
  dryRun?: boolean;
  confirmation_token?: string;
}

// .strict(): an unknown key is a LOUD validation error, not a silent strip.
// `price` and `skuId` are the two an LLM reaches for by reflex here, and both
// are silently discarded by ServiceTitan on this endpoint — accepting an input
// ST will drop is the exact pattern this file exists to repair.
const lineItemSchema = z.object({
  skuName: z.string().min(1).describe(
    'Pricebook SKU code/name (e.g. "HI1"). REQUIRED — ST resolves an adjustment line by SKU NAME. ' +
    'Unlike the invoice-items PATCH endpoint, `skuId` is silently IGNORED here. The name is checked ' +
    'against the pricebook before the write: an unresolvable name would be dropped by ST and produce ' +
    'an empty $0.00 adjustment invoice that cannot be deleted via the API.'
  ),
  description: z.string().optional().describe('Line description'),
  quantity: z.number().positive().describe('Line quantity'),
  cost: z.number().optional().describe('Line cost basis (not the sell amount — see unitPrice)'),
  unitPrice: z.number().optional().describe(
    'Sell price per unit — THE monetary field on this endpoint. ServiceTitan silently IGNORES a field named ' +
    '`price` (HTTP 200, $0.00 line). NEGATIVE values are allowed and are how an offsetting adjustment line is ' +
    'expressed — e.g. unitPrice: -13674 to back out revenue booked on the parent invoice. Omitting it creates ' +
    'the line at $0.00 (ST does not apply dynamic pricing to API-created invoice lines), which is almost never ' +
    'what an adjustment wants — the tool warns when it is omitted.'
  ),
  // TOMBSTONES. Declared only so they are REJECTED with a message naming the
  // replacement. .strict() alone would reject them with an opaque
  // "unrecognized key" error, and these two are precisely the names an LLM
  // reaches for: `price` (every pricebook tool uses it) and `skuId` (accepted
  // by the sibling items-PATCH endpoint, silently dropped by this one).
  price: z.any().optional().refine((v) => v === undefined, {
    message:
      '`price` is NOT a field on ServiceTitan\'s adjustment items[] model — ST silently drops it and the line lands at $0.00 behind an HTTP 200. Use `unitPrice` instead.',
  }).describe('DO NOT SEND — ST silently drops `price` and the line lands at $0.00. Use `unitPrice`. Any value is rejected.'),
  skuId: z.any().optional().refine((v) => v === undefined, {
    message:
      '`skuId` is silently IGNORED by this endpoint (unlike the invoice-items PATCH endpoint, which accepts it) — ServiceTitan resolves an adjustment line by SKU NAME. Use `skuName` instead; a line ST cannot resolve is dropped and yields an empty $0.00 adjustment invoice that is not deletable via the API.',
  }).describe('DO NOT SEND — ST resolves adjustment lines by SKU NAME only and silently drops skuId. Use `skuName`. Any value is rejected.'),
}).strict();

// Explicit allow-list of the fields ST actually binds on an adjustment items[]
// element. The outbound body is BUILT from this list, never spread from caller
// input, so nothing outside the confirmed set can reach the wire and be
// silently discarded. Adding a name here is a claim that it was live-probed.
// The `keyof` annotation is the cheap fail-loudly mechanism: renaming a field
// on AdjustmentLineItemInput without updating this list is a COMPILE error,
// not a silent HTTP 200 that creates an empty $0.00 adjustment invoice.
const ST_ADJUSTMENT_ITEM_FIELDS: readonly (keyof AdjustmentLineItemInput)[] = [
  'skuName', 'description', 'quantity', 'cost', 'unitPrice',
];

// Deletion guard: `keyof` above catches RENAMES but not DELETIONS — removing a
// name from the list still typechecks and silently stops sending that field
// (the same silent-no-op class). This makes a deletion a compile error too.
type _AdjFieldsComplete =
  Exclude<keyof AdjustmentLineItemInput, (typeof ST_ADJUSTMENT_ITEM_FIELDS)[number]> extends never ? true : never;
const _adjFieldsComplete: _AdjFieldsComplete = true;
void _adjFieldsComplete;

function toStAdjustmentItemPayload(item: AdjustmentLineItemInput): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of ST_ADJUSTMENT_ITEM_FIELDS) {
    const value = item[field];
    if (value !== undefined) out[field] = value;
  }
  return out;
}

interface RawInvoice {
  id?: number;
  syncStatus?: string;
  adjustmentToId?: number | null;
  [key: string]: unknown;
}

function validateLineItems(lineItems: AdjustmentLineItemInput[], correlation: string): void {
  if (!lineItems || lineItems.length === 0) {
    throw new McpError('validation_error', 'st_create_adjustment_invoice requires at least one line item', { correlation });
  }
  // CONFIRMED 2026-07-31: this endpoint's items[] ignores `skuId` entirely and
  // resolves the line by SKU name. Without skuName ST has nothing to resolve
  // and the line is dropped, yielding a $0.00 zero-item adjustment invoice
  // behind an HTTP 200 (see file header). Reject locally instead.
  for (const [i, item] of lineItems.entries()) {
    if (!item.skuName) {
      throw new McpError(
        'validation_error',
        `lineItems[${i}]: skuName is required — ServiceTitan resolves adjustment lines by SKU name and silently ignores skuId on this endpoint. Without skuName the line is dropped and the adjustment invoice is created empty at $0.00.`,
        { correlation }
      );
    }
  }
}

/**
 * Resolve every line's skuName against the D1 pricebook mirror. A definite
 * miss is a hard validation_error BEFORE the write, because the alternative
 * is an undeletable empty $0.00 adjustment invoice. An unavailable mirror is
 * NOT a block — it is reported back so the caller knows the check did not run.
 */
async function checkSkuNames(
  env: Env,
  lineItems: AdjustmentLineItemInput[],
  correlation: string,
): Promise<{ resolved: SkuResolution[]; unverified: SkuResolution[] }> {
  const resolved: SkuResolution[] = [];
  const unverified: SkuResolution[] = [];
  for (const [i, item] of lineItems.entries()) {
    const res = await resolveSkuName(env, item.skuName, correlation);
    if (res.status === 'not_found') {
      throw new McpError(
        'validation_error',
        `lineItems[${i}]: skuName "${item.skuName}" does not exist in the pricebook (checked pb_services / pb_materials / pb_equipment, including case and hyphen variants). ServiceTitan resolves adjustment lines by SKU NAME and silently DROPS a line whose name it cannot resolve — the result is an adjustment invoice with zero items at $0.00, behind an HTTP 200, which is NOT deletable via the API (see 84402274). Use search_pricebook_all / search_pricebook_services to find the exact code.`,
        { correlation, details: { index: i, skuName: item.skuName } },
      );
    }
    if (res.status === 'unavailable') unverified.push(res);
    else resolved.push(res);
  }
  return { resolved, unverified };
}

export const st_create_adjustment_invoice: ToolDef<Args> = {
  name: 'st_create_adjustment_invoice',
  description:
    'Create an adjustment invoice against a parent invoice (must be Posted or Exported). ' +
    'dryRun=true (default) validates and returns a confirmation_token — call again with dryRun=false + token to write. ' +
    'Each line needs skuName (skuId is silently ignored by this endpoint) and unitPrice for the dollar amount — a field ' +
    'named `price` is silently ignored and yields a $0.00 adjustment. skuName is resolved against the pricebook before ' +
    'the write and an unknown name is rejected, because ST would silently drop the line and create an empty $0.00 ' +
    'adjustment. Adjustment lines are typically NEGATIVE unitPrice to offset revenue, but sign is not enforced. ' +
    'ENDPOINT and BODY SHAPE are both live-confirmed (2026-07-31): ' +
    'POST /accounting/v2/tenant/{tid}/invoices with {adjustmentToId, summary?, items[]}. NOTE: ServiceTitan ignores a ' +
    'business unit or invoice date on this call — the adjustment inherits the parent invoice\'s BU and is dated by ST — ' +
    'so this tool has no businessUnitId/invoiceDate argument. Unknown line fields are rejected, not stripped. After the ' +
    'write the tool RE-READS the created invoice and asserts the items and the total actually landed (silent_noop / ' +
    'amount_mismatch / verify_unavailable, always naming the created invoice id) — HTTP 200 is not proof. Adjustment ' +
    'invoices are NOT deletable via the API; a mistake has to be corrected in the ServiceTitan UI, so review the dryRun ' +
    'preview carefully before confirming. Source: live ST.',
  isWrite: true,
  stEndpoint: { method: 'POST', path: '/accounting/v2/tenant/{tid}/invoices', source: 'live' },
  zodSchema: {
    parentInvoiceId: z.number().int().positive().describe('ST invoice ID being adjusted'),
    lineItems: z.array(lineItemSchema).min(1).describe('Adjustment line items — sent to ST as `items`; typically negative unitPrice to offset revenue'),
    summary: z.string().optional().describe('Invoice summary/memo — accepted at the top level by ST (e.g. why the adjustment exists)'),
    offsetAmount: z.number().optional().describe('If provided, warns (does not block) when the lineItems total does not net this amount to zero'),
    dryRun: z.boolean().default(true).describe('true (default) = preview + token; false = execute write'),
    confirmation_token: z.string().optional().describe('Token from prior dryRun=true call, required when dryRun=false'),
    // TOMBSTONED TOP-LEVEL ARGS. ST silently ignores both on this endpoint, so
    // quietly stripping them would tell the caller their business unit / date
    // took effect when it did not — the same silent-no-op UX, one layer up.
    businessUnitId: z.any().optional().refine((v) => v === undefined, {
      message:
        'businessUnitId was removed 2026-07-31: ServiceTitan silently ignores it on POST /invoices — the adjustment inherits the parent invoice\'s business unit. Do not send it.',
    }).describe('DO NOT SEND — removed 2026-07-31; ST silently ignores it and the adjustment inherits the parent invoice\'s business unit. Any value is rejected.'),
    invoiceDate: z.any().optional().refine((v) => v === undefined, {
      message:
        'invoiceDate was removed 2026-07-31: ServiceTitan silently ignores it on POST /invoices — the adjustment inherits the parent invoice\'s dating and is dated by ST. Do not send it.',
    }).describe('DO NOT SEND — removed 2026-07-31; ST silently ignores it and dates the adjustment itself. Any value is rejected.'),
  },
  async handler(env, args, { actor, correlation }) {
    const { parentInvoiceId, lineItems, summary, offsetAmount, dryRun = true, confirmation_token } = args;
    validateLineItems(lineItems, correlation);
    // Runs on BOTH phases: a SKU that disappears between preview and confirm
    // must not slip through into an undeletable empty adjustment.
    const skuResolution = await checkSkuNames(env, lineItems, correlation);

    const tenant = env.ST_TENANT_ID;
    const parentData = await readST<{ data?: RawInvoice[] }>(
      env, { actor, correlation },
      `/accounting/v2/tenant/${tenant}/invoices`,
      { ids: parentInvoiceId },
    );
    const parent = parentData.data?.[0];
    if (!parent) throw new McpError('not_found', `invoice ${parentInvoiceId} not found`, { correlation });
    // Guard: this endpoint has a documented history of silently ignoring
    // params (see balanceExcludeZero in list_unpaid_invoices). If ST ever
    // ignores `ids`, data[0] would be an arbitrary invoice — fail loudly
    // instead of authorizing an adjustment against the wrong invoice.
    if (Number(parent.id) !== parentInvoiceId)
      throw new McpError('upstream_error', `ids filter not honored: asked ${parentInvoiceId}, got ${parent.id}`, { correlation });

    if (parent.syncStatus !== 'Posted' && parent.syncStatus !== 'Exported') {
      throw new McpError(
        'validation_error',
        `invoice ${parentInvoiceId} has syncStatus=${parent.syncStatus} — adjustment invoices can only be created against Posted or Exported invoices`,
        { correlation }
      );
    }
    if (parent.adjustmentToId) {
      throw new McpError(
        'validation_error',
        `invoice ${parentInvoiceId} is itself an adjustment invoice (adjustmentToId=${parent.adjustmentToId}) — adjustment-of-adjustment chains are not supported`,
        { correlation }
      );
    }

    const warnings: string[] = [];
    // An adjustment line with no unitPrice is created at $0.00 — ST does not
    // apply dynamic pricing to API-created lines (confirmed on the sibling
    // endpoint by item 84402146). A $0.00 adjustment offsets nothing.
    lineItems.forEach((li, i) => {
      if (li.unitPrice === undefined) {
        warnings.push(
          `lineItems[${i}] (${li.skuName}): no unitPrice — ServiceTitan will create this adjustment line at $0.00 (no dynamic pricing on API-created lines), so it will not offset anything. Pass an explicit (usually negative) unitPrice.`
        );
      }
    });
    if (offsetAmount !== undefined) {
      const lineTotal = lineItems.reduce((sum, li) => sum + (li.unitPrice ?? 0) * li.quantity, 0);
      if (Math.abs(lineTotal + offsetAmount) > 0.01) {
        warnings.push(`adjustment line total (${lineTotal}) does not net offsetAmount (${offsetAmount}) to zero — informational only, not all adjustments are full offsets`);
      }
    }

    // Built from the allow-list, NOT spread from args. `items` is the confirmed
    // top-level array name — `lineItems` is silently dropped by ST and creates
    // an empty $0.00 adjustment invoice behind an HTTP 200.
    const payload: Record<string, unknown> = {
      adjustmentToId: parentInvoiceId,
      ...(summary !== undefined ? { summary } : {}),
      items: lineItems.map(toStAdjustmentItemPayload),
    };

    // TOCTOU guard: fold read-derived parent state into the hashed args so a
    // material change between the dryRun preview and the confirm call (e.g.
    // the parent's syncStatus or adjustmentToId changes) invalidates the token
    // via the existing "args changed since dryRun" path in WriteGate.verifyToken.
    // `wireContract` pins the args→wire transformation VERSION into the hash:
    // WriteGate.hashArgs drops undefined values, so an arg-shape change across
    // a deploy (businessUnitId/invoiceDate removed, summary added, lineItems →
    // items) is hash-INVISIBLE when the optionals are absent — a token minted
    // by the old deployed code would verify here and execute a wire body the
    // human never previewed (and vice versa on rollback). Bump this string any
    // time the outbound payload construction changes.
    const businessArgs = {
      wireContract: 'adjustment-items-v2-2026-07-31',
      parentInvoiceId, lineItems, summary, offsetAmount,
      syncStatus: parent.syncStatus, adjustmentToId: parent.adjustmentToId,
    };
    const gate = new WriteGate(env);
    const endpoint = `/accounting/v2/tenant/000000000/invoices`;

    if (dryRun) {
      const result = await gate.dryRun('st_create_adjustment_invoice', businessArgs, actor, correlation, payload, endpoint, 'POST', 15 * 60 * 1000);
      return { ...result, warnings, skuResolution };
    }
    if (!confirmation_token) {
      throw new McpError('validation_error', 'confirmation_token required when dryRun=false', { correlation });
    }
    await gate.verifyToken('st_create_adjustment_invoice', businessArgs, actor, confirmation_token);

    const resp = await env.ST_PROXY.fetch('https://servicetitan-proxy/api/st/write', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-sync-key': env.MCP_SYNC_KEY,
        'x-correlation-id': correlation,
        'x-actor': actor,
      },
      body: JSON.stringify({ endpoint: rewriteTenantPlaceholders(env, endpoint), method: 'POST', payload }),
    });
    if (!resp.ok) {
      // The proxy's failure body carries the ST error message ({error: "ST
      // API 4xx …"}) — surface it; a bare status number is useless during a
      // money incident.
      const text = await resp.text().catch(() => '');
      throw new McpError(
        'upstream_error',
        `st_create_adjustment_invoice failed: ${resp.status}${text ? ` — ${text.slice(0, 600)}` : ''}`,
        { correlation, details: { status: resp.status, body: text.slice(0, 600) } },
      );
    }
    const result = await resp.json().catch(() => null);
    // A 200 carrying an {ok:false} envelope is a failure the status code does
    // not show — the proxy's status is not ServiceTitan's outcome.
    const envelopeError = proxyEnvelopeError(result);
    if (envelopeError) {
      throw new McpError('upstream_error', `st_create_adjustment_invoice failed: ${envelopeError}`, { correlation, details: { result } });
    }

    // ── POST-WRITE VERIFY-READ ────────────────────────────────
    // The create returned 200. That proves nothing about items or dollars:
    // 84402274 was created by a 200 and carried zero items at $0.00. Every
    // failure below NAMES the created invoice id — adjustment invoices cannot
    // be deleted through the API, so a stray one that nobody can name is the
    // worst outcome this tool has.
    const createdId = extractEntityId(result);
    const expectedTotal = lineItems.reduce((sum, li) => sum + intendedAmount(li), 0);
    if (createdId === undefined) {
      throw new McpError(
        'verify_unavailable',
        `st_create_adjustment_invoice: ServiceTitan returned HTTP 200 but no invoice id, so the adjustment against parent ${parentInvoiceId} could NOT be verified. AN ADJUSTMENT INVOICE MAY EXIST and adjustment invoices are not deletable via the API — find it in ServiceTitan under parent ${parentInvoiceId} before re-running, or a retry will create a second one. Raw response: ${JSON.stringify(result).slice(0, 500)}`,
        { correlation, details: { parentInvoiceId, result } },
      );
    }

    const stranded = `Adjustment invoice ${createdId} WAS created against parent ${parentInvoiceId} and is NOT deletable via the ST API — correct it in the ServiceTitan UI.`;
    // accept: retry through the backoff until the created invoice's items are
    // visible (a brand-new invoice can surface in the list before its lines
    // finish propagating). On exhaustion the last observed row is adjudicated
    // below rather than hidden behind verify_unavailable.
    const post = await reReadInvoiceForVerify(env, { actor, correlation }, tenant, createdId, {
      tool: 'st_create_adjustment_invoice',
      stranded,
      accept: (inv) => Array.isArray(inv.items) && inv.items.length >= lineItems.length,
    });

    const items = post.items;
    if (items === undefined) {
      throw new McpError(
        'verify_unavailable',
        `st_create_adjustment_invoice: adjustment invoice ${createdId} was created but the verify-read carried no items field, so its contents could not be confirmed. ${stranded}`,
        { correlation, details: { adjustmentInvoiceId: createdId, parentInvoiceId, result } },
      );
    }
    if (items === null || items.length === 0) {
      throw new McpError(
        'silent_noop',
        `st_create_adjustment_invoice: adjustment invoice ${createdId} was created against parent ${parentInvoiceId} but has ZERO line items — ServiceTitan accepted the request and dropped every line (this is exactly the 84402274 failure: HTTP 200, items null, total $0.00). ${stranded} Expected ${lineItems.length} line(s) totalling ${expectedTotal}.`,
        { correlation, details: { adjustmentInvoiceId: createdId, parentInvoiceId, expectedItems: lineItems.length, expectedTotal, result } },
      );
    }
    if (items.length !== lineItems.length) {
      throw new McpError(
        'silent_noop',
        `st_create_adjustment_invoice: adjustment invoice ${createdId} carries ${items.length} line item(s) but ${lineItems.length} were submitted — ServiceTitan dropped ${lineItems.length - items.length} line(s) silently (an unresolvable skuName does this). ${stranded}`,
        { correlation, details: { adjustmentInvoiceId: createdId, parentInvoiceId, submitted: lineItems.length, landed: items.length, result } },
      );
    }

    const actualTotal = items.reduce((sum, it) => sum + itemAmount(it), 0);
    if (Math.abs(actualTotal - expectedTotal) > 0.005) {
      throw new McpError(
        'amount_mismatch',
        `st_create_adjustment_invoice: adjustment invoice ${createdId} has all ${items.length} line(s) but the money is wrong — sent ${expectedTotal}, ServiceTitan persisted ${actualTotal}. The offset will NOT net the parent invoice. ${stranded}`,
        { correlation, details: { adjustmentInvoiceId: createdId, parentInvoiceId, expected: expectedTotal, actual: actualTotal, result } },
      );
    }

    return {
      dryRun: false,
      tool: 'st_create_adjustment_invoice',
      verified: true,
      adjustmentInvoiceId: createdId,
      result,
      verification: {
        adjustmentInvoiceId: createdId,
        parentInvoiceId,
        itemsSubmitted: lineItems.length,
        itemsLanded: items.length,
        expectedTotal,
        actualTotal,
        invoiceSubTotal: post.subTotal,
        invoiceTotal: post.total,
      },
      warnings,
      skuResolution,
      correlation,
    };
  },
};
