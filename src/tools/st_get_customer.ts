// ============================================================
// st_get_customer — fetch a single ST customer by ID
// Cache TTL: 5 min
// ============================================================

import { z } from 'zod';
import type { Env } from '../env';
import { authHeaders } from '../auth';
import { cacheGet } from '../cache';
import { McpError, mapUpstreamStatus } from '../errors';
import type { ToolDef } from './index';

const TENANT_ID = '431848990';
const NAMESPACE = 'servicetitan:customer';
const CACHE_TTL_SEC = 300;

interface Args {
  customerId: number;
}

export const st_get_customer: ToolDef<Args> = {
  name: 'st_get_customer',
  description: 'Get a single ServiceTitan customer by ID. Read-only. Cached 5 min.',
  zodSchema: {
    customerId: z.number().int().positive().describe('ServiceTitan customer ID'),
  },
  async handler(env, args, { actor, correlation }) {
    if (!args.customerId || typeof args.customerId !== 'number') {
      throw new McpError('validation_error', 'customerId is required and must be a number', { correlation });
    }
    const endpoint = `/crm/v2/tenant/${TENANT_ID}/customers/${args.customerId}`;
    const cacheKey = String(args.customerId);

    return cacheGet(env, NAMESPACE, cacheKey, CACHE_TTL_SEC, async () => {
      const url = `https://taylor-ai/api/st/read?endpoint=${encodeURIComponent(endpoint)}`;
      const resp = await env.TAYLOR_AI.fetch(url, { headers: authHeaders(env, correlation, actor) });
      if (!resp.ok) {
        const body = await resp.text().catch(() => '');
        throw new McpError(mapUpstreamStatus(resp.status), `ST get_customer ${args.customerId} ${resp.status}: ${body.slice(0, 200)}`, { correlation });
      }
      return resp.json();
    });
  },
};
