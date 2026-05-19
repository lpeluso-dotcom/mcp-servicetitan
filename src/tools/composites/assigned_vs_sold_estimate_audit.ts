// ============================================================
// assigned_vs_sold_estimate_audit — credit-attribution diagnostic.
//
// ServiceTitan's estimate response has no `assignedTo` field, so the only
// attribution signal is `sold_by` (free-text tech name, only populated when
// status='Sold'). The Q1 job-costing analysis flagged this gap.
//
// This composite returns estimates in a date window where:
//   - sold_by is empty (status Sold but no name attached), OR
//   - sold_by name does not match any technician on the source job's
//     appointment_assignments (case-insensitive), OR
//   - the estimate has no job_id (orphan — can't audit).
//
// Use to:
//   1. Surface tech-credit drift before commission/bonus runs
//   2. Identify estimates that need manual reattribution
//   3. Spot bulk-import or auto-create patterns that skip sold_by
//
// Source: D1 (estimates + appointment_assignments + jobs).
// ============================================================
import { z } from 'zod';
import { defaultShaper } from '../../response-shape';
import { readD1 } from '../../d1';
import type { ToolDef } from '../index';

interface Args {
  startDate: string;
  endDate: string;
  status?: string;
  businessUnit?: string;
  limit?: number;
}

interface EstimateAuditRow {
  estimate_id: number;
  job_id: number | null;
  status: string | null;
  total: number | null;
  sold_by: string | null;
  modified_at: string | null;
  job_business_unit: string | null;
  job_type: string | null;
  job_techs_csv: string | null;
}

interface OutRow {
  estimate_id: number;
  job_id: number | null;
  status: string | null;
  total: number | null;
  sold_by: string | null;
  modified_at: string | null;
  job_business_unit: string | null;
  job_type: string | null;
  job_techs: string[];
  mismatch_reason: 'sold_by_empty' | 'no_job_link' | 'tech_name_mismatch';
}

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;

function normalize(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

export const assigned_vs_sold_estimate_audit: ToolDef<Args> = {
  name: 'assigned_vs_sold_estimate_audit',
  description:
    "Audit estimate credit attribution: returns estimates in a window where sold_by is empty, the " +
    "estimate has no job link, or sold_by doesn't match any tech on the source job's appointment_assignments. " +
    "Useful before commission runs and for spotting bulk-import patterns. " +
    "Source: D1 estimates + appointment_assignments + jobs.",
  zodSchema: {
    startDate: z.string().describe("ISO date 'YYYY-MM-DD'. estimates.modified_at >= startDate."),
    endDate: z.string().describe("ISO date 'YYYY-MM-DD'. estimates.modified_at <= endDate."),
    status: z.string().optional().describe("Optional estimate status filter (e.g. 'Sold', 'Open', 'Dismissed')."),
    businessUnit: z.string().optional().describe('Filter to one business unit (matches jobs.business_unit).'),
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
    const startTs = args.startDate.length === 10 ? `${args.startDate}T00:00:00` : args.startDate;
    const endTs = args.endDate.length === 10 ? `${args.endDate}T23:59:59` : args.endDate;

    const where: string[] = [
      'e.modified_at >= ?',
      'e.modified_at <= ?',
    ];
    const params: unknown[] = [startTs, endTs];
    if (args.status !== undefined) {
      where.push('e.status = ?');
      params.push(args.status);
    }
    if (args.businessUnit !== undefined) {
      where.push('j.business_unit = ?');
      params.push(args.businessUnit);
    }

    const sql =
      `SELECT e.estimate_id, e.job_id, e.status, e.total, e.sold_by, e.modified_at,
              j.business_unit AS job_business_unit, j.job_type,
              (SELECT GROUP_CONCAT(DISTINCT technician_name)
                 FROM appointment_assignments aa
                 WHERE aa.job_id = e.job_id) AS job_techs_csv
       FROM estimates e
       LEFT JOIN jobs j ON j.job_id = e.job_id
       WHERE ${where.join(' AND ')}
       ORDER BY e.modified_at DESC
       LIMIT ?`;

    const { rows } = await readD1<EstimateAuditRow>(env, sql, [...params, limit * 3]);

    // Filter to the mismatch cohort in JS so we can carry the reason cleanly.
    const out: OutRow[] = [];
    for (const r of rows) {
      const jobTechs = r.job_techs_csv
        ? r.job_techs_csv.split(',').map((s) => s.trim()).filter(Boolean)
        : [];
      const soldBy = r.sold_by?.trim() ?? '';
      let reason: OutRow['mismatch_reason'] | null = null;
      if (r.job_id === null) {
        reason = 'no_job_link';
      } else if (soldBy === '') {
        // Only flag empty sold_by when status is Sold — Open estimates with no
        // sold_by are expected.
        if (r.status === 'Sold') reason = 'sold_by_empty';
      } else if (jobTechs.length > 0) {
        const normalizedSold = normalize(soldBy);
        const matched = jobTechs.some((t) => {
          const tn = normalize(t);
          return tn === normalizedSold || tn.includes(normalizedSold) || normalizedSold.includes(tn);
        });
        if (!matched) reason = 'tech_name_mismatch';
      }
      if (reason !== null) {
        out.push({
          estimate_id: r.estimate_id,
          job_id: r.job_id,
          status: r.status,
          total: r.total,
          sold_by: r.sold_by,
          modified_at: r.modified_at,
          job_business_unit: r.job_business_unit,
          job_type: r.job_type,
          job_techs: jobTechs,
          mismatch_reason: reason,
        });
        if (out.length >= limit) break;
      }
    }

    const byReason: Record<string, number> = {};
    for (const r of out) byReason[r.mismatch_reason] = (byReason[r.mismatch_reason] ?? 0) + 1;

    return {
      window: { startDate: args.startDate, endDate: args.endDate },
      filters: { status: args.status ?? null, businessUnit: args.businessUnit ?? null },
      summary: {
        examined: rows.length,
        flagged: out.length,
        by_reason: byReason,
      },
      mismatches: out,
      _composite: 'assigned_vs_sold_estimate_audit',
      _source: 'd1',
    };
  },
  transformResult: defaultShaper,
};
