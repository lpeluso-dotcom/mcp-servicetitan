// ============================================================
// st_create_adjustment_invoice — create an adjustment invoice against a
// parent invoice (Posted/Exported only), per ST's own documented behavior
// (help.servicetitan.com/docs/create-an-adjustment-invoice).
// F3: dryRun=true (default) → confirmation_token → dryRun=false → write via
// /api/st/write (NOT durableWrite — the durable-write proxy only maps 4
// pricebook operations; there is no proxy-side mapping for invoice creation).
//
// ENDPOINT is now CONFIRMED from the real ST Accounting v2 API catalog
// (2026-07-31): POST /accounting/v2/tenant/{tid}/invoices, documented there
// as "create adjustment invoice." The live write path below is now enabled.
//
// The request BODY SHAPE is still UNCONFIRMED — the catalog gives paths/verbs
// only, no request schemas. This tool's payload is a best-guess informed by
// the one confirmed real field (`adjustmentToId`, seen live on GET responses).
// Treat the payload shape as provisional until a live sandbox write confirms
// it round-trips cleanly.
// ============================================================

import { z } from 'zod';
import { McpError } from '../../errors';
import { WriteGate } from '../../write-gate';
import { readST } from '../../st';
import { rewriteTenantPlaceholders } from '../../tenant';
import type { ToolDef } from '../index';
import type { InvoiceLineItemInput } from './st_add_invoice_line_item';

interface Args {
  parentInvoiceId: number;
  lineItems: InvoiceLineItemInput[];
  businessUnitId?: number;
  invoiceDate?: string;
  offsetAmount?: number;
  dryRun?: boolean;
  confirmation_token?: string;
}

const lineItemSchema = z.object({
  skuId: z.number().int().positive().optional(),
  skuName: z.string().optional(),
  description: z.string().optional(),
  quantity: z.number().positive(),
  price: z.number().optional(),
  cost: z.number().optional(),
  generalLedgerAccountId: z.number().int().positive().optional(),
  businessUnitId: z.number().int().positive().optional(),
  type: z.enum(['Service', 'Material', 'Equipment']).optional(),
});

interface RawInvoice {
  id?: number;
  syncStatus?: string;
  adjustmentToId?: number | null;
  businessUnit?: { id?: number };
  [key: string]: unknown;
}

function validateLineItems(lineItems: InvoiceLineItemInput[], correlation: string): void {
  if (!lineItems || lineItems.length === 0) {
    throw new McpError('validation_error', 'st_create_adjustment_invoice requires at least one line item', { correlation });
  }
  for (const [i, item] of lineItems.entries()) {
    if (item.type === 'Equipment' && (item.price === undefined || item.cost === undefined)) {
      throw new McpError(
        'validation_error',
        `lineItems[${i}]: Equipment line items require both price and cost (QSC equipment is statically priced)`,
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
    'Adjustment lines are typically negative to offset revenue, but sign is not enforced. ' +
    'ENDPOINT is confirmed (ST Accounting v2 API catalog: POST /accounting/v2/tenant/{tid}/invoices); ' +
    'the request BODY SHAPE is not confirmed — treat the payload as a best guess until verified against a live sandbox write.',
  isWrite: true,
  stEndpoint: { method: 'POST', path: '/accounting/v2/tenant/{tid}/invoices', source: 'live' },
  zodSchema: {
    parentInvoiceId: z.number().int().positive().describe('ST invoice ID being adjusted'),
    lineItems: z.array(lineItemSchema).min(1).describe('Adjustment line items — typically negative to offset revenue'),
    businessUnitId: z.number().int().positive().optional().describe('Defaults to the parent invoice\'s business unit'),
    invoiceDate: z.string().optional().describe('Defaults to today (ISO date)'),
    offsetAmount: z.number().optional().describe('If provided, warns (does not block) when lineItems totals do not net this amount to zero'),
    dryRun: z.boolean().default(true).describe('true (default) = preview + token; false = execute write'),
    confirmation_token: z.string().optional().describe('Token from prior dryRun=true call, required when dryRun=false'),
  },
  async handler(env, args, { actor, correlation }) {
    const { parentInvoiceId, lineItems, businessUnitId, invoiceDate, offsetAmount, dryRun = true, confirmation_token } = args;
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
      const lineTotal = lineItems.reduce((sum, li) => sum + (li.price ?? 0) * li.quantity, 0);
      if (Math.abs(lineTotal + offsetAmount) > 0.01) {
        warnings.push(`adjustment line total (${lineTotal}) does not net offsetAmount (${offsetAmount}) to zero — informational only, not all adjustments are full offsets`);
      }
    }

    const resolvedBusinessUnitId = businessUnitId ?? parent.businessUnit?.id;
    const payload: Record<string, unknown> = {
      adjustmentToId: parentInvoiceId,
      lineItems,
      ...(resolvedBusinessUnitId !== undefined ? { businessUnitId: resolvedBusinessUnitId } : {}),
      ...(invoiceDate ? { invoiceDate } : {}),
    };

    // TOCTOU guard: fold read-derived parent state into the hashed args so a
    // material change between the dryRun preview and the confirm call (e.g.
    // the parent's syncStatus or adjustmentToId changes) invalidates the token
    // via the existing "args changed since dryRun" path in WriteGate.verifyToken.
    const businessArgs = {
      parentInvoiceId, lineItems, businessUnitId, invoiceDate, offsetAmount,
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
