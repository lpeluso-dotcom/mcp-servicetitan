import { z } from 'zod';
import { McpError } from '../../errors';
import { authHeaders } from '../../auth';
import type { ToolDef } from '../index';

interface Args { date?: string; businessUnitId?: number; page?: number; pageSize?: number }

export const list_technicians_available: ToolDef<Args> = {
  name: 'list_technicians_available',
  description: 'List technicians available for dispatch on a given date. Source: D1 (technicians nightly-synced).',
  stEndpoint: { method: 'GET', path: '/dispatch/v2/tenant/{tid}/technicians', source: 'live' },
  zodSchema: {
    date: z.string().optional().describe('Date to check availability (YYYY-MM-DD, default: today)'),
    businessUnitId: z.number().int().positive().optional().describe('Filter by business unit ID'),
    page: z.number().int().positive().default(1).describe('Page number'),
    pageSize: z.number().int().positive().max(200).default(50).describe('Page size, max 200'),
  },
  async handler(env, args, { actor, correlation }) {
    const qs = new URLSearchParams();
    if (args.date) qs.set('requestedOn', args.date);
    if (args.businessUnitId) qs.set('businessUnitId', String(args.businessUnitId));
    qs.set('page', String(args.page ?? 1));
    qs.set('pageSize', String(args.pageSize ?? 50));

    const resp = await env.ST_PROXY.fetch(
      `https://servicetitan-proxy/api/st/read?endpoint=${encodeURIComponent(`/dispatch/v2/tenant/000000000/technicians?${qs}`)}`,
      { headers: authHeaders(env, correlation, actor) }
    );
    if (!resp.ok) throw new McpError('upstream_error', `list_technicians_available failed: ${resp.status}`, { correlation });
    const data = await resp.json<{ data?: unknown[] }>();
    return { technicians: data.data ?? [], _source: 'live' };
  },
};
