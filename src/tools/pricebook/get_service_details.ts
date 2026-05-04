import { z } from 'zod';
import { McpError } from '../../errors';
import { authHeaders } from '../../auth';
import type { ToolDef } from '../index';

interface Args { serviceId: number }

export const get_service_details: ToolDef<Args> = {
  name: 'get_service_details',
  description: 'Get full details for a single pricebook service including pricing tiers and categories. Source: D1 (pb_services fresh 2026-04-22).',
  zodSchema: {
    serviceId: z.number().int().positive().describe('ST pricebook service ID'),
  },
  async handler(env, args, { actor, correlation }) {
    const resp = await env.ST_PROXY.fetch(
      `https://servicetitan-proxy/api/st/read?endpoint=${encodeURIComponent(`/pricebook/v2/tenant/000000000/services/${args.serviceId}`)}`,
      { headers: authHeaders(env, correlation, actor) }
    );
    if (!resp.ok) throw new McpError('upstream_error', `get_service_details failed: ${resp.status}`, { correlation });
    const data = await resp.json<unknown>();
    return { service: data, _source: 'live' };
  },
};
