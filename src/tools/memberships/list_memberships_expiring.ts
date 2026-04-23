import { z } from 'zod';
import { McpError } from '../../errors';
import { authHeaders } from '../../auth';
import type { ToolDef } from '../index';

interface Args { windowDays: number; customerId?: number; page?: number; pageSize?: number }

// Semantics pinned: 'to' BETWEEN now AND now+windowDays AND status='Active'.
// Do NOT use renewedById — unreliable per QSC ops memory.
export const list_memberships_expiring: ToolDef<Args> = {
  name: 'list_memberships_expiring',
  description: 'List active memberships expiring within the next N days. Uses expirationDate range filter (NOT renewedById — unreliable). Source: live ST (no D1 memberships table).',
  zodSchema: {
    windowDays: z.number().int().positive().describe('Number of days ahead to look for expiring memberships (e.g. 30 = expiring within 30 days)'),
    customerId: z.number().int().positive().optional().describe('Filter by customer ID'),
    page: z.number().int().positive().default(1).describe('Page number'),
    pageSize: z.number().int().positive().max(200).default(50).describe('Page size, max 200'),
  },
  async handler(env, args, { actor, correlation }) {
    const now = new Date();
    const windowEnd = new Date(now.getTime() + args.windowDays * 24 * 60 * 60 * 1000);

    const qs = new URLSearchParams();
    qs.set('statuses', 'Active');
    qs.set('activeThroughOnOrAfter', now.toISOString());
    qs.set('activeThroughBefore', windowEnd.toISOString());
    if (args.customerId) qs.set('customerId', String(args.customerId));
    qs.set('page', String(args.page ?? 1));
    qs.set('pageSize', String(args.pageSize ?? 50));

    const resp = await env.TAYLOR_AI.fetch(
      `https://taylor-ai/api/st/read?endpoint=${encodeURIComponent(`/memberships/v2/tenant/431848990/memberships?${qs}`)}`,
      { headers: authHeaders(env, correlation, actor) }
    );
    if (!resp.ok) throw new McpError('upstream_error', `list_memberships_expiring failed: ${resp.status}`, { correlation });
    const data = await resp.json<{ data?: unknown[] }>();
    return { memberships: data.data ?? [], windowDays: args.windowDays, _source: 'live' };
  },
};
