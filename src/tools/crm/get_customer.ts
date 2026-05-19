import { z } from 'zod';
import { cacheGet } from '../../cache';
import { readST } from '../../st';
import type { ToolDef } from '../index';

interface Args { customerId: number }

export const get_customer: ToolDef<Args> = {
  name: 'get_customer',
  description: 'Get a single ST customer by ID. Source: live ST.',
  zodSchema: {
    customerId: z.number().int().positive().describe('ST customer ID'),
  },
  stEndpoint: { method: 'GET', path: '/crm/v2/tenant/{tid}/customers/{customerId}', source: 'live' },
  async handler(env, args, { actor, correlation }) {
    return cacheGet(env, 'servicetitan:get_customer', String(args.customerId), 60, async () => {
      const customer = await readST(
        env,
        { actor, correlation },
        `/crm/v2/tenant/000000000/customers/${args.customerId}`,
      );
      return { customer, _source: 'live' };
    });
  },
};
