// ============================================================
// st_list_jobs — list ST jobs
// Cache TTL: none (live data)
// ============================================================

import { z } from 'zod';
import { cacheGet } from '../cache';
import { readST } from '../st-read';
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
  equipmentIds?: number[];
}

export const st_list_jobs: ToolDef<Args> = {
  name: 'st_list_jobs',
  description:
    'List ServiceTitan jobs. Read-only. NOT cached (jobs change frequently). Note: the Jobs API does NOT include the scheduled date - use st_list_appointments with start filter instead. ST-77.1 returns isAutoDispatched and summaryOfWork, and adds equipmentIds filtering.',
  zodSchema: {
    page: z.number().int().positive().optional().describe('Page number, default 1'),
    pageSize: z.number().int().positive().max(200).optional().describe('Page size, default 50, max 200'),
    customerId: z.number().int().positive().optional().describe('Filter by ST customer ID'),
    jobStatus: z
      .string()
      .optional()
      .describe('ST job status filter (Scheduled, InProgress, Hold, Completed, Canceled, etc.)'),
    modifiedOnOrAfter: z.string().optional().describe('ISO 8601 timestamp filter'),
    equipmentIds: z
      .array(z.number().int().positive())
      .min(1)
      .max(50)
      .optional()
      .describe('ST-77.1 filter: only jobs with any of these attached equipment IDs'),
  },
  stEndpoint: {
    method: 'GET',
    path: '/jpm/v2/tenant/{tid}/jobs',
    source: 'live',
  },
  async handler(env, args, { actor, correlation }) {
    const page = args.page ?? 1;
    const pageSize = Math.min(args.pageSize ?? 50, 200);
    const qs = new URLSearchParams();
    qs.set('page', String(page));
    qs.set('pageSize', String(pageSize));
    if (args.customerId) qs.set('customerId', String(args.customerId));
    if (args.jobStatus) qs.set('jobStatus', args.jobStatus);
    if (args.modifiedOnOrAfter) qs.set('modifiedOnOrAfter', args.modifiedOnOrAfter);
    if (args.equipmentIds?.length) qs.set('equipmentIds', args.equipmentIds.join(','));
    const endpoint = `/jpm/v2/tenant/${TENANT_ID}/jobs?${qs.toString()}`;
    const cacheKey = qs.toString();

    return cacheGet(env, NAMESPACE, cacheKey, CACHE_TTL_SEC, async () => {
      return readST(env, endpoint, { actor, correlation });
    });
  },
};
