// ============================================================
// tech_drive_time_summary — L5 composite for per-tech drive/work rollup.
//
// Returns a per-day breakdown for one technician over a window, plus the
// totals that feed the YTD drive-time analysis (windshield cost, drive %,
// jobs-per-day, first-call drive).
//
// Source: D1 (job_timesheets + technicians). Pure SQL — no live ST.
// ============================================================
import { z } from 'zod';
import { defaultShaper } from '../../response-shape';
import { readD1 } from '../../d1';
import type { ToolDef } from '../index';

interface Args {
  technicianId: number;
  startDate: string;
  endDate: string;
  burdenRate?: number;
  windshieldRatePerHour?: number;
}

interface DayRow {
  day: string;
  jobs: number;
  drive_minutes: number;
  working_minutes: number;
  first_call_drive_minutes: number | null;
}

interface TechRow {
  technician_id: number;
  name: string | null;
  business_unit: string | null;
}

const DEFAULT_BURDEN_RATE = 45;
const DEFAULT_WINDSHIELD_RATE = 110;

export const tech_drive_time_summary: ToolDef<Args> = {
  name: 'tech_drive_time_summary',
  description:
    "Per-tech drive/working time rollup over a date window. Returns daily breakdown + window totals: " +
    "drive_minutes, working_minutes, jobs_per_day, drive_pct, windshield_cost_$ (drive_minutes × rate/60). " +
    "Defaults: burdenRate $45/hr (loaded labor cost), windshieldRatePerHour $110/hr (windshield/lost-time rate from YTD plan). " +
    "Source: D1 `job_timesheets` joined to `technicians` for the name. " +
    "Use this for the YTD drive-time deliverable + ad-hoc 'top techs by windshield cost' cuts.",
  stEndpoint: { method: 'GET', path: 'd1://job_timesheets+technicians', source: 'd1' },
  zodSchema: {
    technicianId: z.number().int().positive().describe('ServiceTitan technician ID.'),
    startDate: z.string().describe("ISO date 'YYYY-MM-DD'. arrived_on >= startDate."),
    endDate: z.string().describe("ISO date 'YYYY-MM-DD'. arrived_on <= endDate (inclusive end-of-day handled by ST timestamp format)."),
    burdenRate: z
      .number()
      .positive()
      .optional()
      .describe(`Loaded labor cost per hour for the burden total (default $${DEFAULT_BURDEN_RATE}).`),
    windshieldRatePerHour: z
      .number()
      .positive()
      .optional()
      .describe(`Windshield-cost rate per hour, applied to drive_minutes (default $${DEFAULT_WINDSHIELD_RATE}/hr per YTD plan).`),
  },
  async handler(env, args, { correlation: _correlation }) {
    const burdenRate = args.burdenRate ?? DEFAULT_BURDEN_RATE;
    const windshieldRate = args.windshieldRatePerHour ?? DEFAULT_WINDSHIELD_RATE;

    // ISO end-of-day inclusive — append 'T23:59:59' so a startDate=2026-01-01
    // endDate=2026-01-31 query catches Jan-31 23:59 arrivals.
    const startTs = args.startDate.length === 10 ? `${args.startDate}T00:00:00` : args.startDate;
    const endTs = args.endDate.length === 10 ? `${args.endDate}T23:59:59` : args.endDate;

    const { rows: techRows } = await readD1<TechRow>(
      env,
      `SELECT technician_id, name, business_unit FROM technicians WHERE technician_id = ? LIMIT 1`,
      [args.technicianId],
    );
    const technician = techRows[0] ?? null;

    // Per-day rollup. SQLite's date() truncates ISO timestamps to YYYY-MM-DD.
    // first_call_drive_minutes uses a correlated subquery picking the earliest
    // dispatched_on per (tech, day) — small per-day rowcount so the cost is fine.
    const { rows: dayRows } = await readD1<DayRow>(
      env,
      `WITH base AS (
         SELECT timesheet_id, job_id, technician_id,
                dispatched_on, arrived_on, done_on,
                drive_minutes, working_minutes,
                date(arrived_on) AS day
         FROM job_timesheets
         WHERE technician_id = ?
           AND active = 1
           AND arrived_on IS NOT NULL
           AND arrived_on >= ?
           AND arrived_on <= ?
       )
       SELECT day,
              COUNT(DISTINCT job_id)                                   AS jobs,
              COALESCE(SUM(drive_minutes), 0)                          AS drive_minutes,
              COALESCE(SUM(working_minutes), 0)                        AS working_minutes,
              (SELECT b2.drive_minutes
                 FROM base b2
                 WHERE b2.day = b.day
                 ORDER BY b2.dispatched_on ASC
                 LIMIT 1)                                              AS first_call_drive_minutes
       FROM base b
       GROUP BY day
       ORDER BY day ASC`,
      [args.technicianId, startTs, endTs],
    );

    let totalDrive = 0;
    let totalWork = 0;
    let totalJobs = 0;
    let firstCallSum = 0;
    let firstCallDays = 0;
    for (const d of dayRows) {
      totalDrive += d.drive_minutes;
      totalWork += d.working_minutes;
      totalJobs += d.jobs;
      if (d.first_call_drive_minutes !== null) {
        firstCallSum += d.first_call_drive_minutes;
        firstCallDays += 1;
      }
    }
    const totalMinutes = totalDrive + totalWork;
    const drivePct = totalMinutes > 0 ? Number(((totalDrive / totalMinutes) * 100).toFixed(1)) : 0;
    const days = dayRows.length;
    const jobsPerDay = days > 0 ? Number((totalJobs / days).toFixed(2)) : 0;
    const avgFirstCallDrive = firstCallDays > 0 ? Number((firstCallSum / firstCallDays).toFixed(1)) : null;
    const windshieldCost = Number(((totalDrive / 60) * windshieldRate).toFixed(2));
    const laborBurden = Number(((totalMinutes / 60) * burdenRate).toFixed(2));

    return {
      technicianId: args.technicianId,
      technician,
      window: { startDate: args.startDate, endDate: args.endDate },
      totals: {
        days_worked: days,
        jobs: totalJobs,
        jobs_per_day_avg: jobsPerDay,
        total_drive_minutes: totalDrive,
        total_working_minutes: totalWork,
        total_minutes: totalMinutes,
        drive_pct: drivePct,
        avg_first_call_drive_minutes: avgFirstCallDrive,
        windshield_rate_per_hour: windshieldRate,
        windshield_cost_$: windshieldCost,
        burden_rate_per_hour: burdenRate,
        labor_burden_$: laborBurden,
      },
      by_day: dayRows,
      _composite: 'tech_drive_time_summary',
      _source: 'd1',
    };
  },
  transformResult: defaultShaper,
};
