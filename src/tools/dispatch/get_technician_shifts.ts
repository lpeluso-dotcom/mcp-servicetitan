import { z } from 'zod';
import { McpError } from '../../errors';
import { authHeaders } from '../../auth';
import type { ToolDef } from '../index';

interface Args { technicianId: number; startsOnOrAfter?: string; startsBefore?: string; page?: number; pageSize?: number }

export const get_technician_shifts: ToolDef<Args> = {
  name: 'get_technician_shifts',
  description: 'Get scheduled shifts for a technician. Source: live ST (shifts are computed, not in D1).',
  zodSchema: {
    technicianId: z.number().int().positive().describe('ST technician ID'),
    startsOnOrAfter: z.string().optional().describe('Filter shifts starting on or after this date (ISO 8601)'),
    startsBefore: z.string().optional().describe('Filter shifts starting before this date (ISO 8601)'),
    page: z.number().int().positive().default(1).describe('Page number'),
    pageSize: z.number().int().positive().max(200).default(50).describe('Page size, max 200'),
  },
  async handler(env, args, { actor, correlation }) {
    const qs = new URLSearchParams();
    qs.set('technicianIds', String(args.technicianId));
    if (args.startsOnOrAfter) qs.set('startsOnOrAfter', args.startsOnOrAfter);
    if (args.startsBefore) qs.set('startsBefore', args.startsBefore);
    qs.set('page', String(args.page ?? 1));
    qs.set('pageSize', String(args.pageSize ?? 50));

    const resp = await env.ST_PROXY.fetch(
      `https://servicetitan-proxy/api/st/read?endpoint=${encodeURIComponent(`/dispatch/v2/tenant/000000000/shifts?${qs}`)}`,
      { headers: authHeaders(env, correlation, actor) }
    );
    if (!resp.ok) throw new McpError('upstream_error', `get_technician_shifts failed: ${resp.status}`, { correlation });
    const data = await resp.json<{ data?: unknown[] }>();
    return { shifts: data.data ?? [], _source: 'live' };
  },
};
