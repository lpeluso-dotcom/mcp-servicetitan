// ============================================================
// st_add_invoice_line_item — add line items to an invoice, optionally
// setting its job link.
// F3: dryRun=true (default) → confirmation_token → dryRun=false → durable write.
//
// Field names match the LIVE ST GET shape confirmed during design research
// (2026-07-31), not the untrustworthy third-party OpenAPI mirror: `type`
// (not `skuType`), `isChargeable` (not `chargeable`). generalLedgerAccountId/
// businessUnitId are accepted here as plain ints — GET returns them as
// nested objects ({id, name, ...}); the manual sandbox check (design doc,
// Implementation Risk section) confirms whether PATCH wants the bare id or
// the nested object before this tool's live write path ships.
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
import type { ToolDef } from '../index';
import { durableWrite } from '../st_patch_service';

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

export const st_add_invoice_line_item: ToolDef<Args> = {
  name: 'st_add_invoice_line_item',
  description:
    'Add line item(s) to an existing ServiceTitan invoice, optionally linking it to a job. ' +
    'dryRun=true (default) validates and returns a confirmation_token — call again with dryRun=false + token to write. ' +
    'Exported invoices are NOT blocked (warn only) — no accounting sign-off exists yet for a hard block; review the dryRun warning before confirming. ' +
    'jobId linking is best-effort: ST may not support changing an existing invoice\'s job/invoiceConfiguration post-creation. ' +
    'Equipment-type line items require both price and cost (QSC equipment uses static pricing).',
  isWrite: true,
  stEndpoint: { method: 'PATCH', path: '/accounting/v2/tenant/{tid}/invoices/{id}', source: 'live' },
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

    const payload: Record<string, unknown> = { lineItems };
    if (jobId && !invoice.job) {
      payload.job = jobId;
      jobLinkWarning = `Attempting to set job=${jobId} on invoice ${invoiceId} — ST may not support this on an existing invoice; verify the write actually took by re-reading the invoice after confirmation.`;
    }

    const businessArgs = { invoiceId, jobId, lineItems };
    const gate = new WriteGate(env);
    const endpoint = `/accounting/v2/tenant/000000000/invoices/${invoiceId}`;

    if (dryRun) {
      const result = await gate.dryRun('st_add_invoice_line_item', businessArgs, actor, correlation, payload, endpoint, 'PATCH', 15 * 60 * 1000);
      return { ...result, warnings: [exportWarning, jobLinkWarning].filter(Boolean) };
    }
    if (!confirmation_token) {
      throw new McpError('validation_error', 'confirmation_token required when dryRun=false', { correlation });
    }
    await gate.verifyToken('st_add_invoice_line_item', businessArgs, actor, confirmation_token);
    return durableWrite(env, {
      actor, operation: 'invoice.add_line_item',
      target: { id: String(invoiceId), type: 'invoice' },
      payload, correlation,
    });
  },
};
