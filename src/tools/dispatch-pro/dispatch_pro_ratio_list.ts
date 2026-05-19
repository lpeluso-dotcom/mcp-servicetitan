import { z } from 'zod';
import { McpError } from '../../errors';
import { defaultShaper } from '../../response-shape';
import { readD1 } from '../../d1';
import type { ToolDef } from '../index';

interface Args {
  startDate?: string;
  endDate?: string;
  businessUnitFilter?: string;
  jobTypeFilter?: string;
  daysOfWeekFilter?: string;
  page?: number;
  pageSize?: number;
}

interface Row {
  completed_on: string;
  business_unit_filter: string;
  job_type_filter: string;
  days_of_week_filter: string;
  month_string: string | null;
  month_number: number | null;
  day: number | null;
  day_of_week: string | null;
  unadjusted_jobs: number;
  smart_dispatch_assigned_jobs: number;
  total_jobs: number;
  unadjusted_over_sd_assigned: number;
  unadjusted_over_total: number;
  synced_at: string | null;
}

const DEFAULT_PAGESIZE = 100;
const MAX_PAGESIZE = 500;

export const dispatch_pro_ratio_list: ToolDef<Args> = {
  name: 'dispatch_pro_ratio_list',
  description:
    'Daily Dispatch Pro ratio rows from the ST native report (id 80770546). ' +
    'Tracks unadjusted vs smart-dispatch-assigned vs total jobs, per completed_on × business_unit × job_type × days_of_week. ' +
    'Source: D1 `dispatch_pro_ratio`.',
  zodSchema: {
    startDate: z.string().optional().describe("ISO date 'YYYY-MM-DD'. Filters completed_on >= value."),
    endDate: z.string().optional().describe("ISO date 'YYYY-MM-DD'. Filters completed_on <= value."),
    businessUnitFilter: z.string().optional().describe("Exact business_unit_filter value (default 'ALL')."),
    jobTypeFilter: z.string().optional().describe("Exact job_type_filter value (default 'ALL')."),
    daysOfWeekFilter: z.string().optional().describe("Exact days_of_week_filter value (default 'ALL')."),
    page: z.number().int().positive().optional().describe('Page number, default 1.'),
    pageSize: z
      .number()
      .int()
      .positive()
      .max(MAX_PAGESIZE)
      .optional()
      .describe(`Page size, default ${DEFAULT_PAGESIZE}, max ${MAX_PAGESIZE}.`),
  },
  stEndpoint: {
    method: 'GET',
    path: '/reporting/v2/tenant/{tid}/report-category/operations/reports/80770546/data',
    source: 'd1',
  },
  async handler(env, args, { correlation }) {
    const page = args.page ?? 1;
    const pageSize = Math.min(args.pageSize ?? DEFAULT_PAGESIZE, MAX_PAGESIZE);
    const where: string[] = [];
    const params: unknown[] = [];

    if (args.startDate !== undefined) {
      where.push('completed_on >= ?');
      params.push(args.startDate);
    }
    if (args.endDate !== undefined) {
      where.push('completed_on <= ?');
      params.push(args.endDate);
    }
    if (args.businessUnitFilter !== undefined) {
      where.push('business_unit_filter = ?');
      params.push(args.businessUnitFilter);
    }
    if (args.jobTypeFilter !== undefined) {
      where.push('job_type_filter = ?');
      params.push(args.jobTypeFilter);
    }
    if (args.daysOfWeekFilter !== undefined) {
      where.push('days_of_week_filter = ?');
      params.push(args.daysOfWeekFilter);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const offset = (page - 1) * pageSize;
    const sql =
      `SELECT * FROM dispatch_pro_ratio ${whereSql} ` +
      `ORDER BY completed_on DESC, business_unit_filter ASC ` +
      `LIMIT ? OFFSET ?`;

    try {
      const { rows } = await readD1<Row>(env, sql, [...params, pageSize + 1, offset]);
      const hasMore = rows.length > pageSize;
      const slice = hasMore ? rows.slice(0, pageSize) : rows;
      return {
        count: slice.length,
        rows: slice,
        has_more: hasMore,
        _source: 'd1',
      };
    } catch (err) {
      throw new McpError(
        'upstream_error',
        `dispatch_pro_ratio_list failed: ${(err as Error).message}`,
        { correlation },
      );
    }
  },
  transformResult: defaultShaper,
};
