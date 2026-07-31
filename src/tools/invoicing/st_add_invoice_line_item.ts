// ============================================================
// st_add_invoice_line_item — add or update line item(s) on an existing
// ServiceTitan invoice.
//
// ENDPOINT + BODY SHAPE are now CONFIRMED by live probing of prod tenant
// 431848990 (2026-07-31) — a 400 response leaked the controller signature:
//   InvoicesController.UpdateInvoiceItemsAsync(Int64 invoiceId, InvoiceItemUpdateRequest itemModel)
// i.e.
//   PATCH /accounting/v2/tenant/{tid}/invoices/{invoiceId}/items
// takes a FLAT SINGLE-ITEM object (`InvoiceItemUpdateRequest`) as its body —
// NOT `{ items: [...] }` and NOT an array. ONE item per HTTP call. Adding N
// line items means N sequential PATCH calls to the same endpoint.
//
// Confirmed real fields on InvoiceItemUpdateRequest (each bind-errors when
// given a wrong-typed value during probing):
//   id            nullable number  — see below re: append vs update
//   skuId         nullable number
//   skuName       string
//   description   string, REQUIRED
//   quantity      number, REQUIRED
//   cost          number
//   technicianId  nullable number
//
// Confirmed NOT to exist on this model (silently ignored by ASP.NET model
// binding — no bind error even with an object/array value): price,
// generalLedgerAccountId, businessUnitId, type, itemType, taxable, inventory,
// isChargeable, order, serviceDate, installedEquipmentId, total, memberPrice,
// invoiceId. In particular: `price` is NOT settable on an invoice item via
// this endpoint. That is consistent with QSC's dynamic pricing (ServiceTitan
// computes the sell price at invoice time) — any validation that assumed a
// caller-supplied price was meaningful here was wrong and has been removed.
//
// JOB-LINK REASSIGNMENT VIA THE API IS CONFIRMED IMPOSSIBLE. The parent
// invoice update endpoint, PATCH /accounting/v2/tenant/{tid}/invoices/{id},
// was also probed live: its update model contains ONLY `summary`, `dueDate`,
// `reviewStatus`. Fields like `job`, `jobId`, `invoiceConfiguration`,
// `businessUnitId`, `customerId` are NOT in that model — ST silently ignores
// them and returns HTTP 200 while doing nothing. There is therefore no API
// path to move an invoice onto a different job after creation. This tool
// dropped the jobId arg, the job lookup, the cross-customer check, and the
// second PATCH call entirely rather than ship a feature that reports success
// while silently no-op'ing. Callers need an invoice that is ALREADY linked
// to the target job.
//
// ONE THING REMAINS UNCONFIRMED: whether omitting `id` on a call APPENDS a
// new line item (vs. being rejected, or requiring some other signal). This
// is inferred from the field being nullable and named like an identifier,
// not verified against a live invoice. It is safely testable, though: ST
// exposes DELETE /accounting/v2/tenant/{tid}/invoices/{invoiceId}/items/{itemId}
// for manual cleanup, so an append probe (PATCH without `id`, confirm a new
// item landed, then DELETE it) is fully reversible whenever someone wants to
// close this out.
//
// F3: dryRun=true (default) → confirmation_token → dryRun=false → N
// sequential live calls over /api/st/write (NOT durableWrite — the
// durable-write proxy only maps 4 pricebook operations; there is no
// proxy-side mapping for invoice line items, so that path would 404/no-op
// silently).
// ============================================================

import { z } from 'zod';
import { McpError } from '../../errors';
import { WriteGate } from '../../write-gate';
import { readST } from '../../st';
import { rewriteTenantPlaceholders } from '../../tenant';
import type { ToolDef } from '../index';
import type { Env } from '../../env';

export interface InvoiceLineItemInput {
  id?: number;
  skuId?: number;
  skuName?: string;
  description: string;
  quantity: number;
  cost?: number;
  technicianId?: number;
}

interface Args {
  invoiceId: number;
  lineItems: InvoiceLineItemInput[];
  dryRun?: boolean;
  confirmation_token?: string;
}

const lineItemSchema = z.object({
  id: z.number().int().positive().optional().describe(
    'Existing ST invoice-item ID to update. Omit to append a new line item — that append-on-omit ' +
    'behavior is INFERRED from the field being nullable, not yet confirmed against a live invoice.'
  ),
  skuId: z.number().int().positive().optional().describe('Pricebook SKU ID for this line item'),
  skuName: z.string().optional().describe('SKU display name'),
  description: z.string().min(1).describe('Line item description (required by the ST update model)'),
  quantity: z.number().positive().describe('Line item quantity (required by the ST update model)'),
  cost: z.number().optional().describe('Line item cost. Sell price is NOT settable here — QSC uses dynamic pricing and ST computes price at invoice time.'),
  technicianId: z.number().int().positive().optional().describe('Technician ID to attribute this line item to'),
});

interface RawInvoice {
  id?: number;
  syncStatus?: string;
  customer?: { id?: number };
  [key: string]: unknown;
}

function validateLineItems(lineItems: InvoiceLineItemInput[], correlation: string): void {
  if (!lineItems || lineItems.length === 0) {
    throw new McpError('validation_error', 'st_add_invoice_line_item requires at least one line item', { correlation });
  }
  // CONFIRMED by live probe 2026-07-31 (invoice 82555119): omitting `id` routes
  // to ST's UpdateInvoiceItemHandler.CreateInvoiceItemAsync — the append path —
  // which requires a SKU to resolve the item. Without skuId/skuName ST returns
  // HTTP 500 "Sku (Name:) is not found." Reject locally rather than let a 500
  // through; an item WITH `id` is an update and needs no sku.
  for (const [i, item] of lineItems.entries()) {
    const isAppend = item.id === undefined;
    if (isAppend && item.skuId === undefined && item.skuName === undefined) {
      throw new McpError(
        'validation_error',
        `lineItems[${i}]: appending a new invoice item (no \`id\`) requires skuId or skuName — ST resolves the item by SKU and returns 500 "Sku (Name:) is not found." otherwise. Pass \`id\` instead to update an existing item.`,
        { correlation }
      );
    }
  }
}

// Sends a single ST write call via the servicetitan-proxy /api/st/write path
// (the raw {endpoint, method, payload} path — see write-tool-factory.ts /
// assign_technicians.ts precedent). Not durableWrite: there is no proxy-side
// operation mapping for invoice writes.
async function stWrite(
  env: Env,
  ctx: { actor: string; correlation: string },
  endpoint: string,
  method: string,
  payload: unknown
): Promise<Response> {
  return env.ST_PROXY.fetch('https://servicetitan-proxy/api/st/write', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-sync-key': env.MCP_SYNC_KEY,
      'x-correlation-id': ctx.correlation,
      'x-actor': ctx.actor,
    },
    body: JSON.stringify({ endpoint, method, payload }),
  });
}

export const st_add_invoice_line_item: ToolDef<Args> = {
  name: 'st_add_invoice_line_item',
  description:
    'Add or update line item(s) on an existing ServiceTitan invoice. dryRun=true (default) validates and returns a ' +
    'confirmation_token — call again with dryRun=false + token to write. Executes as N sequential PATCH calls, ONE per ' +
    'line item (the confirmed ST update model takes a single flat item per call, not an array or {items:[...]}). All N ' +
    'calls are shown in the dryRun preview. Job-link reassignment is NOT possible via this or any ST API — the invoice ' +
    'update model only has summary/dueDate/reviewStatus — so this tool requires an invoice that is already linked to the ' +
    'target job; there is no jobId argument. Price is NOT settable on a line item (QSC dynamic pricing — ST computes ' +
    'sell price at invoice time); use `cost` for cost basis only. Exported invoices are NOT blocked (warn only) — no ' +
    'accounting sign-off exists yet for a hard block; review the dryRun warning before confirming. If item k of N fails ' +
    'mid-sequence, prior items are already written and NOT rolled back — see the error message for cleanup guidance.',
  isWrite: true,
  stEndpoint: { method: 'PATCH', path: '/accounting/v2/tenant/{tid}/invoices/{invoiceId}/items', source: 'live' },
  zodSchema: {
    invoiceId: z.number().int().positive().describe('ST invoice ID to modify'),
    lineItems: z.array(lineItemSchema).min(1).describe('Line items to add/update on the invoice — one PATCH call is issued per item'),
    dryRun: z.boolean().default(true).describe('true (default) = preview + token; false = execute write'),
    confirmation_token: z.string().optional().describe('Token from prior dryRun=true call, required when dryRun=false'),
  },
  async handler(env, args, { actor, correlation }) {
    const { invoiceId, lineItems, dryRun = true, confirmation_token } = args;
    validateLineItems(lineItems, correlation);

    const tenant = env.ST_TENANT_ID;
    const invoiceData = await readST<{ data?: RawInvoice[] }>(
      env, { actor, correlation },
      `/accounting/v2/tenant/${tenant}/invoices`,
      { ids: invoiceId },
    );
    const invoice = invoiceData.data?.[0];
    if (!invoice) throw new McpError('not_found', `invoice ${invoiceId} not found`, { correlation });
    // Guard: this endpoint has a documented history of silently ignoring
    // params (see balanceExcludeZero in list_unpaid_invoices). If ST ever
    // ignores `ids`, data[0] would be an arbitrary invoice — fail loudly
    // instead of writing to the wrong invoice.
    if (Number(invoice.id) !== invoiceId)
      throw new McpError('upstream_error', `ids filter not honored: asked ${invoiceId}, got ${invoice.id}`, { correlation });

    let exportWarning: string | undefined;
    if (invoice.syncStatus === 'Exported') {
      exportWarning = `invoice ${invoiceId} has syncStatus=Exported — writing to it may not reflect correctly in accounting. Consider st_create_adjustment_invoice instead. Proceeding anyway per warn-only policy.`;
    }

    const itemsEndpoint = `/accounting/v2/tenant/000000000/invoices/${invoiceId}/items`;

    // dryRun preview lists ALL N calls as a compound payload, mirroring
    // assign_technicians — what's approved must match what runs.
    const compoundPayload = {
      steps: lineItems.map((item, i) => ({
        call: i + 1,
        endpoint: itemsEndpoint,
        method: 'PATCH',
        payload: item,
      })),
    };

    // TOCTOU guard: fold read-derived state into the hashed args so a material
    // change between the dryRun preview and the confirm call (e.g. the invoice
    // becomes Exported) invalidates the token via the existing "args changed
    // since dryRun" path in WriteGate.verifyToken — instead of silently
    // executing a write that differs from what was approved.
    const businessArgs = { invoiceId, lineItems, syncStatus: invoice.syncStatus };
    const gate = new WriteGate(env);

    if (dryRun) {
      const result = await gate.dryRun(
        'st_add_invoice_line_item', businessArgs, actor, correlation,
        compoundPayload, itemsEndpoint, 'PATCH', 15 * 60 * 1000
      );
      return { ...result, warnings: [exportWarning].filter(Boolean) };
    }
    if (!confirmation_token) {
      throw new McpError('validation_error', 'confirmation_token required when dryRun=false', { correlation });
    }
    await gate.verifyToken('st_add_invoice_line_item', businessArgs, actor, confirmation_token);

    // N sequential calls, one flat item per call. Partial failure is a real,
    // must-report state: ST does not offer a batch/transactional endpoint here,
    // so items 1..k-1 are already written by the time item k fails, and there
    // is no rollback.
    const resolvedEndpoint = rewriteTenantPlaceholders(env, itemsEndpoint);
    const results: unknown[] = [];
    for (let i = 0; i < lineItems.length; i++) {
      const resp = await stWrite(env, { actor, correlation }, resolvedEndpoint, 'PATCH', lineItems[i]);
      if (!resp.ok) {
        const succeeded = i;
        throw new McpError(
          'upstream_error',
          `st_add_invoice_line_item: item ${i + 1} of ${lineItems.length} failed (${resp.status}) on invoice ${invoiceId}. ` +
          `${succeeded} item${succeeded === 1 ? '' : 's'} already succeeded before the failure and ${succeeded === 1 ? 'is' : 'are'} ` +
          `ALREADY WRITTEN to the invoice — they are NOT rolled back. The invoice is now in a partially-updated state. ` +
          `To manually clean up an already-written item, use DELETE /accounting/v2/tenant/${tenant}/invoices/${invoiceId}/items/{itemId}.`,
          { correlation }
        );
      }
      results.push(await resp.json());
    }

    return {
      dryRun: false,
      tool: 'st_add_invoice_line_item',
      result: { itemsWritten: lineItems.length, results },
      correlation,
    };
  },
};
