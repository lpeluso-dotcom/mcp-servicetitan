import { z } from 'zod';
import { McpError } from '../../errors';
import { authHeaders } from '../../auth';
import type { ToolDef } from '../index';

interface Args { technicianId?: number; startsOnOrAfter?: string; startsBefore?: string; page?: number; pageSize?: number }

export const list_non_job_events: ToolDef<Args> = {
  name: 'list_non_job_events',
  description: 'List non-job dispatch events (time-off, training, meetings) for technicians. Source: live ST.',
  zodSchema: {
    technicianId: z.number().int().positive().optional().describe('Filter by technician ID'),
    startsOnOrAfter: z.string().optional().describe('Filter events starting on or after this date (ISO 8601)'),
    startsBefore: z.string().optional().describe('Filter events starting before this date (ISO 8601)'),
    page: z.number().int().positive().default(1).describe('Page number'),
    pageSize: z.number().int().positive().max(200).default(50).describe('Page size, max 200'),
  },
  async handler(env, args, { actor, correlation }) {
    const qs = new URLSearchParams();
    if (args.technicianId) qs.set('technicianIds', String(args.technicianId));
    if (args.startsOnOrAfter) qs.set('startsOnOrAfter', args.startsOnOrAfter);
    if (args.startsBefore) qs.set('startsBefore', args.startsBefore);
    qs.set('page', String(args.page ?? 1));
    qs.set('pageSize', String(args.pageSize ?? 50));

    const resp = await env.TAYLOR_AI.fetch(
      `https://taylor-ai/api/st/read?endpoint=${encodeURIComponent(`/dispatch/v2/tenant/431848990/non-job-appointments?${qs}`)}`,
      { headers: authHeaders(env, correlation, actor) }
    );
    if (!resp.ok) throw new McpError('upstream_error', `list_non_job_events failed: ${resp.status}`, { correlation });
    const data = await resp.json<{ data?: unknown[] }>();
    return { events: data.data ?? [], _source: 'live' };
  },
};
