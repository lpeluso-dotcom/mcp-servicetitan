// ============================================================
// job_cost_actuals — L5 composite for per-job labor-burden diagnostics.
//
// Returns the data shape the Q1 job-costing analysis needed in one call:
//   - job (D1)
//   - timesheets (D1 job_timesheets — drive_minutes + working_minutes per tech)
//   - appointments + assignments (D1 — for the labor split)
//   - invoice (live ST — single record, freshest)
//   - estimates (D1 — by job_id)
//   - computed labor_burden_$ = (sum_drive + sum_work) × burdenRate / 60
//
// Reconciliation reference (2026-05-19 probe): job 77423990 / Brooks
// returned drive=24m + work=152m → burden ≈ $132 at $45/hr, matching
// the invoice Splits block exactly.
// ============================================================
import { z } from 'zod';
import { authHeaders } from '../../auth';
import { gatherFetches, stRead } from '../../composite-helpers';
import { defaultShaper } from '../../response-shape';
import { readD1 } from '../../d1';
import { stampMirrorFreshness } from '../../mirror-freshness';
import type { ToolDef } from '../index';

interface Args {
  jobId: number;
  burdenRate?: number;
}

interface JobRow {
  job_id: number;
  customer_id: number | null;
  business_unit: string | null;
  job_type: string | null;
  job_status: string | null;
  completed_date: string | null;
  revenue: number | null;
  project_id: number | null;
  modified_at: string | null;
}

interface TimesheetRow {
  timesheet_id: number;
  job_id: number;
  appointment_id: number | null;
  technician_id: number;
  dispatched_on: string | null;
  arrived_on: string | null;
  canceled_on: string | null;
  done_on: string | null;
  drive_minutes: number | null;
  working_minutes: number | null;
  active: number;
  /** Row-level sync timestamp — feeds the mirror-freshness stamp. */
  synced_at: string | null;
}

interface AppointmentRow {
  appointment_id: number;
  job_id: number;
  appointment_number: string | null;
  start_date: string | null;
  end_date: string | null;
  status: string | null;
}

interface AssignmentRow {
  assignment_id: number;
  appointment_id: number;
  job_id: number;
  technician_id: number;
  technician_name: string | null;
  status: string | null;
}

interface EstimateRow {
  estimate_id: number;
  job_id: number | null;
  name: string | null;
  status: string | null;
  total: number | null;
  sold_by: string | null;
  active: number;
  modified_at: string | null;
}

interface TechnicianRow {
  technician_id: number;
  name: string | null;
  business_unit: string | null;
}

const DEFAULT_BURDEN_RATE = 45;

export const job_cost_actuals: ToolDef<Args> = {
  name: 'job_cost_actuals',
  description:
    'L5 composite for per-job labor-burden diagnostics. Returns the job, its timesheets (with ' +
    'drive_minutes + working_minutes per tech), appointments + assignments, estimates, and the ' +
    'live invoice, plus a computed labor_burden_$ summary (sum_drive + sum_work) × burdenRate / 60. ' +
    'Defaults burdenRate to $45/hr; override per call to match your shop standard. ' +
    'Source: mixed (D1 job_timesheets + jobs + appointments + assignments + estimates + live ST invoice).',
  zodSchema: {
    jobId: z.number().int().positive().describe('ST job ID'),
    burdenRate: z
      .number()
      .positive()
      .optional()
      .describe(`Loaded labor cost per hour (default $${DEFAULT_BURDEN_RATE}).`),
  },
  // L5 composite — jobId is always present; everything else is optional/
  // permissive on purpose. `job` can be null (no matching D1 row), `invoice`
  // can be null (no matching live invoice or a failed fanout — see
  // _partial/_failures), and the D1 row arrays (timesheets/appointments/
  // assignments/estimates) are our own SELECT shapes but kept as
  // record(unknown) so a D1 schema tweak doesn't fail runtime
  // structuredContent validation. `summary` is fully computed by this
  // handler but still typed loosely for the same reason.
  outputSchema: {
    jobId: z.number(),
    job: z.unknown().optional(),
    summary: z.record(z.string(), z.unknown()).optional(),
    per_technician: z.array(z.record(z.string(), z.unknown())).optional(),
    timesheets: z.array(z.record(z.string(), z.unknown())).optional(),
    appointments: z.array(z.record(z.string(), z.unknown())).optional(),
    assignments: z.array(z.record(z.string(), z.unknown())).optional(),
    estimates: z.array(z.record(z.string(), z.unknown())).optional(),
    invoice: z.unknown().optional(),
    _partial: z.boolean().optional(),
    _failures: z.array(z.unknown()).optional(),
    _warnings: z.array(z.string()).optional(),
    // MB-1 / QUA-1141 freshness stamp (job_timesheets read) — always emitted.
    // MUST stay declared: structuredContent is validated against this schema
    // at runtime on every call (QUA-1108), so an undeclared field fails in
    // production while unit tests stay green. The stamp's _warning is routed
    // into _warnings above rather than emitted as its own field.
    _mirror_table: z.string(),
    _stale_hours: z.number().nullable(),
    _freshness: z.string(),
    _empty: z.boolean(),
    _composite: z.string().optional(),
    _source: z.string().optional(),
    correlation: z.string().optional(),
  },
  stEndpoint: { method: 'GET', path: '/jpm/v2/tenant/{tid}/jobs/{id}', source: 'mixed' },
  async handler(env, args, { actor, correlation }) {
    const { jobId } = args;
    const burdenRate = args.burdenRate ?? DEFAULT_BURDEN_RATE;
    const headers = authHeaders(env, correlation, actor);
    const tenant = env.ST_TENANT_ID;

    // Parallel D1 reads + one live invoice fanout.
    const [jobRows, tsRows, apptRows, asgRows, estRows] = await Promise.all([
      readD1<JobRow>(
        env,
        `SELECT job_id, customer_id, business_unit, job_type, job_status,
                completed_date, revenue, project_id, modified_at
         FROM jobs WHERE job_id = ? LIMIT 1`,
        [jobId],
      ),
      readD1<TimesheetRow>(
        env,
        `SELECT timesheet_id, job_id, appointment_id, technician_id,
                dispatched_on, arrived_on, canceled_on, done_on,
                drive_minutes, working_minutes, active, synced_at
         FROM job_timesheets WHERE job_id = ? ORDER BY arrived_on ASC`,
        [jobId],
      ),
      readD1<AppointmentRow>(
        env,
        `SELECT appointment_id, job_id, appointment_number, start_date, end_date, status
         FROM appointments WHERE job_id = ? ORDER BY start_date ASC`,
        [jobId],
      ),
      readD1<AssignmentRow>(
        env,
        `SELECT assignment_id, appointment_id, job_id, technician_id, technician_name, status
         FROM appointment_assignments WHERE job_id = ?`,
        [jobId],
      ),
      readD1<EstimateRow>(
        env,
        // taylor-ai estimates store the title as `summary` and the timestamp as
        // `modified_date`; alias both so the EstimateRow shape stays stable.
        `SELECT estimate_id, job_id, summary AS name, status, total, sold_by, active, modified_date AS modified_at
         FROM estimates WHERE job_id = ? ORDER BY modified_date DESC`,
        [jobId],
      ),
    ]);

    const job = jobRows.rows[0] ?? null;

    // Live invoice fetch — D1 invoice_items don't carry the labor_burden column
    // ST renders on the invoice UI; the live invoice does. Fanout-style for the
    // typical "this job's invoice" join.
    const invoiceFanout = await gatherFetches([
      {
        name: 'invoice',
        promise: stRead(env, headers, `/accounting/v2/tenant/${tenant}/invoices?jobId=${jobId}`),
      },
    ]);
    const invoiceData = invoiceFanout.results.invoice;
    const firstInvoice = Array.isArray(invoiceData)
      ? invoiceData[0]
      : invoiceData != null && typeof invoiceData === 'object' && 'data' in invoiceData
        ? (invoiceData as { data?: unknown[] }).data?.[0] ?? null
        : invoiceData;

    // Per-tech rollup of drive + work.
    const perTech = new Map<
      number,
      {
        technician_id: number;
        technician_name: string | null;
        drive_minutes: number;
        working_minutes: number;
        timesheet_count: number;
      }
    >();
    let sumDrive = 0;
    let sumWork = 0;
    for (const t of tsRows.rows) {
      if (t.active === 0) continue;
      const drive = t.drive_minutes ?? 0;
      const work = t.working_minutes ?? 0;
      sumDrive += drive;
      sumWork += work;
      const existing = perTech.get(t.technician_id);
      const techName = asgRows.rows.find((a) => a.technician_id === t.technician_id)?.technician_name ?? null;
      if (existing) {
        existing.drive_minutes += drive;
        existing.working_minutes += work;
        existing.timesheet_count += 1;
      } else {
        perTech.set(t.technician_id, {
          technician_id: t.technician_id,
          technician_name: techName,
          drive_minutes: drive,
          working_minutes: work,
          timesheet_count: 1,
        });
      }
    }

    const totalMinutes = sumDrive + sumWork;
    const laborBurden$ = Number(((totalMinutes / 60) * burdenRate).toFixed(2));
    const revenue = job?.revenue ?? null;

    // Zero-by-absence is NOT zero-by-measurement. With no timesheet rows the
    // burden computes to $0 and the margin to 100%, which reads as a great job
    // rather than a missing input. D1 `job_timesheets` is a recent-window sync
    // (7,910 rows spanning 2025-12-08..2026-07-27 as of 2026-07-28), so any
    // older job has no rows at all — e.g. job 30035955 (completed 2023-02-21)
    // returned labor_burden_$ 0 / gross_margin_pct 100 with three technicians
    // assigned and marked Done. Withhold the derived figures and say why.
    const warnings: string[] = [];
    const hasTimesheets = tsRows.rows.some((t) => t.active !== 0);
    if (!hasTimesheets) {
      const assignedTechs = new Set(asgRows.rows.map((a) => a.technician_id)).size;
      warnings.push(
        `labor_burden_unavailable: no active timesheet rows in D1 for job ${jobId}, so labor_burden_$ is ` +
        `0 by ABSENCE, not by measurement. gross_profit_$ and gross_margin_pct are withheld (null) rather ` +
        `than reported as a 100% margin.` +
        (assignedTechs > 0
          ? ` ${assignedTechs} technician(s) are assigned to this job via appointment_assignments, so labor ` +
            `almost certainly occurred — the timesheets are missing, not the work.`
          : '') +
        ` D1 job_timesheets is a recent-window sync; jobs completed before that window carry no rows. ` +
        `Use payroll_job_timesheets_list for a live ST read of this job's labor.`,
      );
    }

    // MB-1 / QUA-1141: the timesheet read is the one that drives money —
    // stamp its freshness. This tool already carries a _warnings array
    // (QUA-1066), so the stamp's warning is concatenated into it rather than
    // emitted as a colliding top-level _warning.
    const { _warning: freshnessWarning, ...freshness } = stampMirrorFreshness(tsRows.rows, {
      table: 'job_timesheets',
    });
    if (freshnessWarning) warnings.push(freshnessWarning);

    // Pull technician names for any per-tech row missing one (assignments may
    // miss a tech that's on a timesheet but not on appointment_assignments).
    const missingTechIds = [...perTech.values()].filter((p) => p.technician_name === null).map((p) => p.technician_id);
    if (missingTechIds.length > 0) {
      const placeholders = missingTechIds.map(() => '?').join(',');
      const { rows: techRows } = await readD1<TechnicianRow>(
        env,
        // `technicians` is keyed on tech_id — alias it back to technician_id so
        // the perTech.get(t.technician_id) lookup below keeps working.
        `SELECT tech_id AS technician_id, name, business_unit FROM technicians WHERE tech_id IN (${placeholders})`,
        missingTechIds,
      );
      for (const t of techRows) {
        const row = perTech.get(t.technician_id);
        if (row) row.technician_name = t.name;
      }
    }

    return {
      jobId,
      job,
      summary: {
        total_drive_minutes: sumDrive,
        total_working_minutes: sumWork,
        total_minutes: totalMinutes,
        burden_rate_per_hour: burdenRate,
        labor_burden_$: laborBurden$,
        // 'none' means the $0 burden reflects missing timesheets, not free labor.
        labor_burden_basis: hasTimesheets ? 'timesheets' : 'none',
        // False whenever the burden rests on absent or unproven-fresh mirror rows.
        metrics_are_authoritative: hasTimesheets && freshness._freshness === 'fresh',
        revenue,
        gross_profit_$:
          hasTimesheets && revenue !== null ? Number((revenue - laborBurden$).toFixed(2)) : null,
        gross_margin_pct:
          hasTimesheets && revenue !== null && revenue > 0
            ? Number((((revenue - laborBurden$) / revenue) * 100).toFixed(1))
            : null,
      },
      per_technician: [...perTech.values()].sort(
        (a, b) => b.working_minutes - a.working_minutes,
      ),
      timesheets: tsRows.rows.map((t) => ({ ...t, active: t.active !== 0 })),
      appointments: apptRows.rows,
      assignments: asgRows.rows,
      estimates: estRows.rows.map((e) => ({ ...e, active: e.active !== 0 })),
      invoice: firstInvoice ?? null,
      _partial: invoiceFanout.partial,
      _failures: invoiceFanout.failures,
      ...(warnings.length > 0 ? { _warnings: warnings } : {}),
      ...freshness,
      _composite: 'job_cost_actuals',
      _source: 'mixed',
      correlation,
    };
  },
  transformResult: defaultShaper,
};
