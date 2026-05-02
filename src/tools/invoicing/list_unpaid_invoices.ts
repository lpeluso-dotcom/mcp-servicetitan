import { z } from 'zod';
import { McpError } from '../../errors';
import { authHeaders } from '../../auth';
import { cacheGet } from '../../cache';
import type { ToolDef } from '../index';

interface Args { businessUnitId?: number; customerId?: number; page?: number; pageSize?: number }

export const list_unpaid_invoices: ToolDef<Args> = {
  name: 'list_unpaid_invoices',
  description: 'List invoices with an outstanding balance (unpaid or partially paid). Source: D1 (invoices nightly-synced).',
  zodSchema: {
    businessUnitId: z.number().int().positive().optional().describe('Filter by business unit ID'),
    customerId: z.number().int().positive().optional().describe('Filter by customer ID'),
    page: z.number().int().positive().default(1).describe('Page number'),
    pageSize: z.number().int().positive().max(200).default(50).describe('Page size, max 200'),
  },
  async handler(env, args, { actor, correlation }) {
    const page = args.page ?? 1;
    const pageSize = args.pageSize ?? 50;
    const cacheKey = JSON.stringify({ bu: args.businessUnitId ?? 0, customer: args.customerId ?? 0, page, pageSize });

    return cacheGet(env, 'servicetitan:list_unpaid_invoices', cacheKey, 120, async () => {
      const qs = new URLSearchParams();
      qs.set('balanceExcludeZero', 'true');
      if (args.businessUnitId) qs.set('businessUnitIds', String(args.businessUnitId));
      if (args.customerId) qs.set('customerId', String(args.customerId));
      qs.set('page', String(page));
      qs.set('pageSize', String(pageSize));

      const resp = await env.TAYLOR_AI.fetch(
        `https://taylor-ai/api/st/read?endpoint=${encodeURIComponent(`/accounting/v2/tenant/431848990/invoices?${qs}`)}`,
        { headers: authHeaders(env, correlation, actor) }
      );
      if (!resp.ok) throw new McpError('upstream_error', `list_unpaid_invoices failed: ${resp.status}`, { correlation });
      const data = await resp.json<{ data?: unknown[] }>();
      return { invoices: data.data ?? [], _source: 'live' };
    });
  },
};
