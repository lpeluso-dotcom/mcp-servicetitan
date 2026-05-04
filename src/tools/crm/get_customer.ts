import { z } from 'zod';
import { McpError } from '../../errors';
import { authHeaders } from '../../auth';
import { cacheGet } from '../../cache';
import type { ToolDef } from '../index';

interface Args { customerId: number }

export const get_customer: ToolDef<Args> = {
  name: 'get_customer',
  description: 'Get a single ST customer by ID. Source: live ST.',
  zodSchema: {
    customerId: z.number().int().positive().describe('ST customer ID'),
  },
  async handler(env, args, { actor, correlation }) {
    return cacheGet(env, 'servicetitan:get_customer', String(args.customerId), 60, async () => {
      const resp = await env.ST_PROXY.fetch(
        `https://servicetitan-proxy/api/st/read?endpoint=${encodeURIComponent(`/crm/v2/tenant/000000000/customers/${args.customerId}`)}`,
        { headers: authHeaders(env, correlation, actor) }
      );
      if (!resp.ok) throw new McpError('upstream_error', `get_customer failed: ${resp.status}`, { correlation });
      const customer = await resp.json();
      return { customer, _source: 'live' };
    });
  },
};
