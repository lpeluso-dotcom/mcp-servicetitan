// ============================================================
// st_list_jobs — list ST jobs
// Cache TTL: none (live data)
//
// v1.5.1 (ST-77): documents `isAutoDispatched` on each row. Migrated to
// the shared readST helper.
// ============================================================

import { z } from 'zod';
import { cacheGet } from '../cache';
import { readST } from '../st';
import type { ToolDef } from './index';

const TENANT_ID = '000000000';
const NAMESPACE = 'servicetitan:jobs';
const CACHE_TTL_SEC = 0;

interface Args {
  page?: number;
  pageSize?: number;
  customerId?: number;
  jobStatus?: string;
  modifiedOnOrAfter?: string;
}

export const st_list_jobs: ToolDef<Args> = {
  name: 'st_list_jobs',
  description:
    'List ServiceTitan jobs. Read-only. NOT cached (jobs change frequently). ' +
    'ST-77: each row includes `isAutoDispatched` (boolean) and `projectId`. ' +
    'Note: the Jobs API does NOT include the scheduled date — use st_list_appointments with start filter instead.',
  zodSchema: {
    page: z.number().int().positive().optional().describe('Page number, default 1'),
    pageSize: z.number().int().positive().max(200).optional().describe('Page size, default 50, max 200'),
    customerId: z.number().int().positive().optional().describe('Filter by ST customer ID'),
    jobStatus: z
      .string()
      .optional()
      .describe('ST job status filter (Scheduled, InProgress, Hold, Completed, Canceled, etc.)'),
    modifiedOnOrAfter: z.string().optional().describe('ISO 8601 timestamp filter'),
  },
  stEndpoint: {
    method: 'GET',
    path: '/jpm/v2/tenant/{tid}/jobs',
    source: 'live',
  },
  async handler(env, args, { actor, correlation }) {
    const page = args.page ?? 1;
    const pageSize = Math.min(args.pageSize ?? 50, 200);
    const query: Record<string, unknown> = { page, pageSize };
    if (args.customerId) query.customerId = args.customerId;
    if (args.jobStatus) query.jobStatus = args.jobStatus;
    if (args.modifiedOnOrAfter) query.modifiedOnOrAfter = args.modifiedOnOrAfter;

    const cacheKey = JSON.stringify(query);
    return cacheGet(env, NAMESPACE, cacheKey, CACHE_TTL_SEC, async () => {
      return readST(env, { actor, correlation }, `/jpm/v2/tenant/${TENANT_ID}/jobs`, query);
    });
  },
};
