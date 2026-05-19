import { z } from 'zod';
import { McpError } from '../../errors';
import { defaultShaper } from '../../response-shape';
import { readD1 } from '../../d1';
import type { ToolDef } from '../index';

interface Args {
  alertCreatedOnOrAfter?: string;
  alertCreatedOnOrBefore?: string;
  jobId?: number;
  businessUnit?: string;
  jobType?: string;
  dpStatus?: string;
  alertType?: string;
  page?: number;
  pageSize?: number;
}

interface Row {
  alert_id: number;
  job_id: number | null;
  job_number: string | null;
  business_unit: string | null;
  job_type: string | null;
  job_start_time: string | null;
  dp_status: string | null;
  alert_created_date: string | null;
  alert_type: string | null;
  alert_name: string | null;
  synced_at: string | null;
}

const DEFAULT_PAGESIZE = 100;
const MAX_PAGESIZE = 500;

export const dispatch_pro_alerts_list: ToolDef<Args> = {
  name: 'dispatch_pro_alerts_list',
  description:
    'Dispatch Pro alert rows from the ST native report (id 80769010) — one row per alert event ' +
    '(scheduling conflicts, late arrivals, reassignment requests, etc.) with the linked job, business unit, type, ' +
    'and DP status. Source: D1 `dispatch_pro_alerts`.',
  zodSchema: {
    alertCreatedOnOrAfter: z
      .string()
      .optional()
      .describe("ISO 8601 timestamp. Filters alert_created_date >= value."),
    alertCreatedOnOrBefore: z
      .string()
      .optional()
      .describe("ISO 8601 timestamp. Filters alert_created_date <= value."),
    jobId: z.number().int().positive().optional().describe('Filter to one job.'),
    businessUnit: z.string().optional().describe('Exact business_unit match.'),
    jobType: z.string().optional().describe('Exact job_type match.'),
    dpStatus: z.string().optional().describe('Exact dp_status match.'),
    alertType: z.string().optional().describe('Exact alert_type match.'),
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
    path: '/reporting/v2/tenant/{tid}/report-category/operations/reports/80769010/data',
    source: 'd1',
  },
  async handler(env, args, { correlation }) {
    const page = args.page ?? 1;
    const pageSize = Math.min(args.pageSize ?? DEFAULT_PAGESIZE, MAX_PAGESIZE);
    const where: string[] = [];
    const params: unknown[] = [];

    if (args.alertCreatedOnOrAfter !== undefined) {
      where.push('alert_created_date >= ?');
      params.push(args.alertCreatedOnOrAfter);
    }
    if (args.alertCreatedOnOrBefore !== undefined) {
      where.push('alert_created_date <= ?');
      params.push(args.alertCreatedOnOrBefore);
    }
    if (args.jobId !== undefined) {
      where.push('job_id = ?');
      params.push(args.jobId);
    }
    if (args.businessUnit !== undefined) {
      where.push('business_unit = ?');
      params.push(args.businessUnit);
    }
    if (args.jobType !== undefined) {
      where.push('job_type = ?');
      params.push(args.jobType);
    }
    if (args.dpStatus !== undefined) {
      where.push('dp_status = ?');
      params.push(args.dpStatus);
    }
    if (args.alertType !== undefined) {
      where.push('alert_type = ?');
      params.push(args.alertType);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const offset = (page - 1) * pageSize;
    const sql =
      `SELECT * FROM dispatch_pro_alerts ${whereSql} ` +
      `ORDER BY alert_created_date DESC NULLS LAST, alert_id DESC ` +
      `LIMIT ? OFFSET ?`;

    try {
      const { rows } = await readD1<Row>(env, sql, [...params, pageSize + 1, offset]);
      const hasMore = rows.length > pageSize;
      const slice = hasMore ? rows.slice(0, pageSize) : rows;
      return {
        count: slice.length,
        alerts: slice,
        has_more: hasMore,
        _source: 'd1',
      };
    } catch (err) {
      throw new McpError(
        'upstream_error',
        `dispatch_pro_alerts_list failed: ${(err as Error).message}`,
        { correlation },
      );
    }
  },
  transformResult: defaultShaper,
};
