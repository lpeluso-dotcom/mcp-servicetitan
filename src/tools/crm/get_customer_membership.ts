import { z } from 'zod';
import { McpError } from '../../errors';
import { authHeaders } from '../../auth';
import type { ToolDef } from '../index';

interface Args { customerId: number; active?: boolean }

export const get_customer_membership: ToolDef<Args> = {
  name: 'get_customer_membership',
  description: 'Get memberships for a customer. Source: live ST (no D1 memberships table).',
  zodSchema: {
    customerId: z.number().int().positive().describe('ST customer ID'),
    active: z.boolean().optional().describe('Filter to active memberships only'),
  },
  async handler(env, args, { actor, correlation }) {
    const qs = new URLSearchParams({ customerId: String(args.customerId) });
    if (args.active !== undefined) qs.set('active', String(args.active));
    const resp = await env.TAYLOR_AI.fetch(
      `https://taylor-ai/api/st/read?endpoint=${encodeURIComponent(`/memberships/v2/tenant/431848990/memberships?${qs}`)}`,
      { headers: authHeaders(env, correlation, actor) }
    );
    if (!resp.ok) throw new McpError('upstream_error', `get_customer_membership failed: ${resp.status}`, { correlation });
    const data = await resp.json<{ data?: unknown[] }>();
    return { memberships: data.data ?? [], _source: 'live' };
  },
};
