import { z } from 'zod';
import { McpError } from '../../errors';
import { authHeaders } from '../../auth';
import type { ToolDef } from '../index';

interface Args { active?: boolean; page?: number; pageSize?: number }

// Renamed from list_categories to disambiguate — materials/equipment have separate category trees.
export const list_service_categories: ToolDef<Args> = {
  name: 'list_service_categories',
  description: 'List pricebook service categories (not materials/equipment categories — those are separate trees). Source: live ST.',
  zodSchema: {
    active: z.boolean().optional().describe('Filter by active status (default: all)'),
    page: z.number().int().positive().default(1).describe('Page number'),
    pageSize: z.number().int().positive().max(200).default(200).describe('Page size, max 200'),
  },
  async handler(env, args, { actor, correlation }) {
    const qs = new URLSearchParams();
    if (args.active !== undefined) qs.set('active', String(args.active));
    qs.set('page', String(args.page ?? 1));
    qs.set('pageSize', String(args.pageSize ?? 200));

    const resp = await env.TAYLOR_AI.fetch(
      `https://taylor-ai/api/st/read?endpoint=${encodeURIComponent(`/pricebook/v2/tenant/431848990/servicecategories?${qs}`)}`,
      { headers: authHeaders(env, correlation, actor) }
    );
    if (!resp.ok) throw new McpError('upstream_error', `list_service_categories failed: ${resp.status}`, { correlation });
    const data = await resp.json<{ data?: unknown[] }>();
    return { categories: data.data ?? [], _source: 'live' };
  },
};
