import { z } from 'zod';
import { McpError } from '../../errors';
import { defaultShaper } from '../../response-shape';
import { readD1 } from '../../d1';
import { stampMirrorFreshness, fetchTableMax } from '../../mirror-freshness';
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
    'Source: D1 `dispatch_pro_utilization` (synced via taylor-ai POST /api/cron/dispatch-pro-sync; cron not yet wired).',
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
      const [{ rows }, tableMax] = await Promise.all([
        readD1<Row>(env, sql, [...params, pageSize + 1, offset]),
        fetchTableMax(env, ['dispatch_pro_utilization']),
      ]);
      const hasMore = rows.length > pageSize;
      const slice = hasMore ? rows.slice(0, pageSize) : rows;
      // MB-1 / QUA-1141: raw mirror read — the table-level MAX(synced_at)
      // probe discloses the mirror's age so a frozen or empty
      // `dispatch_pro_utilization` can't pass as current truth (the sync
      // cron for this table is not yet wired — see above).
      const freshness = stampMirrorFreshness(rows, { table: 'dispatch_pro_utilization', tableMax });
      return {
        count: slice.length,
        count_is_authoritative: freshness._freshness === 'fresh',
        rows: slice,
        has_more: hasMore,
        _source: 'd1',
        ...freshness,
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
