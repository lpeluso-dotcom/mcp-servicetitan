import { z } from 'zod';
import { McpError } from '../../errors';
import { authHeaders } from '../../auth';
import { cacheGet } from '../../cache';
import { resolveBusinessUnit, resolveTechnician } from '../../name-resolver';
import type { ToolDef } from '../index';

interface Args {
  status?: string;
  businessUnitId?: number;
  businessUnitName?: string;
  technicianId?: number;
  technicianName?: string;
  page?: number;
  pageSize?: number;
}

export const list_jobs_today: ToolDef<Args> = {
  name: 'list_jobs_today',
  description: 'List ST jobs scheduled for today. v1.4 accepts businessUnitName / technicianName as alternatives to numeric IDs. Source: live ST.',
  zodSchema: {
    status: z.string().optional().describe('Filter by job status (e.g. "Scheduled", "InProgress")'),
    businessUnitId: z.number().int().positive().optional().describe('Filter by business unit ID'),
    businessUnitName: z.string().min(1).optional().describe('Filter by business unit name (resolved against business_units D1).'),
    technicianId: z.number().int().positive().optional().describe('Filter by assigned technician ID'),
    technicianName: z.string().min(1).optional().describe('Filter by technician name (resolved against technicians D1).'),
    page: z.number().int().positive().optional(),
    pageSize: z.number().int().positive().max(200).optional(),
  },
  async handler(env, args, { actor, correlation }) {
    if (args.businessUnitId !== undefined && args.businessUnitName !== undefined) {
      throw new McpError('validation_error', 'pass at most one of businessUnitId or businessUnitName', { correlation });
    }
    if (args.technicianId !== undefined && args.technicianName !== undefined) {
      throw new McpError('validation_error', 'pass at most one of technicianId or technicianName', { correlation });
    }

    const warnings: string[] = [];
    let buId = args.businessUnitId;
    if (args.businessUnitName !== undefined) {
      const r = await resolveBusinessUnit(env, args.businessUnitName, 'read');
      buId = r.id;
      if (r.ambiguous) warnings.push(`businessUnit_name_ambiguous: chose ${r.id} for "${args.businessUnitName}"`);
    }
    let techId = args.technicianId;
    if (args.technicianName !== undefined) {
      const r = await resolveTechnician(env, args.technicianName, 'read');
      techId = r.id;
      if (r.ambiguous) warnings.push(`technician_name_ambiguous: chose ${r.id} for "${args.technicianName}"`);
    }

    const today = new Date().toISOString().slice(0, 10);
    const cacheKey = JSON.stringify({ today, status: args.status ?? '', bu: buId ?? 0, tech: techId ?? 0, page: args.page ?? 0, pageSize: args.pageSize ?? 0 });

    const result = await cacheGet(env, 'servicetitan:list_jobs_today', cacheKey, 60, async () => {
      const qs = new URLSearchParams({ scheduledOnOrAfter: `${today}T00:00:00`, scheduledOnOrBefore: `${today}T23:59:59` });
      if (args.status) qs.set('jobStatus', args.status);
      if (buId !== undefined) qs.set('businessUnitId', String(buId));
      if (techId !== undefined) qs.set('technicianId', String(techId));
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

    return warnings.length > 0 ? { ...result, _warnings: warnings } : result;
  },
};
