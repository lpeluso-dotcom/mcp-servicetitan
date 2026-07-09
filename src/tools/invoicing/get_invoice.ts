import { z } from 'zod';
import { readST } from '../../st';
import { McpError } from '../../errors';
import type { ToolDef } from '../index';

interface Args { invoiceId: number }

export const get_invoice: ToolDef<Args> = {
  name: 'get_invoice',
  description: 'Get full invoice details including line items and totals. Source: live ST (accounting invoices, fetched by id via the list endpoint — ST has no /invoices/{id} route).',
  zodSchema: { invoiceId: z.number().int().positive().describe('ST invoice ID') },
  stEndpoint: { method: 'GET', path: '/accounting/v2/tenant/{tid}/invoices', source: 'live' },
  async handler(env, args, { actor, correlation }) {
    const data = await readST<{ data?: unknown[] }>(
      env, { actor, correlation },
      '/accounting/v2/tenant/000000000/invoices',
      { ids: args.invoiceId },
    );
    const invoice = data.data?.[0] ?? null;
    if (!invoice) throw new McpError('not_found', `invoice ${args.invoiceId} not found`, { correlation });
    // Guard: this endpoint has a documented history of silently ignoring
    // params (see balanceExcludeZero in list_unpaid_invoices). If ST ever
    // ignores `ids`, data[0] would be an arbitrary invoice — fail loudly
    // instead of returning silently wrong financial data.
    if (Number((invoice as { id?: unknown }).id) !== args.invoiceId)
      throw new McpError('upstream_error', `ids filter not honored: asked ${args.invoiceId}, got ${(invoice as { id?: unknown }).id}`, { correlation });
    return { invoice, _source: 'live' };
  },
};
