import { z } from 'zod';
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
    'List ServiceTitan non-job timesheets (meeting/training/admin time). Filter by modified-date window (fromDate/toDate map to modifiedOnOrAfter/modifiedOnOrBefore — ST ignores startsOnOrAfter/endsOnOrBefore on this endpoint). employeeId/timesheetCodeId are filtered CLIENT-SIDE — ST has no working server-side filter for either on this endpoint (live-verified 2026-07-09: employeeId singular 409s, every plural/alternate form tried is a silent no-op) — so page/pageSize apply to the UNFILTERED set and a page can come back with fewer matches (or zero) than pageSize even when more exist on other pages. Source: live ST.',
  zodSchema: {
    employeeId: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        'Filter to one employee. Applied CLIENT-SIDE after fetch — ST has no working server-side filter on this endpoint (live-verified 2026-07-09: employeeId singular 409s "Employee type was not specified"; employeeIds/technicianId(s)/ids plural forms are all silently ignored). page/pageSize still apply server-side to the UNFILTERED set, so a page can come back with fewer matches (or zero) than pageSize even when more exist on other pages — page through if needed.',
      ),
    timesheetCodeId: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        'Filter to one timesheet code. Applied CLIENT-SIDE after fetch — ST silently ignores timesheetCodeId/timesheetCodeIds server-side on this endpoint (live-verified 2026-07-09). page/pageSize still apply server-side to the UNFILTERED set, so a page can come back with fewer matches (or zero) than pageSize even when more exist on other pages — page through if needed.',
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

    // employeeId/timesheetCodeId have no working server-side filter on this
    // ST endpoint (live-verified 2026-07-09 — employeeId singular 409s,
    // every plural/alternate form of both is a silent no-op). Neither is
    // ever forwarded to ST; instead we filter the fetched page client-side,
    // mirroring list_unpaid_invoices.ts's balance!=0 pattern for a
    // genuinely-broken ST filter. Known tradeoff carried over from that
    // same pattern: page/pageSize apply server-side to the UNFILTERED set,
    // so a page can come back with fewer matches (or zero) than pageSize
    // even when more exist on other pages.
    let timesheets = (data.data ?? []).map(slim);
    if (args.employeeId !== undefined) {
      timesheets = timesheets.filter((t) => t.employee_id === args.employeeId);
    }
    if (args.timesheetCodeId !== undefined) {
      timesheets = timesheets.filter((t) => t.timesheet_code_id === args.timesheetCodeId);
    }

    return {
      count: timesheets.length,
      timesheets,
      has_more: !!data.hasMore,
      _source: 'live',
    };
  },
  transformResult: defaultShaper,
};
