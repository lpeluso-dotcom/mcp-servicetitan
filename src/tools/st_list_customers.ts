// ============================================================
// st_list_customers — list ST customers
// Cache TTL: 5 min
// ============================================================

import type { Env } from '../env';
import { authHeaders } from '../auth';
import { cacheGet } from '../cache';
import { McpError, mapUpstreamStatus } from '../errors';
import type { ToolDef } from './index';

const TENANT_ID = '431848990';
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
    'List ServiceTitan customers with optional pagination and modified-after filter. Read-only. Cached 5 min. Calls taylor-ai /api/st/read which handles ST OAuth.',
  inputSchema: {
    type: 'object',
    properties: {
      page: { type: 'number', description: 'Page number, default 1' },
      pageSize: { type: 'number', description: 'Page size, default 50, max 200' },
      modifiedOnOrAfter: {
        type: 'string',
        description: 'ISO 8601 timestamp, returns customers modified on or after this time',
      },
    },
    additionalProperties: false,
  },
  async handler(env, args, { actor, correlation }) {
    const page = args.page ?? 1;
    const pageSize = Math.min(args.pageSize ?? 50, 200);
    const modifiedFilter = args.modifiedOnOrAfter
      ? `&modifiedOnOrAfter=${encodeURIComponent(args.modifiedOnOrAfter)}`
      : '';
    const endpoint = `/crm/v2/tenant/${TENANT_ID}/customers?page=${page}&pageSize=${pageSize}${modifiedFilter}`;
    const cacheKey = `page=${page}&pageSize=${pageSize}&mod=${args.modifiedOnOrAfter ?? ''}`;

    return cacheGet(env, NAMESPACE, cacheKey, CACHE_TTL_SEC, async () => {
      const url = `${env.TAYLOR_AI_URL}/api/st/read?endpoint=${encodeURIComponent(endpoint)}`;
      const resp = await fetch(url, { headers: authHeaders(env, correlation, actor) });
      if (!resp.ok) {
        const body = await resp.text().catch(() => '');
        throw new McpError(mapUpstreamStatus(resp.status), `ST list_customers ${resp.status}: ${body.slice(0, 200)}`, { correlation });
      }
      return resp.json();
    });
  },
};
