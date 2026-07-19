// ============================================================
// tech_scorecard — per-tech weekly rollup (one tech or all) from D1.
// jobs, drive/working minutes, drive%, labor burden. Pure SQL, no live ST.
// Source: D1 job_timesheets joined to technicians. Sourced from D1 (not gold)
// because gold has no timesheet/labor grain. Mirrors tech_drive_time_summary.
// ============================================================
import { z } from 'zod';
import { defaultShaper } from '../../response-shape';
import { readD1 } from '../../d1';
import type { ToolDef } from '../index';

interface Args {
  technicianId?: number;
  weekStart: string;
  weekEnd: string;
  burdenRate?: number;
}

interface Row {
  technician_id: number;
  name: string | null;
  business_unit: string | null;
  jobs: number;
  drive_minutes: number;
  working_minutes: number;
}

const DEFAULT_BURDEN_RATE = 45;

export const tech_scorecard: ToolDef<Args> = {
  name: 'tech_scorecard',
  description:
    'Weekly per-technician scorecard (one tech or all): jobs completed, drive/working minutes, drive%, and ' +
    'labor burden ($) over a week. Source: D1 job_timesheets + technicians (gold has no timesheet grain). ' +
    'For dispatch-pro utilization/ratio and assigned-vs-sold gaps, pair with dispatch_pro_utilization_list, ' +
    'dispatch_pro_ratio_list and assigned_vs_sold_estimate_audit.',
  stEndpoint: { method: 'GET', path: 'd1://job_timesheets+technicians', source: 'd1' },
  zodSchema: {
    technicianId: z.coerce.number().int().positive().optional()
      .describe('One ST technician ID (optional; omitted = all techs).'),
    weekStart: z.string().describe("Week start, ISO 'YYYY-MM-DD' (arrived_on >= weekStart)."),
    weekEnd: z.string().describe("Week end, ISO 'YYYY-MM-DD' (arrived_on <= weekEnd, inclusive)."),
    burdenRate: z.coerce.number().positive().optional()
      .describe(`Loaded labor cost per hour for the burden total (default $${DEFAULT_BURDEN_RATE}).`),
  },
  async handler(env, args) {
    const burdenRate = args.burdenRate ?? DEFAULT_BURDEN_RATE;
    const startTs = args.weekStart.length === 10 ? `${args.weekStart}T00:00:00` : args.weekStart;
    const endTs = args.weekEnd.length === 10 ? `${args.weekEnd}T23:59:59` : args.weekEnd;

    const where = ['ts.active = 1', 'ts.arrived_on IS NOT NULL', 'ts.arrived_on >= ?', 'ts.arrived_on <= ?'];
    const binds: unknown[] = [startTs, endTs];
    if (args.technicianId !== undefined) {
      where.push('ts.technician_id = ?');
      binds.push(args.technicianId);
    }

    const { rows } = await readD1<Row>(
      env,
      `SELECT ts.technician_id,
              t.name          AS name,
              t.business_unit AS business_unit,
              COUNT(DISTINCT ts.job_id)          AS jobs,
              COALESCE(SUM(ts.drive_minutes), 0)  AS drive_minutes,
              COALESCE(SUM(ts.working_minutes), 0) AS working_minutes
         FROM job_timesheets ts
         LEFT JOIN technicians t ON t.technician_id = ts.technician_id
        WHERE ${where.join(' AND ')}
        GROUP BY ts.technician_id, t.name, t.business_unit
        ORDER BY jobs DESC`,
      binds,
    );

    const techs = rows.map((r) => {
      const total = r.drive_minutes + r.working_minutes;
      return {
        technician_id: r.technician_id,
        name: r.name,
        business_unit: r.business_unit,
        jobs: r.jobs,
        drive_minutes: r.drive_minutes,
        working_minutes: r.working_minutes,
        drive_pct: total > 0 ? Number(((r.drive_minutes / total) * 100).toFixed(1)) : 0,
        labor_burden_$: Number(((total / 60) * burdenRate).toFixed(2)),
      };
    });

    return {
      window: { weekStart: args.weekStart, weekEnd: args.weekEnd },
      count: techs.length,
      techs,
      _composite: 'tech_scorecard',
      _source: 'd1',
    };
  },
  transformResult: defaultShaper,
};
