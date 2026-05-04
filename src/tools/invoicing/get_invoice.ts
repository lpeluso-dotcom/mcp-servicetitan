import { z } from 'zod';
import { McpError } from '../../errors';
import { authHeaders } from '../../auth';
import type { ToolDef } from '../index';

interface Args { invoiceId: number }

export const get_invoice: ToolDef<Args> = {
  name: 'get_invoice',
  description: 'Get full invoice details including line items and totals. Source: D1 (invoices nightly-synced).',
  zodSchema: {
    invoiceId: z.number().int().positive().describe('ST invoice ID'),
  },
  async handler(env, args, { actor, correlation }) {
    const resp = await env.ST_PROXY.fetch(
      `https://servicetitan-proxy/api/st/read?endpoint=${encodeURIComponent(`/accounting/v2/tenant/000000000/invoices/${args.invoiceId}`)}`,
      { headers: authHeaders(env, correlation, actor) }
    );
    if (!resp.ok) throw new McpError('upstream_error', `get_invoice failed: ${resp.status}`, { correlation });
    const data = await resp.json<unknown>();
    return { invoice: data, _source: 'live' };
  },
};
