import { z } from 'zod';
import { McpError } from '../../errors';
import { authHeaders } from '../../auth';
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
  async handler(env, args, { actor, correlation }) {
    const qs = new URLSearchParams({ customerId: String(args.customerId) });
    if (args.status) qs.set('jobStatus', args.status);
    if (args.page) qs.set('page', String(args.page));
    if (args.pageSize) qs.set('pageSize', String(args.pageSize));
    const resp = await env.TAYLOR_AI.fetch(
      `https://taylor-ai/api/st/read?endpoint=${encodeURIComponent(`/jpm/v2/tenant/431848990/jobs?${qs}`)}`,
      { headers: authHeaders(env, correlation, actor) }
    );
    if (!resp.ok) throw new McpError('upstream_error', `list_customer_jobs failed: ${resp.status}`, { correlation });
    const data = await resp.json<{ data?: unknown[] }>();
    return { jobs: data.data ?? [], _source: 'live' };
  },
};
