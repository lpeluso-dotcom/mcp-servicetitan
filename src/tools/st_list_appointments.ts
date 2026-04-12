// ============================================================
// st_list_appointments — list ST appointments (scheduled date source of truth)
// Cache TTL: none (live data)
// ============================================================

import type { Env } from '../env';
import { authHeaders } from '../auth';
import { cacheGet } from '../cache';
import { McpError, mapUpstreamStatus } from '../errors';
import type { ToolDef } from './index';

const TENANT_ID = '431848990';
const NAMESPACE = 'servicetitan:appointments';
const CACHE_TTL_SEC = 0;

interface Args {
  page?: number;
  pageSize?: number;
  startsOnOrAfter?: string;
  startsBefore?: string;
  technicianId?: number;
  jobId?: number;
}

export const st_list_appointments: ToolDef<Args> = {
  name: 'st_list_appointments',
  description:
    'List ServiceTitan appointments. Read-only. NOT cached. Use this for scheduled-date queries — the ST Jobs API does NOT have a scheduled date field, Appointments does (start).',
  inputSchema: {
    type: 'object',
    properties: {
      page: { type: 'number', description: 'Page number, default 1' },
      pageSize: { type: 'number', description: 'Page size, default 50, max 200' },
      startsOnOrAfter: { type: 'string', description: 'ISO 8601 — filter start >= this' },
      startsBefore: { type: 'string', description: 'ISO 8601 — filter start < this' },
      technicianId: { type: 'number', description: 'Filter by assigned technician' },
      jobId: { type: 'number', description: 'Filter by job ID' },
    },
    additionalProperties: false,
  },
  async handler(env, args, { actor, correlation }) {
    const page = args.page ?? 1;
    const pageSize = Math.min(args.pageSize ?? 50, 200);
    const qs = new URLSearchParams();
    qs.set('page', String(page));
    qs.set('pageSize', String(pageSize));
    if (args.startsOnOrAfter) qs.set('startsOnOrAfter', args.startsOnOrAfter);
    if (args.startsBefore) qs.set('startsBefore', args.startsBefore);
    if (args.technicianId) qs.set('technicianId', String(args.technicianId));
    if (args.jobId) qs.set('jobId', String(args.jobId));
    const endpoint = `/jpm/v2/tenant/${TENANT_ID}/appointments?${qs.toString()}`;
    const cacheKey = qs.toString();

    return cacheGet(env, NAMESPACE, cacheKey, CACHE_TTL_SEC, async () => {
      const url = `${env.TAYLOR_AI_URL}/api/st/read?endpoint=${encodeURIComponent(endpoint)}`;
      const resp = await fetch(url, { headers: authHeaders(env, correlation, actor) });
      if (!resp.ok) {
        const body = await resp.text().catch(() => '');
        throw new McpError(mapUpstreamStatus(resp.status), `ST list_appointments ${resp.status}: ${body.slice(0, 200)}`, { correlation });
      }
      return resp.json();
    });
  },
};
