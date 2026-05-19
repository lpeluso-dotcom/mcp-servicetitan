import { z } from 'zod';
import { McpError } from '../../errors';
import { authHeaders } from '../../auth';
import { defaultShaper } from '../../response-shape';
import type { ToolDef } from '../index';

interface Args {
  jobId?: number;
  modifiedOnOrAfter?: string;
  page?: number;
  pageSize?: number;
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

function slim(t: RawTimesheet): SlimTimesheet {
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

const DEFAULT_PAGESIZE = 100;
const MAX_PAGESIZE = 500;

export const payroll_job_timesheets_list: ToolDef<Args> = {
  name: 'payroll_job_timesheets_list',
  description:
    "List ServiceTitan per-tech-per-job timesheets (dispatchedOn / arrivedOn / doneOn). " +
    "Pass jobId for a single job's timesheets (no pagination); omit for batch read filtered " +
    "by modifiedOnOrAfter. Returns slim shape with derived drive_minutes + working_minutes " +
    "(minute-truncated to match the invoice Splits block).",
  zodSchema: {
    jobId: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('If set, fetch timesheets for this single job (no pagination).'),
    modifiedOnOrAfter: z
      .string()
      .optional()
      .describe('ISO 8601 timestamp. Only used in batch mode (when jobId omitted).'),
    page: z.number().int().positive().optional().describe('Page number, default 1'),
    pageSize: z
      .number()
      .int()
      .positive()
      .max(MAX_PAGESIZE)
      .optional()
      .describe(`Page size, default ${DEFAULT_PAGESIZE}, max ${MAX_PAGESIZE}`),
  },
  async handler(env, args, { actor, correlation }) {
    const tenant = env.ST_TENANT_ID;

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
          `payroll_job_timesheets_list failed: ${resp.status} ${path}`,
          { correlation },
        );
      }
      const data = (await resp.json()) as { data?: RawTimesheet[] };
      return {
        count: (data.data ?? []).length,
        timesheets: (data.data ?? []).map(slim),
        has_more: false,
        _source: 'live',
      };
    }

    // Batch mode: hit /jobs/timesheets with pagination + modifiedOnOrAfter.
    const page = args.page ?? 1;
    const pageSize = Math.min(args.pageSize ?? DEFAULT_PAGESIZE, MAX_PAGESIZE);
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
        `payroll_job_timesheets_list failed: ${resp.status} ${path}`,
        { correlation },
      );
    }
    const data = (await resp.json()) as { data?: RawTimesheet[]; hasMore?: boolean };
    return {
      count: (data.data ?? []).length,
      timesheets: (data.data ?? []).map(slim),
      has_more: !!data.hasMore,
      _source: 'live',
    };
  },
  transformResult: defaultShaper,
};
