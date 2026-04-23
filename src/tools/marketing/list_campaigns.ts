import { z } from 'zod';
import { McpError } from '../../errors';
import { authHeaders } from '../../auth';
import type { ToolDef } from '../index';

interface Args { active?: boolean; page?: number; pageSize?: number }

export const list_campaigns: ToolDef<Args> = {
  name: 'list_campaigns',
  description: 'List marketing campaigns. Source: D1 (campaigns nightly-synced).',
  zodSchema: {
    active: z.boolean().optional().describe('Filter by active status (default: all)'),
    page: z.number().int().positive().default(1).describe('Page number'),
    pageSize: z.number().int().positive().max(200).default(50).describe('Page size, max 200'),
  },
  async handler(env, args, { actor, correlation }) {
    const qs = new URLSearchParams();
    if (args.active !== undefined) qs.set('active', String(args.active));
    qs.set('page', String(args.page ?? 1));
    qs.set('pageSize', String(args.pageSize ?? 50));

    const resp = await env.TAYLOR_AI.fetch(
      `https://taylor-ai/api/st/read?endpoint=${encodeURIComponent(`/marketing/v2/tenant/431848990/campaigns?${qs}`)}`,
      { headers: authHeaders(env, correlation, actor) }
    );
    if (!resp.ok) throw new McpError('upstream_error', `list_campaigns failed: ${resp.status}`, { correlation });
    const data = await resp.json<{ data?: unknown[] }>();
    return { campaigns: data.data ?? [], _source: 'live' };
  },
};
