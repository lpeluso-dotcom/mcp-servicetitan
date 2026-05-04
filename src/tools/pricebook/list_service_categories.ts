import { z } from 'zod';
import { McpError } from '../../errors';
import { authHeaders } from '../../auth';
import { cacheGet } from '../../cache';
import type { ToolDef } from '../index';

interface Args { active?: boolean; page?: number; pageSize?: number }

// Renamed from list_categories to disambiguate — materials/equipment have separate category trees.
export const list_service_categories: ToolDef<Args> = {
  name: 'list_service_categories',
  description: 'List pricebook service categories (not materials/equipment categories — those are separate trees). Source: live ST.',
  stEndpoint: { method: 'GET', path: '/pricebook/v2/tenant/{tid}/categories', source: 'live' },
  zodSchema: {
    active: z.boolean().optional().describe('Filter by active status (default: all)'),
    page: z.number().int().positive().default(1).describe('Page number'),
    pageSize: z.number().int().positive().max(200).default(200).describe('Page size, max 200'),
  },
  async handler(env, args, { actor, correlation }) {
    const page = args.page ?? 1;
    const pageSize = args.pageSize ?? 200;
    const cacheKey = JSON.stringify({ active: args.active ?? null, page, pageSize });

    return cacheGet(env, 'servicetitan:list_service_categories', cacheKey, 600, async () => {
      const qs = new URLSearchParams();
      if (args.active !== undefined) qs.set('active', String(args.active));
      qs.set('page', String(page));
      qs.set('pageSize', String(pageSize));

      const resp = await env.ST_PROXY.fetch(
        `https://servicetitan-proxy/api/st/read?endpoint=${encodeURIComponent(`/pricebook/v2/tenant/000000000/categories?${qs}`)}`,
        { headers: authHeaders(env, correlation, actor) }
      );
      if (!resp.ok) throw new McpError('upstream_error', `list_service_categories failed: ${resp.status}`, { correlation });
      const data = await resp.json<{ data?: unknown[] }>();
      return { categories: data.data ?? [], _source: 'live' };
    });
  },
};
