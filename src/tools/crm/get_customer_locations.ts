import { z } from 'zod';
import { McpError } from '../../errors';
import { authHeaders } from '../../auth';
import type { ToolDef } from '../index';

interface Args { customerId: number; active?: boolean }

export const get_customer_locations: ToolDef<Args> = {
  name: 'get_customer_locations',
  description: 'Get service locations for a customer. Source: live ST.',
  zodSchema: {
    customerId: z.number().int().positive().describe('ST customer ID'),
    active: z.boolean().optional().describe('Filter to active locations only'),
  },
  async handler(env, args, { actor, correlation }) {
    const qs = new URLSearchParams({ customerId: String(args.customerId) });
    if (args.active !== undefined) qs.set('active', String(args.active));
    const resp = await env.ST_PROXY.fetch(
      `https://servicetitan-proxy/api/st/read?endpoint=${encodeURIComponent(`/crm/v2/tenant/000000000/locations?${qs}`)}`,
      { headers: authHeaders(env, correlation, actor) }
    );
    if (!resp.ok) throw new McpError('upstream_error', `get_customer_locations failed: ${resp.status}`, { correlation });
    const data = await resp.json<{ data?: unknown[] }>();
    return { locations: data.data ?? [], _source: 'live' };
  },
};
