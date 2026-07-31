// ============================================================
// st_add_invoice_line_item — add line items to an invoice, optionally
// setting its job link.
// F3: dryRun=true (default) → confirmation_token → dryRun=false → sequential
// compound write over /api/st/write (NOT durableWrite — the durable-write
// proxy only maps 4 pricebook operations; there is no proxy-side mapping for
// invoice line items, so that path would 404/no-op silently).
//
// ENDPOINTS are now CONFIRMED from the real ST Accounting v2 API catalog
// (2026-07-31):
//   PATCH /accounting/v2/tenant/{tid}/invoices/{invoiceId}/items  — line items
//   PATCH /accounting/v2/tenant/{tid}/invoices/{id}                — job link
// BODY SHAPES are still UNCONFIRMED — the catalog gives paths/verbs only, no
// request schemas. Best guesses, stated explicitly:
//   - items PATCH: guessing `{ items: [...] }` (matching the `/items` resource
//     name) over a bare array or `{ lineItems: [...] }` — unconfirmed.
//   - unconfirmed whether this PATCH can APPEND new items or only update
//     existing ones (by itemId) — if append-only fails, this may need to be a
//     POST to a create-item endpoint instead.
//   - job link PATCH: guessing a bare int (`{ job: jobId }`) per the nested
//     object seen on GET responses being ST's read-shape convention, not
//     necessarily its write-shape — unconfirmed whether it wants
//     `{ job: { id: jobId } }` instead.
//
// Field names elsewhere match the LIVE ST GET shape confirmed during design
// research (2026-07-31), not the untrustworthy third-party OpenAPI mirror:
// `type` (not `skuType`), `isChargeable` (not `chargeable`).
//
// The jobId link is best-effort: research could not confirm whether ST's
// API allows changing an existing invoice's `job`/`invoiceConfiguration`
// post-creation. The primary path is adding line items to an
// already-job-linked empty invoice (QSC's pre-creation convention); jobId
// linking is attempted only when the invoice doesn't already have one.
// ============================================================

import { z } from 'zod';
import { McpError } from '../../errors';
import { WriteGate } from '../../write-gate';
import { readST } from '../../st';
import { rewriteTenantPlaceholders } from '../../tenant';
import type { ToolDef } from '../index';
import type { Env } from '../../env';

export interface InvoiceLineItemInput {
  skuId?: number;
  skuName?: string;
  description?: string;
  quantity: number;
  price?: number;
  cost?: number;
  generalLedgerAccountId?: number;
  businessUnitId?: number;
  type?: 'Service' | 'Material' | 'Equipment';
}

interface Args {
  invoiceId: number;
  jobId?: number;
  lineItems: InvoiceLineItemInput[];
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
  customer?: { id?: number };
  job?: { id?: number } | null;
  [key: string]: unknown;
}

interface RawJob {
  id?: number;
  customerId?: number;
  [key: string]: unknown;
}

function validateLineItems(lineItems: InvoiceLineItemInput[], correlation: string): void {
  if (!lineItems || lineItems.length === 0) {
    throw new McpError('validation_error', 'st_add_invoice_line_item requires at least one line item', { correlation });
  }
  for (const [i, item] of lineItems.entries()) {
    if (item.type === 'Equipment' && (item.price === undefined || item.cost === undefined)) {
      throw new McpError(
        'validation_error',
        `lineItems[${i}]: Equipment line items require both price and cost (QSC equipment is statically priced — a blank price/cost is a real $0-billing risk)`,
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
    'Add line item(s) to an existing ServiceTitan invoice, optionally linking it to a job. ' +
    'dryRun=true (default) validates and returns a confirmation_token — call again with dryRun=false + token to write. ' +
    'Executes as a sequential compound write: PATCH .../invoices/{id}/items always; PATCH .../invoices/{id} for the job ' +
    'link only when jobId was passed and the invoice has no existing job link. Both steps are shown in the dryRun preview. ' +
    'Exported invoices are NOT blocked (warn only) — no accounting sign-off exists yet for a hard block; review the dryRun warning before confirming. ' +
    'jobId linking is best-effort: ST may not support changing an existing invoice\'s job/invoiceConfiguration post-creation. ' +
    'Equipment-type line items require both price and cost (QSC equipment uses static pricing). ' +
    'ENDPOINTS are confirmed (ST Accounting v2 API catalog); request BODY SHAPES are not — see file header for the specific unconfirmed guesses.',
  isWrite: true,
  stEndpoint: { method: 'PATCH', path: '/accounting/v2/tenant/{tid}/invoices/{invoiceId}/items', source: 'live' },
  zodSchema: {
    invoiceId: z.number().int().positive().describe('ST invoice ID to modify'),
    jobId: z.number().int().positive().optional().describe('If provided and the invoice has no job link yet, attempt to set it. Best-effort — see tool description.'),
    lineItems: z.array(lineItemSchema).min(1).describe('Line items to add to the invoice'),
    dryRun: z.boolean().default(true).describe('true (default) = preview + token; false = execute write'),
    confirmation_token: z.string().optional().describe('Token from prior dryRun=true call, required when dryRun=false'),
  },
  async handler(env, args, { actor, correlation }) {
    const { invoiceId, jobId, lineItems, dryRun = true, confirmation_token } = args;
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

    let jobLinkWarning: string | undefined;
    if (jobId) {
      const job = await readST<RawJob>(env, { actor, correlation }, `/jpm/v2/tenant/${tenant}/jobs/${jobId}`);
      if (job.customerId !== undefined && invoice.customer?.id !== undefined && job.customerId !== invoice.customer.id) {
        throw new McpError(
          'validation_error',
          `jobId ${jobId} belongs to customer ${job.customerId}, but invoice ${invoiceId} belongs to customer ${invoice.customer.id} — refusing cross-customer job link`,
          { correlation }
        );
      }
    }

    let exportWarning: string | undefined;
    if (invoice.syncStatus === 'Exported') {
      exportWarning = `invoice ${invoiceId} has syncStatus=Exported — writing to it may not reflect correctly in accounting. Consider st_create_adjustment_invoice instead. Proceeding anyway per warn-only policy.`;
    }

    const needsJobLink = !!(jobId && !invoice.job);
    if (needsJobLink) {
      jobLinkWarning = `Attempting to set job=${jobId} on invoice ${invoiceId} — ST may not support this on an existing invoice; verify the write actually took by re-reading the invoice after confirmation.`;
    }

    // Call 1 payload — best guess `{ items: [...] }` per file header.
    const itemsPayload: Record<string, unknown> = { items: lineItems };
    // Call 2 payload — best guess bare int per file header.
    const jobLinkPayload: Record<string, unknown> = { job: jobId };

    const itemsEndpoint = `/accounting/v2/tenant/000000000/invoices/${invoiceId}/items`;
    const jobLinkEndpoint = `/accounting/v2/tenant/000000000/invoices/${invoiceId}`;

    // dryRun preview shows both steps as a compound payload, mirroring
    // assign_technicians — what's approved must match what runs.
    const compoundPayload = {
      steps: [
        { call: 1, endpoint: itemsEndpoint, method: 'PATCH', payload: itemsPayload },
        ...(needsJobLink ? [{ call: 2, endpoint: jobLinkEndpoint, method: 'PATCH', payload: jobLinkPayload }] : []),
      ],
    };

    // TOCTOU guard: fold read-derived state into the hashed args so a material
    // change between the dryRun preview and the confirm call (e.g. the invoice
    // becomes Exported, or its job link changes) invalidates the token via the
    // existing "args changed since dryRun" path in WriteGate.verifyToken —
    // instead of silently executing a write that differs from what was approved.
    const businessArgs = { invoiceId, jobId, lineItems, syncStatus: invoice.syncStatus, hadJobLink: !!invoice.job };
    const gate = new WriteGate(env);

    if (dryRun) {
      const result = await gate.dryRun(
        'st_add_invoice_line_item', businessArgs, actor, correlation,
        compoundPayload, itemsEndpoint, 'PATCH', 15 * 60 * 1000
      );
      return { ...result, warnings: [exportWarning, jobLinkWarning].filter(Boolean) };
    }
    if (!confirmation_token) {
      throw new McpError('validation_error', 'confirmation_token required when dryRun=false', { correlation });
    }
    await gate.verifyToken('st_add_invoice_line_item', businessArgs, actor, confirmation_token);

    // Call 1: line items — always.
    // NOTE: rewriteTenantPlaceholders is applied here even though assign_technicians
    // (the shape this tool follows) does NOT apply it to its own live-call endpoints.
    // That looks like a latent bug in assign_technicians: write-tool-factory.ts:129
    // resolves the tenant placeholder at the call site before every factory-based
    // write, and write-gate.ts's WriteGate.dryRun() also rewrites the placeholder
    // for the *preview* endpoint it returns — but assign_technicians's hand-rolled
    // live fetch calls send the literal `000000000` straight to /api/st/write,
    // unresolved. Applying the rewrite here is the safer/correct behavior; the
    // discrepancy is flagged in the final report rather than fixed in
    // assign_technicians (out of scope for this task).
    const itemsResp = await stWrite(
      env, { actor, correlation },
      rewriteTenantPlaceholders(env, itemsEndpoint), 'PATCH', itemsPayload
    );
    if (!itemsResp.ok) {
      throw new McpError('upstream_error', `st_add_invoice_line_item: line-item write failed: ${itemsResp.status}`, { correlation });
    }
    const itemsResult = await itemsResp.json();

    // Call 2: job link — only if needed.
    if (needsJobLink) {
      const jobLinkResp = await stWrite(
        env, { actor, correlation },
        rewriteTenantPlaceholders(env, jobLinkEndpoint), 'PATCH', jobLinkPayload
      );
      if (!jobLinkResp.ok) {
        throw new McpError(
          'upstream_error',
          `st_add_invoice_line_item: line items were added successfully to invoice ${invoiceId}, but the job link write failed: ${jobLinkResp.status}. Partial success — line items landed, job link did not.`,
          { correlation }
        );
      }
      const jobLinkResult = await jobLinkResp.json();
      return {
        dryRun: false,
        tool: 'st_add_invoice_line_item',
        result: { items: itemsResult, job: jobLinkResult },
        correlation,
      };
    }

    return { dryRun: false, tool: 'st_add_invoice_line_item', result: { items: itemsResult }, correlation };
  },
};
