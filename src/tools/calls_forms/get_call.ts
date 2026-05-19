import { z } from 'zod';
import { readST } from '../../st';
import type { ToolDef } from '../index';

interface Args { callId: number }

export const get_call: ToolDef<Args> = {
  name: 'get_call',
  description: 'Get details for a telecom call record including duration, campaign attribution, and recording info. Source: D1 (calls nightly-synced).',
  zodSchema: {
    callId: z.number().int().positive().describe('ST call ID'),
  },
  stEndpoint: { method: 'GET', path: '/telecom/v3/tenant/{tid}/calls/{callId}', source: 'live' },
  async handler(env, args, { actor, correlation }) {
    const data = await readST(env, { actor, correlation }, `/telecom/v3/tenant/000000000/calls/${args.callId}`);
    return { call: data, _source: 'live' };
  },
};
