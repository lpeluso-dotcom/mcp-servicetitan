import { z } from 'zod';
import { readST } from '../../st';
import type { ToolDef } from '../index';

interface Args { customerId: number; active?: boolean }

export const get_customer_membership: ToolDef<Args> = {
  name: 'get_customer_membership',
  description: 'Get memberships for a customer. Source: live ST (no D1 memberships table).',
  zodSchema: {
    customerId: z.number().int().positive().describe('ST customer ID'),
    active: z.boolean().optional().describe('Filter to active memberships only'),
  },
  stEndpoint: { method: 'GET', path: '/memberships/v2/tenant/{tid}/memberships', source: 'live' },
  async handler(env, args, { actor, correlation }) {
    const query: Record<string, unknown> = { customerId: args.customerId };
    if (args.active !== undefined) query.active = args.active;
    const data = await readST<{ data?: unknown[] }>(
      env,
      { actor, correlation },
      `/memberships/v2/tenant/000000000/memberships`,
      query,
    );
    return { memberships: data.data ?? [], _source: 'live' };
  },
};
