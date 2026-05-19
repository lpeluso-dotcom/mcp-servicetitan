import { z } from 'zod';
import { defaultShaper } from '../../response-shape';
import { readST } from '../../st';
import type { ToolDef } from '../index';

interface Args {
  employeeId?: number;
  activityCodeId?: number;
  fromDate?: string;
  toDate?: string;
  page?: number;
  pageSize?: number;
}

interface RawTimesheet {
  id: number;
  employeeId?: number;
  activityCodeId?: number;
  date?: string;
  hours?: number;
  notes?: string;
}

interface SlimTimesheet {
  id: number;
  employee_id: number | null;
  activity_code_id: number | null;
  date: string | null;
  hours: number;
  notes: string;
}

function slim(t: RawTimesheet): SlimTimesheet {
  return {
    id: t.id,
    employee_id: t.employeeId ?? null,
    activity_code_id: t.activityCodeId ?? null,
    date: t.date ?? null,
    hours: t.hours ?? 0,
    notes: t.notes ?? '',
  };
}

// Back-office tool (no voice consumer); pageSize tuned for PO/receipt
// enumeration, not voice-tier readback. Compare find_customer's tighter caps.
const DEFAULT_PAGESIZE = 25;
const MAX_PAGESIZE = 100;

export const payroll_non_job_timesheets_list: ToolDef<Args> = {
  name: 'payroll_non_job_timesheets_list',
  description:
    'List ServiceTitan non-job timesheets (meeting/training/admin time). Filter by employee, activity code, or date range. Source: live ST.',
  zodSchema: {
    employeeId: z.number().int().positive().optional().describe('Filter by employee ID'),
    activityCodeId: z.number().int().positive().optional().describe('Filter by activity code ID'),
    fromDate: z.string().optional().describe('Return timesheets starting on or after this date (ISO 8601)'),
    toDate: z.string().optional().describe('Return timesheets ending on or before this date (ISO 8601)'),
    page: z.number().int().positive().optional().describe('Page number, default 1'),
    pageSize: z
      .number()
      .int()
      .positive()
      .max(MAX_PAGESIZE)
      .optional()
      .describe(`Page size, default ${DEFAULT_PAGESIZE}, max ${MAX_PAGESIZE}`),
  },
  stEndpoint: { method: 'GET', path: '/payroll/v2/tenant/{tid}/non-job-timesheets', source: 'live' },
  async handler(env, args, { actor, correlation }) {
    const page = args.page ?? 1;
    const pageSize = Math.min(args.pageSize ?? DEFAULT_PAGESIZE, MAX_PAGESIZE);
    const query: Record<string, unknown> = {
      employeeId: args.employeeId,
      activityCodeId: args.activityCodeId,
      startsOnOrAfter: args.fromDate,
      endsOnOrBefore: args.toDate,
      page,
      pageSize,
    };

    const data = await readST<{ data?: RawTimesheet[]; hasMore?: boolean }>(
      env,
      { actor, correlation },
      `/payroll/v2/tenant/${env.ST_TENANT_ID}/non-job-timesheets`,
      query,
    );
    return {
      count: (data.data ?? []).length,
      timesheets: (data.data ?? []).map(slim),
      has_more: !!data.hasMore,
      _source: 'live',
    };
  },
  transformResult: defaultShaper,
};
