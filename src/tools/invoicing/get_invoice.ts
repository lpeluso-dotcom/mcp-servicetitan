import { z } from 'zod';
import { readST } from '../../st';
import type { ToolDef } from '../index';

interface Args { invoiceId: number }

export const get_invoice: ToolDef<Args> = {
  name: 'get_invoice',
  description: 'Get full invoice details including line items and totals. Source: D1 (invoices nightly-synced).',
  zodSchema: {
    invoiceId: z.number().int().positive().describe('ST invoice ID'),
  },
  stEndpoint: { method: 'GET', path: '/accounting/v2/tenant/{tid}/invoices/{invoiceId}', source: 'live' },
  async handler(env, args, { actor, correlation }) {
    const data = await readST<unknown>(
      env,
      { actor, correlation },
      `/accounting/v2/tenant/000000000/invoices/${args.invoiceId}`,
    );
    return { invoice: data, _source: 'live' };
  },
};
