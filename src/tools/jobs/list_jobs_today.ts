import { z } from 'zod';
import { McpError } from '../../errors';
import { cacheGet } from '../../cache';
import { resolveBusinessUnit, resolveTechnician } from '../../name-resolver';
import { readST, readSTPaged } from '../../st';
import type { ToolDef } from '../index';
import { defaultShaper } from '../../response-shape';

const TENANT_ID = '000000000';
const TZ = 'America/New_York';

/**
 * Cap on a simple-IDs lookup (`?ids=a,b,c`). Over the cap ST returns HTTP 400
 * `{"errors":{"Ids":["Simple IDs lookup should n…"]}}` (ST truncates there).
 *
 * Verified live 2026-07-27/28 against tenant 431848990: a 200-id chunk 400s,
 * a 50-id chunk succeeds. The exact ceiling is somewhere in (50, 200); 50 is
 * the documented-safe batch size, so this stays at 50 rather than probing for
 * the true edge.
 */
const ST_IDS_BATCH_MAX = 50;

interface Args {
  status?: string;
  businessUnitId?: number;
  businessUnitName?: string;
  technicianId?: number;
  technicianName?: string;
  // Accepted but ignored: pagination is automatic now (the appointment drain is
  // internal). Kept so existing callers that still pass them don't error.
  page?: number;
  pageSize?: number;
}

/** ET (America/New_York) calendar-date parts for an instant. */
function etDateParts(now: Date): { y: number; m: number; d: number } {
  const s = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
  const [y, m, d] = s.split('-').map(Number);
  return { y, m, d };
}

/**
 * UTC ISO instant of wall-clock midnight on (y,m,d) in America/New_York.
 * Derives the zone offset for that specific date, so it is correct across
 * the EDT/EST boundary (no hard-coded -04:00/-05:00).
 */
function etMidnightToUtcIso(y: number, m: number, d: number): string {
  const utcGuess = Date.UTC(y, m - 1, d, 0, 0, 0);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(utcGuess));
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  let hour = get('hour');
  if (hour === 24) hour = 0; // some ICU builds report midnight as 24
  const asIfUtc = Date.UTC(get('year'), get('month') - 1, get('day'), hour, get('minute'), get('second'));
  const offset = asIfUtc - utcGuess;
  return new Date(utcGuess - offset).toISOString();
}

export const list_jobs_today: ToolDef<Args> = {
  name: 'list_jobs_today',
  description:
    "List ST jobs scheduled for TODAY (America/New_York). The ST Jobs API has NO scheduled-date field, " +
    "so this lists today's APPOINTMENTS (by start, in ET) and batch-fetches their parent jobs. " +
    'v1.5 accepts businessUnitName / technicianName as alternatives to numeric IDs. Source: live ST.',
  zodSchema: {
    status: z.string().optional().describe('Filter by job status (e.g. "Scheduled", "InProgress")'),
    businessUnitId: z.number().int().positive().optional().describe('Filter by business unit ID'),
    businessUnitName: z.string().min(1).optional().describe('Filter by business unit name (resolved against business_units D1).'),
    technicianId: z.number().int().positive().optional().describe('Filter by assigned technician ID'),
    technicianName: z.string().min(1).optional().describe('Filter by technician name (resolved against technicians D1).'),
    page: z.number().int().positive().optional().describe('Deprecated/ignored — pagination is automatic.'),
    pageSize: z.number().int().positive().max(200).optional().describe('Deprecated/ignored — pagination is automatic.'),
  },
  // Envelope precise (jobs/date/_source always present; _warnings only when a
  // businessUnitName/technicianName resolution was ambiguous). `jobs` holds
  // raw ST job resources — kept permissive against live payload drift.
  outputSchema: {
    jobs: z.array(z.record(z.string(), z.unknown())),
    date: z.string(),
    _source: z.string(),
    _warnings: z.array(z.string()).optional(),
  },
  // Primary read is now the appointments endpoint (scheduled-date source of truth).
  stEndpoint: { method: 'GET', path: '/jpm/v2/tenant/{tid}/appointments', source: 'live' },
  async handler(env, args, { actor, correlation }) {
    if (args.businessUnitId !== undefined && args.businessUnitName !== undefined) {
      throw new McpError('validation_error', 'pass at most one of businessUnitId or businessUnitName', { correlation });
    }
    if (args.technicianId !== undefined && args.technicianName !== undefined) {
      throw new McpError('validation_error', 'pass at most one of technicianId or technicianName', { correlation });
    }

    const warnings: string[] = [];
    let buId = args.businessUnitId;
    if (args.businessUnitName !== undefined) {
      const r = await resolveBusinessUnit(env, args.businessUnitName, 'read');
      buId = r.id;
      if (r.ambiguous) warnings.push(`businessUnit_name_ambiguous: chose ${r.id} for "${args.businessUnitName}"`);
    }
    let techId = args.technicianId;
    if (args.technicianName !== undefined) {
      const r = await resolveTechnician(env, args.technicianName, 'read');
      techId = r.id;
      if (r.ambiguous) warnings.push(`technician_name_ambiguous: chose ${r.id} for "${args.technicianName}"`);
    }

    // QSC operates in ET. Build today's ET day as a half-open UTC window
    // [todayMidnightET, tomorrowMidnightET) so evening-ET jobs are not
    // misclassified into the wrong day (the old code applied the window in UTC).
    const now = new Date();
    const { y, m, d } = etDateParts(now);
    const today = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const startUtc = etMidnightToUtcIso(y, m, d);
    const tmr = new Date(Date.UTC(y, m - 1, d + 1)); // Date.UTC rolls month/year
    const endUtc = etMidnightToUtcIso(tmr.getUTCFullYear(), tmr.getUTCMonth() + 1, tmr.getUTCDate());

    const cacheKey = JSON.stringify({ today, status: args.status ?? '', bu: buId ?? 0, tech: techId ?? 0 });

    const result = await cacheGet(env, 'servicetitan:list_jobs_today', cacheKey, 60, async () => {
      // Step 1: drain today's appointments (paged via hasMore) -> parent jobIds.
      const apptQuery: Record<string, unknown> = { startsOnOrAfter: startUtc, startsBefore: endUtc };
      if (techId !== undefined) apptQuery.technicianId = techId;
      const appts = await readSTPaged<{ jobId?: number }>(
        env,
        { actor, correlation },
        `/jpm/v2/tenant/${TENANT_ID}/appointments`,
        apptQuery,
        { pageSize: 200, maxPages: 20 },
      );
      if (appts.hitCap) {
        warnings.push(`appointment_pages_capped: drained ${appts.pagesFetched} pages; some of today's jobs may be omitted`);
      }
      const jobIds = Array.from(
        new Set(appts.rows.map((a) => a.jobId).filter((id): id is number => typeof id === 'number')),
      );
      if (jobIds.length === 0) {
        return { jobs: [] as Array<Record<string, unknown>>, date: today, _source: 'live' as const };
      }

      // Step 2: batch-fetch parent jobs by id, chunked <=50 ids per call
      // (the ids-batch jobs call cannot paginate, so chunk instead of truncating).
      // 50 is ST's hard cap on a simple-IDs lookup — over it the call 400s with
      // "Simple IDs lookup should not exceed 50 ids".
      const jobs: Array<Record<string, unknown>> = [];
      for (let i = 0; i < jobIds.length; i += ST_IDS_BATCH_MAX) {
        const chunk = jobIds.slice(i, i + ST_IDS_BATCH_MAX);
        const resp = await readST<{ data?: Array<Record<string, unknown>> }>(
          env,
          { actor, correlation },
          `/jpm/v2/tenant/${TENANT_ID}/jobs`,
          { ids: chunk.join(','), pageSize: chunk.length },
        );
        jobs.push(...(resp.data ?? []));
      }

      // Step 3: client-side filters the ids-batch jobs call can't express.
      let filtered = jobs;
      if (buId !== undefined) filtered = filtered.filter((j) => j.businessUnitId === buId);
      if (args.status !== undefined) {
        const want = args.status.toLowerCase();
        filtered = filtered.filter((j) => String(j.jobStatus).toLowerCase() === want);
      }

      return { jobs: filtered, date: today, _source: 'live' as const };
    });

    return warnings.length > 0 ? { ...result, _warnings: warnings } : result;
  },
  transformResult: defaultShaper,
};
