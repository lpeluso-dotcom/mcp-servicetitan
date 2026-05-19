import { z } from 'zod';
import { cacheGet } from '../../cache';
import { readST } from '../../st';
import type { ToolDef } from '../index';

const TENANT_ID = '000000000';

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
      const query: Record<string, unknown> = {
        active: args.active,
        page,
        pageSize,
      };
      const data = await readST<{ data?: unknown[] }>(
        env,
        { actor, correlation },
        `/pricebook/v2/tenant/${TENANT_ID}/categories`,
        query,
      );
      return { categories: data.data ?? [], _source: 'live' };
    });
  },
};
