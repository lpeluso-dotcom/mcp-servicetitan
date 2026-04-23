import { z } from 'zod';
import { McpError } from '../../errors';
import { authHeaders } from '../../auth';
import type { ToolDef } from '../index';

interface Args { customerId?: number; locationId?: number; page?: number; pageSize?: number }

export const list_memberships_active: ToolDef<Args> = {
  name: 'list_memberships_active',
  description: 'List active memberships. Source: live ST (no D1 table for memberships — all membership tools hit live ST).',
  zodSchema: {
    customerId: z.number().int().positive().optional().describe('Filter by customer ID'),
    locationId: z.number().int().positive().optional().describe('Filter by location ID'),
    page: z.number().int().positive().default(1).describe('Page number'),
    pageSize: z.number().int().positive().max(200).default(50).describe('Page size, max 200'),
  },
  async handler(env, args, { actor, correlation }) {
    const qs = new URLSearchParams();
    qs.set('statuses', 'Active');
    if (args.customerId) qs.set('customerId', String(args.customerId));
    if (args.locationId) qs.set('locationId', String(args.locationId));
    qs.set('page', String(args.page ?? 1));
    qs.set('pageSize', String(args.pageSize ?? 50));

    const resp = await env.TAYLOR_AI.fetch(
      `https://taylor-ai/api/st/read?endpoint=${encodeURIComponent(`/memberships/v2/tenant/431848990/memberships?${qs}`)}`,
      { headers: authHeaders(env, correlation, actor) }
    );
    if (!resp.ok) throw new McpError('upstream_error', `list_memberships_active failed: ${resp.status}`, { correlation });
    const data = await resp.json<{ data?: unknown[] }>();
    return { memberships: data.data ?? [], _source: 'live' };
  },
};
