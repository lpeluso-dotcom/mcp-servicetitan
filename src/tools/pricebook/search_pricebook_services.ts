import { z } from 'zod';
import { readST } from '../../st';
import type { ToolDef } from '../index';

const TENANT_ID = '000000000';

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
  stEndpoint: { method: 'GET', path: '/pricebook/v2/tenant/{tid}/services', source: 'live' },
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
      `/pricebook/v2/tenant/${TENANT_ID}/services`,
      query,
    );
    return { services: data.data ?? [], _source: 'live' };
  },
};
