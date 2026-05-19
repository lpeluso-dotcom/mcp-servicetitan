import { z } from 'zod';
import { readST } from '../../st';
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
  stEndpoint: { method: 'GET', path: '/accounting/v2/tenant/{tid}/invoices', source: 'live' },
  async handler(env, args, { actor, correlation }) {
    const page = args.page ?? 1;
    const pageSize = args.pageSize ?? 50;
    const cacheKey = JSON.stringify({ bu: args.businessUnitId ?? 0, customer: args.customerId ?? 0, page, pageSize });

    return cacheGet(env, 'servicetitan:list_unpaid_invoices', cacheKey, 120, async () => {
      const query: Record<string, unknown> = {
        balanceExcludeZero: 'true',
        page,
        pageSize,
      };
      if (args.businessUnitId) query.businessUnitIds = args.businessUnitId;
      if (args.customerId) query.customerId = args.customerId;

      const data = await readST<{ data?: unknown[] }>(
        env,
        { actor, correlation },
        '/accounting/v2/tenant/000000000/invoices',
        query,
      );
      return { invoices: data.data ?? [], _source: 'live' };
    });
  },
};
