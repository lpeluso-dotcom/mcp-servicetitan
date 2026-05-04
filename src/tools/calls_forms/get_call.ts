import { z } from 'zod';
import { McpError } from '../../errors';
import { authHeaders } from '../../auth';
import type { ToolDef } from '../index';

interface Args { callId: number }

export const get_call: ToolDef<Args> = {
  name: 'get_call',
  description: 'Get details for a telecom call record including duration, campaign attribution, and recording info. Source: D1 (calls nightly-synced).',
  zodSchema: {
    callId: z.number().int().positive().describe('ST call ID'),
  },
  async handler(env, args, { actor, correlation }) {
    const resp = await env.ST_PROXY.fetch(
      `https://servicetitan-proxy/api/st/read?endpoint=${encodeURIComponent(`/telecom/v3/tenant/000000000/calls/${args.callId}`)}`,
      { headers: authHeaders(env, correlation, actor) }
    );
    if (!resp.ok) throw new McpError('upstream_error', `get_call failed: ${resp.status}`, { correlation });
    const data = await resp.json<unknown>();
    return { call: data, _source: 'live' };
  },
};
