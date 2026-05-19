// ============================================================
// open_opportunities_pulitzer_feed — same cohort shape as Pulitzer's
// `open-opportunities` daily report, exposed for MCP callers.
//
// Returns Opportunities not in (Won, Dismissed) with active=1, joined to
// the most-recent estimate and the customer.  Sorted by follow_up_date
// (oldest first — "needs attention" lands at the top).
//
// Source: D1 (opportunities + estimates + customers).
// ============================================================
import { z } from 'zod';
import { defaultShaper } from '../../response-shape';
import { readD1 } from '../../d1';
import type { ToolDef } from '../index';

interface Args {
  businessUnit?: string;
  jobTypeName?: string;
  daysOverdue?: number;
  limit?: number;
}

interface FeedRow {
  opportunity_id: number;
  job_id: number | null;
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
  job_type_name: string | null;
  business_unit: string | null;
  technicians_json: string | null;
  location_name: string | null;
  location_address: string | null;
  created_date: string | null;
  modified_date: string | null;
  job_completed_on: string | null;
  // joined from estimates
  latest_estimate_id: number | null;
  latest_estimate_name: string | null;
  latest_estimate_status: string | null;
  latest_estimate_total: number | null;
  latest_estimate_modified_at: string | null;
}

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

function parseJsonArray(s: string | null): unknown[] {
  if (!s) return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

export const open_opportunities_pulitzer_feed: ToolDef<Args> = {
  name: 'open_opportunities_pulitzer_feed',
  description:
    'Cohort feed of open Opportunities (status NOT IN (Won, Dismissed) AND active=1) joined to the ' +
    'most-recent linked estimate and the customer. Same shape Pulitzer’s `open-opportunities` daily ' +
    'report ships, exposed for other MCP callers. Sorted by follow_up_date ASC so overdue rows lead. ' +
    'Source: D1 opportunities + estimates.',
  zodSchema: {
    businessUnit: z.string().optional().describe('Filter to one business unit.'),
    jobTypeName: z.string().optional().describe('Filter to one job type.'),
    daysOverdue: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe('If set, only return rows where follow_up_date is older than today by N days.'),
    limit: z
      .number()
      .int()
      .positive()
      .max(MAX_LIMIT)
      .optional()
      .describe(`Result cap, default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}.`),
  },
  async handler(env, args, { correlation: _correlation }) {
    const limit = Math.min(args.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
    const where: string[] = [
      "o.status NOT IN ('Won', 'Dismissed')",
      'o.active = 1',
    ];
    const params: unknown[] = [];
    if (args.businessUnit !== undefined) {
      where.push('o.business_unit = ?');
      params.push(args.businessUnit);
    }
    if (args.jobTypeName !== undefined) {
      where.push('o.job_type_name = ?');
      params.push(args.jobTypeName);
    }
    if (args.daysOverdue !== undefined) {
      // SQLite date('now', '-N days')
      where.push(`o.follow_up_date IS NOT NULL AND o.follow_up_date <= date('now', '-${args.daysOverdue} days')`);
    }

    const sql =
      `SELECT o.opportunity_id, o.job_id, o.project_id, o.customer_id,
              o.customer_name, o.customer_phone, o.status,
              o.follow_up_date, o.last_follow_up_date, o.follow_ups_count,
              o.estimate_amount, o.sold_estimate_amount, o.open_estimates_count,
              o.job_type_name, o.business_unit, o.technicians_json,
              o.location_name, o.location_address,
              o.created_date, o.modified_date, o.job_completed_on,
              e.estimate_id      AS latest_estimate_id,
              e.name             AS latest_estimate_name,
              e.status           AS latest_estimate_status,
              e.total            AS latest_estimate_total,
              e.modified_at      AS latest_estimate_modified_at
       FROM opportunities o
       LEFT JOIN estimates e ON e.estimate_id = (
         SELECT estimate_id FROM estimates
         WHERE (job_id = o.job_id OR project_id = o.project_id) AND active = 1
         ORDER BY modified_at DESC LIMIT 1
       )
       WHERE ${where.join(' AND ')}
       ORDER BY o.follow_up_date ASC NULLS LAST, o.modified_date DESC
       LIMIT ?`;

    const { rows } = await readD1<FeedRow>(env, sql, [...params, limit]);

    const out = rows.map((r) => ({
      ...r,
      technicians: parseJsonArray(r.technicians_json),
    }));

    // Cohort summary — useful for a caller deciding whether to fan out.
    const totalEstimateAmount = out.reduce((acc, r) => acc + (r.estimate_amount ?? 0), 0);
    const totalSoldAmount = out.reduce((acc, r) => acc + (r.sold_estimate_amount ?? 0), 0);

    return {
      filters: {
        businessUnit: args.businessUnit ?? null,
        jobTypeName: args.jobTypeName ?? null,
        daysOverdue: args.daysOverdue ?? null,
      },
      summary: {
        count: out.length,
        total_estimate_amount: Number(totalEstimateAmount.toFixed(2)),
        total_sold_amount: Number(totalSoldAmount.toFixed(2)),
      },
      opportunities: out,
      _composite: 'open_opportunities_pulitzer_feed',
      _source: 'd1',
    };
  },
  transformResult: defaultShaper,
};
