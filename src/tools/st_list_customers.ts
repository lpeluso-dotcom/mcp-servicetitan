// ============================================================
// st_list_customers — list ST customers
// Cache TTL: 5 min
// ============================================================

import { z } from 'zod';
import { cacheGet } from '../cache';
import { readST } from '../st';
import type { ToolDef } from './index';
import { defaultShaper } from '../response-shape';

const TENANT_ID = '000000000';
const NAMESPACE = 'servicetitan:customers';
const CACHE_TTL_SEC = 300; // 5 min

interface Args {
  page?: number;
  pageSize?: number;
  modifiedOnOrAfter?: string; // ISO
}

export const st_list_customers: ToolDef<Args> = {
  name: 'st_list_customers',
  description:
    'List ServiceTitan customers with optional pagination and modified-after filter. Read-only. Cached 5 min. Source: live ST via servicetitan-proxy /api/st/read (handles ST OAuth). Default page size 50, max 200.',
  zodSchema: {
    page: z.number().int().positive().optional().describe('Page number, default 1'),
    pageSize: z.number().int().positive().max(200).optional().describe('Page size, default 50, max 200'),
    modifiedOnOrAfter: z
      .string()
      .optional()
      .describe('ISO 8601 timestamp, returns customers modified on or after this time'),
  },
  stEndpoint: { method: 'GET', path: '/crm/v2/tenant/{tid}/customers', source: 'live' },
  async handler(env, args, { actor, correlation }) {
    const page = args.page ?? 1;
    const pageSize = Math.min(args.pageSize ?? 50, 200);
    const query: Record<string, unknown> = { page, pageSize };
    if (args.modifiedOnOrAfter) query.modifiedOnOrAfter = args.modifiedOnOrAfter;
    const cacheKey = JSON.stringify(query);

    return cacheGet(env, NAMESPACE, cacheKey, CACHE_TTL_SEC, async () =>
      readST(env, { actor, correlation }, `/crm/v2/tenant/${TENANT_ID}/customers`, query),
    );
  },
  transformResult: defaultShaper,
};
