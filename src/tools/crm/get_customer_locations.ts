import { z } from 'zod';
import { readST } from '../../st';
import type { ToolDef } from '../index';

interface Args { customerId: number; active?: boolean }

export const get_customer_locations: ToolDef<Args> = {
  name: 'get_customer_locations',
  description: 'Get service locations for a customer. Source: live ST.',
  zodSchema: {
    customerId: z.number().int().positive().describe('ST customer ID'),
    active: z.boolean().optional().describe('Filter to active locations only'),
  },
  stEndpoint: { method: 'GET', path: '/crm/v2/tenant/{tid}/locations', source: 'live' },
  async handler(env, args, { actor, correlation }) {
    const query: Record<string, unknown> = { customerId: args.customerId };
    if (args.active !== undefined) query.active = args.active;
    const data = await readST<{ data?: unknown[] }>(
      env,
      { actor, correlation },
      `/crm/v2/tenant/000000000/locations`,
      query,
    );
    return { locations: data.data ?? [], _source: 'live' };
  },
};
