import { z } from 'zod';
import { readST } from '../../st';
import type { ToolDef } from '../index';

interface Args { customerId: number; status?: string; page?: number; pageSize?: number }

export const list_customer_jobs: ToolDef<Args> = {
  name: 'list_customer_jobs',
  description: 'List jobs for a customer. Source: live ST (auto-falls-back to live if D1 stale >48h).',
  zodSchema: {
    customerId: z.number().int().positive().describe('ST customer ID'),
    status: z.string().optional().describe('Filter by job status (e.g. "Completed", "InProgress")'),
    page: z.number().int().positive().optional(),
    pageSize: z.number().int().positive().max(200).optional(),
  },
  stEndpoint: { method: 'GET', path: '/jpm/v2/tenant/{tid}/jobs', source: 'live' },
  async handler(env, args, { actor, correlation }) {
    const query: Record<string, unknown> = { customerId: args.customerId };
    if (args.status) query.jobStatus = args.status;
    if (args.page) query.page = args.page;
    if (args.pageSize) query.pageSize = args.pageSize;
    const data = await readST<{ data?: unknown[] }>(
      env,
      { actor, correlation },
      `/jpm/v2/tenant/000000000/jobs`,
      query,
    );
    return { jobs: data.data ?? [], _source: 'live' };
  },
};
