import { z } from 'zod';
import { McpError } from '../../errors';
import { authHeaders } from '../../auth';
import type { ToolDef } from '../index';

interface Args { name?: string; categoryId?: number; active?: boolean; page?: number; pageSize?: number }

export const search_pricebook_services: ToolDef<Args> = {
  name: 'search_pricebook_services',
  description: 'Search pricebook services by name or category. Source: D1 (pb_services fresh 2026-04-22; auto-falls-back to live ST if stale >48h).',
  zodSchema: {
    name: z.string().optional().describe('Service name (partial match)'),
    categoryId: z.number().int().positive().optional().describe('Filter by category ID'),
    active: z.boolean().optional().describe('Filter by active status (default: all)'),
    page: z.number().int().positive().default(1).describe('Page number'),
    pageSize: z.number().int().positive().max(200).default(50).describe('Page size, max 200'),
  },
  async handler(env, args, { actor, correlation }) {
    const qs = new URLSearchParams();
    if (args.name) qs.set('name', args.name);
    if (args.categoryId) qs.set('categoryId', String(args.categoryId));
    if (args.active !== undefined) qs.set('active', String(args.active));
    qs.set('page', String(args.page ?? 1));
    qs.set('pageSize', String(args.pageSize ?? 50));

    const resp = await env.ST_PROXY.fetch(
      `https://servicetitan-proxy/api/st/read?endpoint=${encodeURIComponent(`/pricebook/v2/tenant/000000000/services?${qs}`)}`,
      { headers: authHeaders(env, correlation, actor) }
    );
    if (!resp.ok) throw new McpError('upstream_error', `search_pricebook_services failed: ${resp.status}`, { correlation });
    const data = await resp.json<{ data?: unknown[] }>();
    return { services: data.data ?? [], _source: 'live' };
  },
};
