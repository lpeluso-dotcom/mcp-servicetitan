import { z } from 'zod';
import { readST } from '../../st';
import type { ToolDef } from '../index';

const TENANT_ID = '000000000';

interface Args { name?: string; categoryId?: number; active?: boolean; page?: number; pageSize?: number }

export const search_materials: ToolDef<Args> = {
  name: 'search_materials',
  description: 'Search pricebook materials by name or category. Source: live ST (pb_materials 23d stale in D1 — falls back to live until sync fixed).',
  zodSchema: {
    name: z.string().optional().describe('Material name (partial match)'),
    categoryId: z.number().int().positive().optional().describe('Filter by category ID'),
    active: z.boolean().optional().describe('Filter by active status (default: all)'),
    page: z.number().int().positive().default(1).describe('Page number'),
    pageSize: z.number().int().positive().max(200).default(50).describe('Page size, max 200'),
  },
  stEndpoint: { method: 'GET', path: '/pricebook/v2/tenant/{tid}/materials', source: 'live' },
  async handler(env, args, { actor, correlation }) {
    const query: Record<string, unknown> = {
      name: args.name,
      categoryId: args.categoryId,
      active: args.active,
      page: args.page ?? 1,
      pageSize: args.pageSize ?? 50,
    };
    const data = await readST<{ data?: unknown[] }>(
      env,
      { actor, correlation },
      `/pricebook/v2/tenant/${TENANT_ID}/materials`,
      query,
    );
    return { materials: data.data ?? [], _source: 'live' };
  },
};
