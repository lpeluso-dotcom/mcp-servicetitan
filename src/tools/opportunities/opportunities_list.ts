import { z } from 'zod';
import { McpError } from '../../errors';
import { defaultShaper } from '../../response-shape';
import { readD1 } from '../../d1';
import type { ToolDef } from '../index';

interface Args {
  status?: 'Not Attempted' | 'Unreachable' | 'Contacted' | 'Won' | 'Dismissed';
  customerId?: number;
  jobId?: number;
  projectId?: number;
  businessUnit?: string;
  jobTypeName?: string;
  followUpOnOrAfter?: string;
  followUpOnOrBefore?: string;
  modifiedOnOrAfter?: string;
  active?: boolean;
  hasOpenEstimates?: boolean;
  page?: number;
  pageSize?: number;
}

interface OpportunityRow {
  opportunity_id: number;
  job_id: number | null;
  location_id: number | null;
  project_id: number | null;
  customer_id: number | null;
  customer_name: string | null;
  customer_phone: string | null;
  status: string | null;
  follow_up_date: string | null;
  last_follow_up_date: string | null;
  follow_ups_count: number | null;
  estimate_amount: number | null;
  sold_estimate_amount: number | null;
  open_estimates_count: number | null;
  sold_estimates_count: number | null;
  recommended_estimates_count: number | null;
  job_type_name: string | null;
  business_unit: string | null;
  technicians_json: string | null;
  created_by_users_json: string | null;
  location_name: string | null;
  location_address: string | null;
  created_date: string | null;
  modified_date: string | null;
  job_completed_on: string | null;
  active: number;
  synced_at: string | null;
}

const DEFAULT_PAGESIZE = 50;
const MAX_PAGESIZE = 200;

function parseJsonArray(s: string | null): unknown[] {
  if (!s) return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

export const opportunities_list: ToolDef<Args> = {
  name: 'opportunities_list',
  description:
    "List ServiceTitan Opportunities from D1 (`opportunities` table — synced from /FollowUps/estimates). " +
    "An Opportunity is the parent container that groups one or more Estimates on a Job/Location/Project. " +
    "Filter by status (Not Attempted/Unreachable/Contacted/Won/Dismissed), customer, job, project, business unit, " +
    "job type, follow-up date window, or open-estimate presence. " +
    "Cohort to use for 'follow-up needed' work: status NOT IN (Won, Dismissed) AND active=1.",
  zodSchema: {
    status: z
      .enum(['Not Attempted', 'Unreachable', 'Contacted', 'Won', 'Dismissed'])
      .optional()
      .describe('Filter by Opportunity status.'),
    customerId: z.number().int().positive().optional().describe('Filter to one customer.'),
    jobId: z.number().int().positive().optional().describe('Filter to one job.'),
    projectId: z.number().int().positive().optional().describe('Filter to one project.'),
    businessUnit: z.string().optional().describe('Exact business unit name (matches business_unit column).'),
    jobTypeName: z.string().optional().describe('Exact job type name (matches job_type_name column).'),
    followUpOnOrAfter: z
      .string()
      .optional()
      .describe('ISO 8601 date. Filters follow_up_date >= value.'),
    followUpOnOrBefore: z
      .string()
      .optional()
      .describe('ISO 8601 date. Filters follow_up_date <= value.'),
    modifiedOnOrAfter: z
      .string()
      .optional()
      .describe('ISO 8601 timestamp. Filters modified_date >= value.'),
    active: z.boolean().optional().describe('Filter by active flag. Default: include all.'),
    hasOpenEstimates: z
      .boolean()
      .optional()
      .describe('Filter by open_estimates_count > 0 (true) or = 0 (false).'),
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
    path: '/sales/v2/tenant/{tid}/opportunities',
    source: 'd1',
  },
  async handler(env, args, { correlation }) {
    const page = args.page ?? 1;
    const pageSize = Math.min(args.pageSize ?? DEFAULT_PAGESIZE, MAX_PAGESIZE);

    const where: string[] = [];
    const params: unknown[] = [];

    if (args.status !== undefined) {
      where.push('status = ?');
      params.push(args.status);
    }
    if (args.customerId !== undefined) {
      where.push('customer_id = ?');
      params.push(args.customerId);
    }
    if (args.jobId !== undefined) {
      where.push('job_id = ?');
      params.push(args.jobId);
    }
    if (args.projectId !== undefined) {
      where.push('project_id = ?');
      params.push(args.projectId);
    }
    if (args.businessUnit !== undefined) {
      where.push('business_unit = ?');
      params.push(args.businessUnit);
    }
    if (args.jobTypeName !== undefined) {
      where.push('job_type_name = ?');
      params.push(args.jobTypeName);
    }
    if (args.followUpOnOrAfter !== undefined) {
      where.push('follow_up_date >= ?');
      params.push(args.followUpOnOrAfter);
    }
    if (args.followUpOnOrBefore !== undefined) {
      where.push('follow_up_date <= ?');
      params.push(args.followUpOnOrBefore);
    }
    if (args.modifiedOnOrAfter !== undefined) {
      where.push('modified_date >= ?');
      params.push(args.modifiedOnOrAfter);
    }
    if (args.active !== undefined) {
      where.push('active = ?');
      params.push(args.active ? 1 : 0);
    }
    if (args.hasOpenEstimates !== undefined) {
      where.push(args.hasOpenEstimates ? 'open_estimates_count > 0' : 'COALESCE(open_estimates_count, 0) = 0');
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const offset = (page - 1) * pageSize;

    const sql =
      `SELECT * FROM opportunities ${whereSql} ` +
      `ORDER BY follow_up_date ASC NULLS LAST, modified_date DESC ` +
      `LIMIT ? OFFSET ?`;

    try {
      const { rows } = await readD1<OpportunityRow>(env, sql, [...params, pageSize + 1, offset]);
      const hasMore = rows.length > pageSize;
      const slice = hasMore ? rows.slice(0, pageSize) : rows;
      const opportunities = slice.map((r) => ({
        ...r,
        active: r.active !== 0,
        technicians: parseJsonArray(r.technicians_json),
        created_by_users: parseJsonArray(r.created_by_users_json),
      }));
      return {
        count: opportunities.length,
        opportunities,
        has_more: hasMore,
        _source: 'd1',
      };
    } catch (err) {
      throw new McpError(
        'upstream_error',
        `opportunities_list failed: ${(err as Error).message}`,
        { correlation },
      );
    }
  },
  transformResult: defaultShaper,
};
