import { z } from 'zod';
import { readST } from '../../st';
import type { ToolDef } from '../index';

interface Args { estimateId: number }

export const get_estimate: ToolDef<Args> = {
  name: 'get_estimate',
  description: 'Get full details for a single estimate including line items and status. Source: D1 (estimates nightly-synced).',
  zodSchema: {
    estimateId: z.number().int().positive().describe('ST estimate ID'),
  },
  stEndpoint: { method: 'GET', path: '/sales/v2/tenant/{tid}/estimates/{estimateId}', source: 'live' },
  async handler(env, args, { actor, correlation }) {
    const data = await readST<unknown>(
      env,
      { actor, correlation },
      `/sales/v2/tenant/000000000/estimates/${args.estimateId}`,
    );
    return { estimate: data, _source: 'live' };
  },
};
