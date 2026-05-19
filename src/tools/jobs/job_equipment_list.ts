import { z } from 'zod';
import { readST } from '../../st-read';
import type { ToolDef } from '../index';

const TENANT_ID = '000000000';

interface Args {
  jobId: number;
  page?: number;
  pageSize?: number;
}

function rowsFrom(value: any): unknown[] {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.data)) return value.data;
  if (Array.isArray(value?.equipment)) return value.equipment;
  return [];
}

export const job_equipment_list: ToolDef<Args> = {
  name: 'job_equipment_list',
  description:
    'List equipment attached to a ServiceTitan job. Added by ST-77.1 job equipment endpoint. Source: live ST.',
  zodSchema: {
    jobId: z.number().int().positive().describe('ST job ID'),
    page: z.number().int().positive().optional().describe('Page number, default 1'),
    pageSize: z.number().int().positive().max(200).optional().describe('Page size, default 50, max 200'),
  },
  stEndpoint: {
    method: 'GET',
    path: '/jpm/v2/tenant/{tid}/jobs/{jobId}/equipment',
    source: 'live',
  },
  async handler(env, args, { actor, correlation }) {
    const qs = new URLSearchParams();
    qs.set('page', String(args.page ?? 1));
    qs.set('pageSize', String(Math.min(args.pageSize ?? 50, 200)));
    const data: any = await readST(env, `/jpm/v2/tenant/${TENANT_ID}/jobs/${args.jobId}/equipment?${qs.toString()}`, {
      actor,
      correlation,
    });
    return { equipment: rowsFrom(data), has_more: !!data?.hasMore, _source: 'live' };
  },
};
