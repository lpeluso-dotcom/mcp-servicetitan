// ============================================================
// st_create_adjustment_invoice — create an adjustment invoice against a
// parent invoice (Posted/Exported only), per ST's own documented behavior
// (help.servicetitan.com/docs/create-an-adjustment-invoice).
// F3: dryRun=true (default) → confirmation_token → dryRun=false → write via
// /api/st/write (NOT durableWrite — the durable-write proxy only maps 4
// pricebook operations; there is no proxy-side mapping for invoice creation).
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
// └──────────────────────────────────────────────────────────────────────┘
//
// TWO SILENT DROPS CAUSED REAL DAMAGE (both fixed here):
//  1. The line array is `items`, NOT `lineItems`. Sending `lineItems` created
//     adjustment invoice 84402274 against parent 83058736 with ZERO items and
//     a $0.00 total, behind an HTTP 200. It is not deletable via the API.
//  2. The monetary field is `unitPrice`, NOT `price`. `price` is dropped and
//     the line lands at $0.00. NEGATIVE unitPrice is allowed and is exactly
//     how an offsetting adjustment line is expressed (cf. real invoice
//     84399973, unit price -13674.00 on sku HI1).
//
// ASYMMETRY vs. st_add_invoice_line_item: that endpoint ACCEPTS `skuId`;
// this one does NOT — adjustment lines resolve by `skuName` only. Do not
// unify the two item shapes.
// ============================================================

import { z } from 'zod';
import { McpError } from '../../errors';
import { WriteGate } from '../../write-gate';
import { readST } from '../../st';
import { rewriteTenantPlaceholders } from '../../tenant';
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

const lineItemSchema = z.object({
  skuName: z.string().min(1).describe(
    'Pricebook SKU code/name (e.g. "HI1"). REQUIRED — ST resolves an adjustment line by SKU NAME. ' +
    'Unlike the invoice-items PATCH endpoint, `skuId` is silently IGNORED here.'
  ),
  description: z.string().optional().describe('Line description'),
  quantity: z.number().positive().describe('Line quantity'),
  cost: z.number().optional().describe('Line cost basis (not the sell amount — see unitPrice)'),
  unitPrice: z.number().optional().describe(
    'Sell price per unit — THE monetary field on this endpoint. ServiceTitan silently IGNORES a field named ' +
    '`price` (HTTP 200, $0.00 line). NEGATIVE values are allowed and are how an offsetting adjustment line is ' +
    'expressed — e.g. unitPrice: -13674 to back out revenue booked on the parent invoice.'
  ),
});

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

export const st_create_adjustment_invoice: ToolDef<Args> = {
  name: 'st_create_adjustment_invoice',
  description:
    'Create an adjustment invoice against a parent invoice (must be Posted or Exported). ' +
    'dryRun=true (default) validates and returns a confirmation_token — call again with dryRun=false + token to write. ' +
    'Each line needs skuName (skuId is silently ignored by this endpoint) and unitPrice for the dollar amount — a field ' +
    'named `price` is silently ignored and yields a $0.00 adjustment. Adjustment lines are typically NEGATIVE unitPrice ' +
    'to offset revenue, but sign is not enforced. ENDPOINT and BODY SHAPE are both live-confirmed (2026-07-31): ' +
    'POST /accounting/v2/tenant/{tid}/invoices with {adjustmentToId, summary?, items[]}. NOTE: ServiceTitan ignores a ' +
    'business unit or invoice date on this call — the adjustment inherits the parent invoice\'s BU and is dated by ST — ' +
    'so this tool has no businessUnitId/invoiceDate argument. Adjustment invoices are NOT deletable via the API; a ' +
    'mistake has to be corrected in the ServiceTitan UI, so review the dryRun preview carefully before confirming.',
  isWrite: true,
  stEndpoint: { method: 'POST', path: '/accounting/v2/tenant/{tid}/invoices', source: 'live' },
  zodSchema: {
    parentInvoiceId: z.number().int().positive().describe('ST invoice ID being adjusted'),
    lineItems: z.array(lineItemSchema).min(1).describe('Adjustment line items — sent to ST as `items`; typically negative unitPrice to offset revenue'),
    summary: z.string().optional().describe('Invoice summary/memo — accepted at the top level by ST (e.g. why the adjustment exists)'),
    offsetAmount: z.number().optional().describe('If provided, warns (does not block) when the lineItems total does not net this amount to zero'),
    dryRun: z.boolean().default(true).describe('true (default) = preview + token; false = execute write'),
    confirmation_token: z.string().optional().describe('Token from prior dryRun=true call, required when dryRun=false'),
  },
  async handler(env, args, { actor, correlation }) {
    const { parentInvoiceId, lineItems, summary, offsetAmount, dryRun = true, confirmation_token } = args;
    validateLineItems(lineItems, correlation);

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
      ...(summary ? { summary } : {}),
      items: lineItems.map(toStAdjustmentItemPayload),
    };

    // TOCTOU guard: fold read-derived parent state into the hashed args so a
    // material change between the dryRun preview and the confirm call (e.g.
    // the parent's syncStatus or adjustmentToId changes) invalidates the token
    // via the existing "args changed since dryRun" path in WriteGate.verifyToken.
    const businessArgs = {
      parentInvoiceId, lineItems, summary, offsetAmount,
      syncStatus: parent.syncStatus, adjustmentToId: parent.adjustmentToId,
    };
    const gate = new WriteGate(env);
    const endpoint = `/accounting/v2/tenant/000000000/invoices`;

    if (dryRun) {
      const result = await gate.dryRun('st_create_adjustment_invoice', businessArgs, actor, correlation, payload, endpoint, 'POST', 15 * 60 * 1000);
      return { ...result, warnings };
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
      throw new McpError('upstream_error', `st_create_adjustment_invoice failed: ${resp.status}`, { correlation });
    }
    const result = await resp.json();
    return { dryRun: false, tool: 'st_create_adjustment_invoice', result, correlation };
  },
};
