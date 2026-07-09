import { z } from 'zod';
import { McpError } from '../../errors';
import { defaultShaper } from '../../response-shape';
import { readST } from '../../st';
import type { ToolDef } from '../index';

interface Args {
  employeeId?: number;
  timesheetCodeId?: number;
  fromDate?: string;
  toDate?: string;
  page?: number;
  pageSize?: number;
}

// Real ST /payroll/v2/tenant/{tid}/non-job-timesheets row shape (live-verified
// 2026-07-09). There is NO date/hours/activityCodeId/notes field — the old
// mapper read fields that don't exist and produced null/0 on every row.
interface RawTimesheet {
  id: number;
  employeeId?: number;
  employeeType?: string;
  timesheetCodeId?: number;
  startedOn?: string;
  endedOn?: string;
  createdOn?: string;
  modifiedOn?: string;
  active?: boolean;
}

interface SlimTimesheet {
  id: number;
  employee_id: number | null;
  employee_type: string | null;
  timesheet_code_id: number | null;
  started_on: string | null;
  ended_on: string | null;
  hours: number;
}

// Minute-truncated diff, converted to hours (2dp). Matches the
// payroll_job_timesheets_list diffMinutes convention: floor(ms/60000) on
// both ends before subtracting, so partial-minute jitter in ST's timestamps
// doesn't leak into the hours figure.
function diffHours(startedOn?: string, endedOn?: string): number {
  if (!startedOn || !endedOn) return 0;
  const s = Date.parse(startedOn);
  const e = Date.parse(endedOn);
  if (!Number.isFinite(s) || !Number.isFinite(e)) return 0;
  const minutes = Math.floor(e / 60000) - Math.floor(s / 60000);
  if (minutes <= 0) return 0;
  return Math.round((minutes / 60) * 100) / 100;
}

function slim(t: RawTimesheet): SlimTimesheet {
  return {
    id: t.id,
    employee_id: t.employeeId ?? null,
    employee_type: t.employeeType ?? null,
    timesheet_code_id: t.timesheetCodeId ?? null,
    started_on: t.startedOn ?? null,
    ended_on: t.endedOn ?? null,
    hours: diffHours(t.startedOn, t.endedOn),
  };
}

// Back-office tool (no voice consumer); pageSize tuned for PO/receipt
// enumeration, not voice-tier readback. Compare find_customer's tighter caps.
const DEFAULT_PAGESIZE = 25;
const MAX_PAGESIZE = 100;

export const payroll_non_job_timesheets_list: ToolDef<Args> = {
  name: 'payroll_non_job_timesheets_list',
  description:
    'List ServiceTitan non-job timesheets (meeting/training/admin time). Filter by modified-date window (fromDate/toDate map to modifiedOnOrAfter/modifiedOnOrBefore — ST ignores startsOnOrAfter/endsOnOrBefore on this endpoint). employeeId/timesheetCodeId are NOT filterable server-side on this ST endpoint (live-verified 2026-07-09: the singular employeeId 409s, and every plural/alternate form tried is silently ignored) — passing either throws; filter client-side on the returned employee_id/timesheet_code_id fields instead. Source: live ST.',
  zodSchema: {
    employeeId: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        'NOT FILTERABLE server-side on this endpoint (live-verified 2026-07-09: employeeId singular 409s "Employee type was not specified"; employeeIds/technicianId(s)/ids plural forms are all silently ignored — identical unfiltered page regardless of value). Passing this arg throws immediately; filter client-side on the returned employee_id field instead.',
      ),
    timesheetCodeId: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        'NOT FILTERABLE server-side on this endpoint (live-verified 2026-07-09: timesheetCodeId and timesheetCodeIds are both silently ignored — identical unfiltered page regardless of value). Passing this arg throws immediately; filter client-side on the returned timesheet_code_id field instead.',
      ),
    fromDate: z
      .string()
      .optional()
      .describe(
        'ISO 8601 timestamp. Maps to modifiedOnOrAfter (ST silently ignores startsOnOrAfter on this endpoint, live-verified — this filters by last-MODIFIED time, not the timesheet\'s own startedOn).',
      ),
    toDate: z
      .string()
      .optional()
      .describe(
        'ISO 8601 timestamp. Maps to modifiedOnOrBefore (ST silently ignores endsOnOrBefore on this endpoint, live-verified — this filters by last-MODIFIED time, not the timesheet\'s own endedOn).',
      ),
    page: z.number().int().positive().optional().describe('Page number, default 1'),
    pageSize: z
      .number()
      .int()
      .positive()
      .max(MAX_PAGESIZE)
      .optional()
      .describe(`Page size, default ${DEFAULT_PAGESIZE}, max ${MAX_PAGESIZE}`),
  },
  stEndpoint: { method: 'GET', path: '/payroll/v2/tenant/{tid}/non-job-timesheets', source: 'live' },
  async handler(env, args, { actor, correlation }) {
    // Both filters are provably unsupported by ST on this endpoint (see
    // live-probe notes above and in the test file). Reject loudly rather
    // than either 409ing (employeeId) or silently returning an unfiltered
    // page that looks filtered (timesheetCodeId) — the same silent-drop
    // class of bug QUA-694 caught elsewhere in this tool surface.
    if (args.employeeId !== undefined) {
      throw new McpError(
        'validation_error',
        `payroll_non_job_timesheets_list: employeeId cannot be honored — ST's non-job-timesheets endpoint has no ` +
          `working employee filter (singular 409s "Employee type was not specified"; plural employeeIds is ` +
          `silently ignored, verified live 2026-07-09). Omit employeeId and filter client-side on the returned ` +
          `employee_id field.`,
        { correlation },
      );
    }
    if (args.timesheetCodeId !== undefined) {
      throw new McpError(
        'validation_error',
        `payroll_non_job_timesheets_list: timesheetCodeId cannot be honored — ST's non-job-timesheets endpoint ` +
          `silently ignores timesheetCodeId/timesheetCodeIds (verified live 2026-07-09). Omit timesheetCodeId ` +
          `and filter client-side on the returned timesheet_code_id field.`,
        { correlation },
      );
    }

    const page = args.page ?? 1;
    const pageSize = Math.min(args.pageSize ?? DEFAULT_PAGESIZE, MAX_PAGESIZE);
    const query: Record<string, unknown> = {
      modifiedOnOrAfter: args.fromDate,
      modifiedOnOrBefore: args.toDate,
      page,
      pageSize,
    };

    const data = await readST<{ data?: RawTimesheet[]; hasMore?: boolean }>(
      env,
      { actor, correlation },
      `/payroll/v2/tenant/${env.ST_TENANT_ID}/non-job-timesheets`,
      query,
    );
    return {
      count: (data.data ?? []).length,
      timesheets: (data.data ?? []).map(slim),
      has_more: !!data.hasMore,
      _source: 'live',
    };
  },
  transformResult: defaultShaper,
};
