// ============================================================
// st_get_pricebook — list ST pricebook assets (services/materials/equipment)
// Cache TTL: 10 min (pricebook changes slowly)
// ============================================================

import { z } from 'zod';
import { cacheGet } from '../cache';
import { McpError } from '../errors';
import { readST } from '../st';
import type { ToolDef } from './index';

const TENANT_ID = '000000000';
const NAMESPACE = 'servicetitan:pricebook';
const CACHE_TTL_SEC = 600;

interface Args {
  assetType: 'services' | 'materials' | 'equipment';
  page?: number;
  pageSize?: number;
  active?: boolean;
  search?: string;
}

const VALID_ASSET_TYPES = new Set(['services', 'materials', 'equipment']);

export const st_get_pricebook: ToolDef<Args> = {
  name: 'st_get_pricebook',
  description:
    'List ServiceTitan pricebook items by asset type (services, materials, or equipment). Read-only. Cached 10 min. The primary source for pricebook data is the pb_services / pb_materials / pb_equipment D1 tables synced nightly — use this tool for live-state verification.',
  stEndpoint: { method: 'GET', path: '/pricebook/v2/tenant/{tid}/{assetType}', source: 'live' },
  zodSchema: {
    assetType: z
      .enum(['services', 'materials', 'equipment'])
      .describe('Pricebook asset category'),
    page: z.number().int().positive().optional().describe('Page number, default 1'),
    pageSize: z.number().int().positive().max(200).optional().describe('Page size, default 50, max 200'),
    active: z.boolean().optional().describe('Filter to only active items'),
    search: z.string().optional().describe('Free-text search'),
  },
  async handler(env, args, { actor, correlation }) {
    if (!args.assetType || !VALID_ASSET_TYPES.has(args.assetType)) {
      throw new McpError('validation_error', `assetType must be one of services|materials|equipment`, { correlation });
    }
    const page = args.page ?? 1;
    const pageSize = Math.min(args.pageSize ?? 50, 200);
    const query: Record<string, unknown> = { page, pageSize };
    if (args.active !== undefined) query.active = args.active;
    if (args.search) query.search = args.search;
    const endpoint = `/pricebook/v2/tenant/${TENANT_ID}/${args.assetType}`;
    const cacheKey = `${args.assetType}:${JSON.stringify(query)}`;

    return cacheGet(env, NAMESPACE, cacheKey, CACHE_TTL_SEC, async () =>
      readST(env, { actor, correlation }, endpoint, query),
    );
  },
};
