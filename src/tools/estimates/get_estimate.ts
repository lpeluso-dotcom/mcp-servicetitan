import { z } from 'zod';
import { McpError } from '../../errors';
import { authHeaders } from '../../auth';
import type { ToolDef } from '../index';

interface Args { estimateId: number }

export const get_estimate: ToolDef<Args> = {
  name: 'get_estimate',
  description: 'Get full details for a single estimate including line items and status. Source: D1 (estimates nightly-synced).',
  zodSchema: {
    estimateId: z.number().int().positive().describe('ST estimate ID'),
  },
  async handler(env, args, { actor, correlation }) {
    const resp = await env.TAYLOR_AI.fetch(
      `https://taylor-ai/api/st/read?endpoint=${encodeURIComponent(`/sales/v2/tenant/431848990/estimates/${args.estimateId}`)}`,
      { headers: authHeaders(env, correlation, actor) }
    );
    if (!resp.ok) throw new McpError('upstream_error', `get_estimate failed: ${resp.status}`, { correlation });
    const data = await resp.json<unknown>();
    return { estimate: data, _source: 'live' };
  },
};
