import { z } from 'zod';
import { McpError } from '../../errors';
import { authHeaders } from '../../auth';
import { defaultShaper } from '../../response-shape';
import { readD1 } from '../../d1';
import type { Env } from '../../env';
import type { ToolDef } from '../index';

interface Args {
  jobId?: number;
  technicianId?: number;
  appointmentId?: number;
  modifiedOnOrAfter?: string;
  arrivedOnOrAfter?: string;
  arrivedOnOrBefore?: string;
  active?: boolean;
  page?: number;
  pageSize?: number;
  source?: 'auto' | 'd1' | 'live';
}

interface RawTimesheet {
  id: number;
  jobId: number;
  appointmentId?: number;
  technicianId: number;
  dispatchedOn?: string;
  arrivedOn?: string;
  canceledOn?: string;
  doneOn?: string;
  createdOn?: string;
  modifiedOn?: string;
  active: boolean;
}

interface SlimTimesheet {
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
  active: boolean;
  created_on: string | null;
  modified_on: string | null;
}

interface D1TimesheetRow {
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
  created_at: string | null;
  modified_at: string | null;
  synced_at: string | null;
}

// Minute-truncated diff. Matches ST UI behaviour: the invoice Splits block
// displays minute-truncated drive/work times, so reconciliation needs
// floor(ms/60000) on both ends before subtracting.
function diffMinutes(a?: string, b?: string): number | null {
  if (!a || !b) return null;
  const s = Date.parse(a);
  const e = Date.parse(b);
  if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) return null;
  return Math.floor(e / 60000) - Math.floor(s / 60000);
}

function slimLive(t: RawTimesheet): SlimTimesheet {
  return {
    timesheet_id: t.id,
    job_id: t.jobId,
    appointment_id: t.appointmentId ?? null,
    technician_id: t.technicianId,
    dispatched_on: t.dispatchedOn ?? null,
    arrived_on: t.arrivedOn ?? null,
    canceled_on: t.canceledOn ?? null,
    done_on: t.doneOn ?? null,
    drive_minutes: diffMinutes(t.dispatchedOn, t.arrivedOn),
    working_minutes: diffMinutes(t.arrivedOn, t.doneOn),
    active: t.active !== false,
    created_on: t.createdOn ?? null,
    modified_on: t.modifiedOn ?? null,
  };
}

function slimD1(r: D1TimesheetRow): SlimTimesheet {
  return {
    timesheet_id: r.timesheet_id,
    job_id: r.job_id,
    appointment_id: r.appointment_id,
    technician_id: r.technician_id,
    dispatched_on: r.dispatched_on,
    arrived_on: r.arrived_on,
    canceled_on: r.canceled_on,
    done_on: r.done_on,
    drive_minutes: r.drive_minutes,
    working_minutes: r.working_minutes,
    active: r.active !== 0,
    created_on: r.created_at,
    modified_on: r.modified_at,
  };
}

const DEFAULT_PAGESIZE = 100;
const MAX_PAGESIZE = 500;
// taylor-ai job_timesheets ST_SYNC runs every 2h on modifiedOnOrAfter — treat
// anything older than 6h as stale enough to prefer live ST.
const STALE_THRESHOLD_HOURS = 6;

export const payroll_job_timesheets_list: ToolDef<Args> = {
  name: 'payroll_job_timesheets_list',
  description:
    "List ServiceTitan per-tech-per-job timesheets with drive_minutes + working_minutes (the values that drive the invoice Splits block + Labor Burden column). Source: D1 (`job_timesheets` table, synced every 2h via ST_SYNC) with live ST fallback. Pass jobId/technicianId/appointmentId for filtering; arrivedOnOrAfter/arrivedOnOrBefore for windowing; modifiedOnOrAfter for incremental sync use. Set source='live' to force a live ST read.",
  zodSchema: {
    jobId: z.number().int().positive().optional().describe('Filter to one job.'),
    technicianId: z.number().int().positive().optional().describe('Filter to one technician.'),
    appointmentId: z.number().int().positive().optional().describe('Filter to one appointment.'),
    modifiedOnOrAfter: z
      .string()
      .optional()
      .describe('ISO 8601 timestamp. In live mode this is the ST query param; in D1 mode it filters on modified_at.'),
    arrivedOnOrAfter: z
      .string()
      .optional()
      .describe('ISO 8601 timestamp. D1-only — narrows by arrived_on >= value.'),
    arrivedOnOrBefore: z
      .string()
      .optional()
      .describe('ISO 8601 timestamp. D1-only — narrows by arrived_on <= value.'),
    active: z.boolean().optional().describe('Filter by active flag. Default: include all.'),
    page: z.number().int().positive().optional().describe('Page number, default 1.'),
    pageSize: z
      .number()
      .int()
      .positive()
      .max(MAX_PAGESIZE)
      .optional()
      .describe(`Page size, default ${DEFAULT_PAGESIZE}, max ${MAX_PAGESIZE}.`),
    source: z
      .enum(['auto', 'd1', 'live'])
      .optional()
      .describe("'auto' (default) reads D1 and falls back to live on miss/stale; 'd1' forces D1 only; 'live' forces live ST."),
  },
  stEndpoint: {
    method: 'GET',
    path: '/payroll/v2/tenant/{tid}/jobs/timesheets',
    source: 'd1',
  },
  async handler(env, args, { actor, correlation }) {
    const tenant = env.ST_TENANT_ID;
    const source = args.source ?? 'auto';
    const page = args.page ?? 1;
    const pageSize = Math.min(args.pageSize ?? DEFAULT_PAGESIZE, MAX_PAGESIZE);

    // Live mode (explicit) — hit ST and return the live shape.
    if (source === 'live') {
      return liveRead(env, args, tenant, page, pageSize, actor, correlation);
    }

    // D1 mode — build a parameterized SELECT against job_timesheets.
    try {
      const where: string[] = [];
      const params: unknown[] = [];
      if (args.jobId !== undefined) {
        where.push('job_id = ?');
        params.push(args.jobId);
      }
      if (args.technicianId !== undefined) {
        where.push('technician_id = ?');
        params.push(args.technicianId);
      }
      if (args.appointmentId !== undefined) {
        where.push('appointment_id = ?');
        params.push(args.appointmentId);
      }
      if (args.modifiedOnOrAfter !== undefined) {
        where.push('modified_at >= ?');
        params.push(args.modifiedOnOrAfter);
      }
      if (args.arrivedOnOrAfter !== undefined) {
        where.push('arrived_on >= ?');
        params.push(args.arrivedOnOrAfter);
      }
      if (args.arrivedOnOrBefore !== undefined) {
        where.push('arrived_on <= ?');
        params.push(args.arrivedOnOrBefore);
      }
      if (args.active !== undefined) {
        where.push('active = ?');
        params.push(args.active ? 1 : 0);
      }

      const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const offset = (page - 1) * pageSize;
      const sql =
        `SELECT timesheet_id, job_id, appointment_id, technician_id, ` +
        `dispatched_on, arrived_on, canceled_on, done_on, drive_minutes, working_minutes, ` +
        `active, created_at, modified_at, synced_at ` +
        `FROM job_timesheets ${whereSql} ` +
        `ORDER BY arrived_on DESC NULLS LAST, timesheet_id DESC ` +
        `LIMIT ? OFFSET ?`;
      const queryParams = [...params, pageSize + 1, offset];

      const { rows } = await readD1<D1TimesheetRow>(env, sql, queryParams);
      const hasMore = rows.length > pageSize;
      const slice = hasMore ? rows.slice(0, pageSize) : rows;
      const slim = slice.map(slimD1);

      // Freshness check from the row's own synced_at — D1 doesn't expose
      // sync_metadata to the proxy, so we read it inline from the rows.
      const maxSynced = slice.reduce<number>((acc, r) => {
        if (!r.synced_at) return acc;
        const t = Date.parse(r.synced_at);
        return Number.isFinite(t) && t > acc ? t : acc;
      }, 0);
      const staleHours = maxSynced ? (Date.now() - maxSynced) / 3_600_000 : null;

      // Auto-mode: if rows are all-stale or empty AND a jobId/appointmentId
      // filter is set (cheap to fetch live), fall back to live.
      if (
        source === 'auto' &&
        (slim.length === 0 || (staleHours !== null && staleHours > STALE_THRESHOLD_HOURS)) &&
        (args.jobId !== undefined || args.appointmentId !== undefined)
      ) {
        const live = await liveRead(env, args, tenant, page, pageSize, actor, correlation);
        return {
          ...live,
          _fallback_reason: slim.length === 0 ? 'd1_empty' : `d1_stale_${staleHours?.toFixed(1)}h`,
        };
      }

      return {
        count: slim.length,
        timesheets: slim,
        has_more: hasMore,
        _source: 'd1',
        _stale_hours: staleHours !== null ? Number(staleHours.toFixed(1)) : null,
      };
    } catch (err) {
      // D1 unavailable / unexpected — fall back to live only if auto.
      if (source === 'auto') {
        const live = await liveRead(env, args, tenant, page, pageSize, actor, correlation);
        return { ...live, _fallback_reason: `d1_error: ${(err as Error).message}` };
      }
      throw new McpError(
        'upstream_error',
        `payroll_job_timesheets_list D1 read failed: ${(err as Error).message}`,
        { correlation },
      );
    }
  },
  transformResult: defaultShaper,
};

async function liveRead(
  env: Env,
  args: Args,
  tenant: string,
  page: number,
  pageSize: number,
  actor: string,
  correlation: string,
): Promise<{
  count: number;
  timesheets: SlimTimesheet[];
  has_more: boolean;
  _source: 'live';
}> {
  // Single-job mode: hit /jobs/{id}/timesheets (no pagination).
  if (args.jobId !== undefined) {
    const path = `/payroll/v2/tenant/${tenant}/jobs/${args.jobId}/timesheets`;
    const resp = await env.ST_PROXY.fetch(
      `https://servicetitan-proxy/api/st/read?endpoint=${encodeURIComponent(path)}`,
      { headers: authHeaders(env, correlation, actor) },
    );
    if (!resp.ok) {
      throw new McpError(
        'upstream_error',
        `payroll_job_timesheets_list live failed: ${resp.status} ${path}`,
        { correlation },
      );
    }
    const data = (await resp.json()) as { data?: RawTimesheet[] };
    return {
      count: (data.data ?? []).length,
      timesheets: (data.data ?? []).map(slimLive),
      has_more: false,
      _source: 'live',
    };
  }

  // Batch mode: /jobs/timesheets with pagination + modifiedOnOrAfter.
  const qs = new URLSearchParams();
  qs.set('page', String(page));
  qs.set('pageSize', String(pageSize));
  qs.set('active', 'Any');
  if (args.modifiedOnOrAfter !== undefined) {
    qs.set('modifiedOnOrAfter', args.modifiedOnOrAfter);
  }

  const path = `/payroll/v2/tenant/${tenant}/jobs/timesheets?${qs}`;
  const resp = await env.ST_PROXY.fetch(
    `https://servicetitan-proxy/api/st/read?endpoint=${encodeURIComponent(path)}`,
    { headers: authHeaders(env, correlation, actor) },
  );
  if (!resp.ok) {
    throw new McpError(
      'upstream_error',
      `payroll_job_timesheets_list live failed: ${resp.status} ${path}`,
      { correlation },
    );
  }
  const data = (await resp.json()) as { data?: RawTimesheet[]; hasMore?: boolean };
  return {
    count: (data.data ?? []).length,
    timesheets: (data.data ?? []).map(slimLive),
    has_more: !!data.hasMore,
    _source: 'live',
  };
}
