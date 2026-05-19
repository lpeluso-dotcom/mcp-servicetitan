// ============================================================
// st_list_appointments — list ST appointments (scheduled date source of truth)
// Cache TTL: none (live data)
// ============================================================

import { z } from 'zod';
import { cacheGet } from '../cache';
import { readST } from '../st-read';
import type { ToolDef } from './index';

const TENANT_ID = '000000000';
const NAMESPACE = 'servicetitan:appointments';
const CACHE_TTL_SEC = 0;

interface Args {
  page?: number;
  pageSize?: number;
  startsOnOrAfter?: string;
  startsBefore?: string;
  technicianId?: number;
  jobId?: number;
  active?: boolean;
}

export const st_list_appointments: ToolDef<Args> = {
  name: 'st_list_appointments',
  description:
    'List ServiceTitan appointments. Read-only. NOT cached. Use this for scheduled-date queries - the ST Jobs API does NOT have a scheduled date field, Appointments does (start). ST-77 adds active field/filter support; ST-77.1 returns appointmentSummaries.',
  zodSchema: {
    page: z.number().int().positive().optional().describe('Page number, default 1'),
    pageSize: z.number().int().positive().max(200).optional().describe('Page size, default 50, max 200'),
    startsOnOrAfter: z.string().optional().describe('ISO 8601 — filter start >= this'),
    startsBefore: z.string().optional().describe('ISO 8601 — filter start < this'),
    technicianId: z.number().int().positive().optional().describe('Filter by assigned technician'),
    jobId: z.number().int().positive().optional().describe('Filter by job ID'),
    active: z.boolean().optional().describe('ST-77 filter: active=true or active=false; omit for both.'),
  },
  stEndpoint: {
    method: 'GET',
    path: '/jpm/v2/tenant/{tid}/appointments',
    source: 'live',
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
    if (args.active !== undefined) qs.set('active', String(args.active));
    const cacheKey = qs.toString();

    return cacheGet(env, NAMESPACE, cacheKey, CACHE_TTL_SEC, async () => {
      return readST(env, `/jpm/v2/tenant/${TENANT_ID}/appointments?${qs.toString()}`, { actor, correlation });
    });
  },
};
