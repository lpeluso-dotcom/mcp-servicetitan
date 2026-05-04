import { z } from 'zod';
import { McpError } from '../../errors';
import { authHeaders } from '../../auth';
import { cacheGet } from '../../cache';
import type { ToolDef } from '../index';

interface Args { status?: string; businessUnitId?: number; technicianId?: number; page?: number; pageSize?: number }

export const list_jobs_today: ToolDef<Args> = {
  name: 'list_jobs_today',
  description: 'List ST jobs scheduled for today. Source: live ST.',
  zodSchema: {
    status: z.string().optional().describe('Filter by job status (e.g. "Scheduled", "InProgress")'),
    businessUnitId: z.number().int().positive().optional().describe('Filter by business unit'),
    technicianId: z.number().int().positive().optional().describe('Filter by assigned technician'),
    page: z.number().int().positive().optional(),
    pageSize: z.number().int().positive().max(200).optional(),
  },
  async handler(env, args, { actor, correlation }) {
    const today = new Date().toISOString().slice(0, 10);
    const cacheKey = JSON.stringify({ today, status: args.status ?? '', bu: args.businessUnitId ?? 0, tech: args.technicianId ?? 0, page: args.page ?? 0, pageSize: args.pageSize ?? 0 });

    return cacheGet(env, 'servicetitan:list_jobs_today', cacheKey, 60, async () => {
      const qs = new URLSearchParams({ scheduledOnOrAfter: `${today}T00:00:00`, scheduledOnOrBefore: `${today}T23:59:59` });
      if (args.status) qs.set('jobStatus', args.status);
      if (args.businessUnitId) qs.set('businessUnitId', String(args.businessUnitId));
      if (args.technicianId) qs.set('technicianId', String(args.technicianId));
      if (args.page) qs.set('page', String(args.page));
      if (args.pageSize) qs.set('pageSize', String(args.pageSize));

      const resp = await env.ST_PROXY.fetch(
        `https://servicetitan-proxy/api/st/read?endpoint=${encodeURIComponent(`/jpm/v2/tenant/000000000/jobs?${qs}`)}`,
        { headers: authHeaders(env, correlation, actor) }
      );
      if (!resp.ok) throw new McpError('upstream_error', `list_jobs_today failed: ${resp.status}`, { correlation });
      const data = await resp.json<{ data?: unknown[] }>();
      return { jobs: data.data ?? [], date: today, _source: 'live' };
    });
  },
};
