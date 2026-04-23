// ============================================================
// st_get_pricebook — list ST pricebook assets (services/materials/equipment)
// Cache TTL: 10 min (pricebook changes slowly)
// ============================================================

import { z } from 'zod';
import type { Env } from '../env';
import { authHeaders } from '../auth';
import { cacheGet } from '../cache';
import { McpError, mapUpstreamStatus } from '../errors';
import type { ToolDef } from './index';

const TENANT_ID = '431848990';
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
    const qs = new URLSearchParams();
    qs.set('page', String(page));
    qs.set('pageSize', String(pageSize));
    if (args.active !== undefined) qs.set('active', String(args.active));
    if (args.search) qs.set('search', args.search);
    const endpoint = `/pricebook/v2/tenant/${TENANT_ID}/${args.assetType}?${qs.toString()}`;
    const cacheKey = `${args.assetType}?${qs.toString()}`;

    return cacheGet(env, NAMESPACE, cacheKey, CACHE_TTL_SEC, async () => {
      const url = `https://taylor-ai/api/st/read?endpoint=${encodeURIComponent(endpoint)}`;
      const resp = await env.TAYLOR_AI.fetch(url, { headers: authHeaders(env, correlation, actor) });
      if (!resp.ok) {
        const body = await resp.text().catch(() => '');
        throw new McpError(mapUpstreamStatus(resp.status), `ST pricebook ${args.assetType} ${resp.status}: ${body.slice(0, 200)}`, { correlation });
      }
      return resp.json();
    });
  },
};
