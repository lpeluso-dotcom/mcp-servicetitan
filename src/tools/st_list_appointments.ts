// ============================================================
// st_list_appointments — list ST appointments (scheduled date source of truth)
// Cache TTL: none (live data)
//
// v1.5.1 (ST-77): added `active` filter — ST-77 surfaces `active` on
// the appointment list endpoint. Forwarded verbatim to the URL so
// the existing filter-preservation contract holds. Migrated to the
// shared readST helper so future header/auth changes land in one place.
// ============================================================

import { z } from 'zod';
import { cacheGet } from '../cache';
import { readST } from '../st';
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
    'List ServiceTitan appointments. Read-only. NOT cached. Use this for scheduled-date queries — ' +
    'the ST Jobs API does NOT have a scheduled date field, Appointments does (start). ' +
    'v1.5.1: supports the ST-77 `active` filter — pass true/false; omit for all. ' +
    'Each row in the response also carries an `active` boolean.',
  zodSchema: {
    page: z.number().int().positive().optional().describe('Page number, default 1'),
    pageSize: z.number().int().positive().max(200).optional().describe('Page size, default 50, max 200'),
    startsOnOrAfter: z.string().optional().describe('ISO 8601 — filter start >= this'),
    startsBefore: z.string().optional().describe('ISO 8601 — filter start < this'),
    technicianId: z.number().int().positive().optional().describe('Filter by assigned technician'),
    jobId: z.number().int().positive().optional().describe('Filter by job ID'),
    active: z
      .boolean()
      .optional()
      .describe('ST-77: filter by active flag. true → active only; false → inactive only; omit → all.'),
  },
  stEndpoint: {
    method: 'GET',
    path: '/jpm/v2/tenant/{tid}/appointments',
    source: 'live',
  },
  async handler(env, args, { actor, correlation }) {
    const page = args.page ?? 1;
    const pageSize = Math.min(args.pageSize ?? 50, 200);
    const query: Record<string, unknown> = { page, pageSize };
    if (args.startsOnOrAfter) query.startsOnOrAfter = args.startsOnOrAfter;
    if (args.startsBefore) query.startsBefore = args.startsBefore;
    if (args.technicianId) query.technicianId = args.technicianId;
    if (args.jobId) query.jobId = args.jobId;
    if (args.active !== undefined) query.active = args.active ? 'True' : 'False';

    const cacheKey = JSON.stringify(query);
    return cacheGet(env, NAMESPACE, cacheKey, CACHE_TTL_SEC, async () => {
      return readST(env, { actor, correlation }, `/jpm/v2/tenant/${TENANT_ID}/appointments`, query);
    });
  },
};
