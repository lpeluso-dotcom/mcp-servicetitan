import { z } from 'zod';
import { McpError } from '../../errors';
import { defaultShaper } from '../../response-shape';
import { readD1 } from '../../d1';
import type { ToolDef } from '../index';

interface Args {
  startDate?: string;
  endDate?: string;
  businessUnitFilter?: string;
  page?: number;
  pageSize?: number;
}

interface Row {
  completed_on: string;
  business_unit_filter: string;
  dispatch_pro_assigned_jobs: number;
  manually_assigned_jobs: number;
  dispatch_pro_enabled_jobs: number;
  utilization_percentage: number;
  day: number | null;
  month: number | null;
  synced_at: string | null;
}

const DEFAULT_PAGESIZE = 100;
const MAX_PAGESIZE = 500;

export const dispatch_pro_utilization_list: ToolDef<Args> = {
  name: 'dispatch_pro_utilization_list',
  description:
    'Daily Dispatch Pro utilization rows from the ST native report (id 80766576). ' +
    'Columns: dispatch_pro_assigned_jobs, manually_assigned_jobs, dispatch_pro_enabled_jobs, utilization_percentage, per completed_on + business_unit_filter. ' +
    'Source: D1 `dispatch_pro_utilization` (synced via taylor-ai POST /api/cron/dispatch-pro-sync; cron not yet wired). Default page size 100, max 500.',
  zodSchema: {
    startDate: z.string().optional().describe("ISO date 'YYYY-MM-DD'. Filters completed_on >= value."),
    endDate: z.string().optional().describe("ISO date 'YYYY-MM-DD'. Filters completed_on <= value."),
    businessUnitFilter: z.string().optional().describe("Exact business_unit_filter value (default 'ALL')."),
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
    path: '/reporting/v2/tenant/{tid}/report-category/operations/reports/80766576/data',
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

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const offset = (page - 1) * pageSize;
    const sql =
      `SELECT * FROM dispatch_pro_utilization ${whereSql} ` +
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
        `dispatch_pro_utilization_list failed: ${(err as Error).message}`,
        { correlation },
      );
    }
  },
  transformResult: defaultShaper,
};
