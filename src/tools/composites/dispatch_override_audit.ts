import { z } from 'zod';
import { McpError } from '../../errors';
import { authHeaders } from '../../auth';
import { readST } from '../../st';
import { pagedStRead } from '../../paged-st-read';
import { readD1 } from '../../d1';
import { chunk, ST_IDS_BATCH_MAX, D1_BIND_PARAM_MAX } from '../../chunk';
import { resolveBusinessUnit, resolveTechnician } from '../../name-resolver';
import { defaultShaper } from '../../response-shape';
import { stampMirrorFreshness, fetchTableMax, type FreshnessStamp } from '../../mirror-freshness';
import type { ToolDef } from '../index';

interface AssignmentRow {
  appointment_id: number;
  technician_id: number;
  technician_name: string | null;
  status: string | null;
  /** Row-level sync timestamp — feeds the mirror-freshness stamp, stripped from output. */
  synced_at: string | null;
}

interface AppointmentRow {
  id?: number;
  jobId?: number;
  start?: string;
}

interface Args {
  from: string;
  to: string;
  technicianId?: number;
  technicianName?: string;
  businessUnitId?: number;
  businessUnitName?: string;
  includeAutoDispatchedFlag?: boolean;
}

const TENANT_ID = '000000000';

/**
 * What this tool actually measures.
 *
 * The old shape was `overrides = appointments.map(...)` with
 * `overrideCount: overrides.length` — i.e. every appointment in the range,
 * reported under a name that means "a dispatch decision was overridden".
 * There is no reassignment detection here and none is possible from these
 * sources: ST's /jpm/v2 appointments feed carries no dispatch history, and the
 * D1 `appointment_assignments` mirror stores the CURRENT assignment with no
 * prior-assignee column to diff against. Detecting a real override needs a
 * change feed (webhook/audit trail) this worker does not have.
 *
 * So the honest move is to name the count for what it counts. The tool's
 * registered name is left alone (it is a published MCP tool id), but the
 * payload and description now state plainly that no override detection ran.
 */
const NO_OVERRIDE_DETECTION_NOTE =
  'This tool does NOT detect technician reassignments. `appointmentCount` is the number of appointments ' +
  'in the range, each annotated with its CURRENT technician assignment from the D1 appointment_assignments ' +
  'mirror. Neither ST /jpm/v2 appointments nor that mirror exposes a prior assignee or a dispatch change ' +
  'history, so an override rate cannot be derived here — do not read this count as overrides.';

export const dispatch_override_audit: ToolDef<Args> = {
  name: 'dispatch_override_audit',
  description:
    'L5 composite: appointments in a date range with their CURRENT technician assignments. ' +
    'It does NOT detect technician reassignments — no override rate is computed, because neither the live ST appointments feed ' +
    'nor the D1 appointment_assignments mirror carries a prior assignee or dispatch change history; `appointmentCount` counts appointments, not overrides. ' +
    'Joins appointment_assignments + appointments + technicians. Paginates the range (up to 20 pages x 200) and reports `pageCount` + `_truncated`. ' +
    'v1.4 accepts technicianName / businessUnitName as alternatives to numeric IDs. ' +
    'v1.5.1 (ST-77): pass `includeAutoDispatchedFlag: true` to annotate each row with `isAutoDispatched` (boolean) by batch-fetching the parent jobs (chunked to 50 ids per ST call). ' +
    'Source: mixed (live ST appointments joined to D1 appointment_assignments; optional live ST jobs batch for isAutoDispatched). ' +
    'The freshness stamp (_mirror_table/_freshness/_stale_hours) covers ONLY the D1 appointment_assignments join that fills each row\'s `technicians`; the appointments/jobs data itself is live ServiceTitan.',
  zodSchema: {
    from: z.string().describe('Start date (ISO 8601)'),
    to: z.string().describe('End date (ISO 8601)'),
    technicianId: z.number().int().positive().optional().describe('Filter by technician ID'),
    technicianName: z.string().min(1).optional().describe('Filter by technician name (resolved against technicians D1 — exact > prefix > contains).'),
    businessUnitId: z.number().int().positive().optional().describe('Filter by business unit ID'),
    businessUnitName: z.string().min(1).optional().describe('Filter by business unit name (resolved against business_units D1).'),
    includeAutoDispatchedFlag: z.boolean().optional().describe('When true, batch-fetches parent jobs and annotates each row with `isAutoDispatched`. Adds one extra ST call per 50 job ids.'),
  },
  stEndpoint: { method: 'GET', path: '/jpm/v2/tenant/{tid}/appointments', source: 'live' },
  async handler(env, args, { actor, correlation }) {
    const { from, to, technicianId, technicianName, businessUnitId, businessUnitName, includeAutoDispatchedFlag } = args;
    if (technicianId !== undefined && technicianName !== undefined) {
      throw new McpError('validation_error', 'pass at most one of technicianId or technicianName', { correlation });
    }
    if (businessUnitId !== undefined && businessUnitName !== undefined) {
      throw new McpError('validation_error', 'pass at most one of businessUnitId or businessUnitName', { correlation });
    }

    const warnings: string[] = [];
    let resolvedTechId: number | undefined = technicianId;
    if (technicianName !== undefined) {
      const r = await resolveTechnician(env, technicianName, 'read');
      resolvedTechId = r.id;
      if (r.ambiguous) warnings.push(`technician_name_ambiguous: chose ${r.id} for "${technicianName}"`);
    }
    let resolvedBuId: number | undefined = businessUnitId;
    if (businessUnitName !== undefined) {
      const r = await resolveBusinessUnit(env, businessUnitName, 'read');
      resolvedBuId = r.id;
      if (r.ambiguous) warnings.push(`businessUnit_name_ambiguous: chose ${r.id} for "${businessUnitName}"`);
    }

    // pagedStRead takes raw outbound headers rather than readST's
    // {actor, correlation} context: it builds each page URL itself and calls
    // the rate-limiter DO per attempt, so the headers are materialised here
    // once instead of per call. `pageSize` moves out of the query into opts
    // (the helper owns page/pageSize), and the query narrows to
    // Record<string, string | number>, so optional filters are added
    // conditionally instead of being passed as undefined.
    const query: Record<string, string | number> = { startsOnOrAfter: from, startsBefore: to };
    if (resolvedTechId !== undefined) query.technicianIds = resolvedTechId;
    if (resolvedBuId !== undefined) query.businessUnitIds = resolvedBuId;

    const headers = authHeaders(env, correlation, actor);
    const paged = await pagedStRead<AppointmentRow>(
      env,
      headers,
      `/jpm/v2/tenant/${TENANT_ID}/appointments`,
      query,
    );

    if (paged.pageCount === 0 && paged.partialFailures.length > 0) {
      const first = paged.partialFailures[0];
      throw new McpError(
        'upstream_error',
        `dispatch_override_audit: appointments fetch failed before any page was read (page ${first.page}, status ${first.status}): ${first.message}`,
        { correlation, details: { failures: paged.partialFailures } },
      );
    }
    warnings.push(...paged.warnings);
    const appointments = paged.items;

    // ST /jpm/v2/appointments does NOT carry technician assignments, so join the
    // synced D1 appointment_assignments table to populate `technicians` per
    // appointment (previously `appt.technicians` was always undefined → []).
    const techsByAppt = new Map<number, Omit<AssignmentRow, 'synced_at'>[]>();
    const apptIds = appointments.map((a) => a.id).filter((id: unknown): id is number => typeof id === 'number');
    // MB-1 / QUA-1141: HYBRID tool — the appointments above are live ST and
    // already authoritative; only this mirror-sourced join is stamped, and
    // `_mirror_table` scopes the stamp to `appointment_assignments`. With the
    // mirror empty/frozen every appointment shows `technicians: []`, which
    // reads as "nobody assigned" rather than "the sync is broken" — disclose.
    // When there are no appointments, no mirror read runs and no stamp is
    // emitted: there is no mirror claim to disclose. The stamp's warning is
    // concatenated into the existing _warnings array.
    let freshness: Omit<FreshnessStamp, '_warning'> | null = null;
    if (apptIds.length > 0) {
      // The IN (…) list is chunked: a full 200-row appointment page bound 200
      // variables against SQLite's ~100 ceiling, which is where the
      // `too many SQL variables` failures came from. Chunks are read in
      // parallel and the rows concatenated, so the freshness stamp still sees
      // one combined row set and judges the mirror once.
      const batches = chunk(apptIds, D1_BIND_PARAM_MAX);
      const [chunkResults, tableMax] = await Promise.all([
        Promise.all(
          batches.map((ids) =>
            readD1<AssignmentRow>(
              env,
              `SELECT appointment_id, technician_id, technician_name, status, synced_at
           FROM appointment_assignments WHERE appointment_id IN (${ids.map(() => '?').join(',')})`,
              ids,
            ),
          ),
        ),
        fetchTableMax(env, ['appointment_assignments']),
      ]);
      const rows = chunkResults.flatMap((r) => r.rows);
      const { _warning: freshnessWarning, ...stamp } = stampMirrorFreshness(rows, {
        table: 'appointment_assignments',
        tableMax,
      });
      if (freshnessWarning) warnings.push(freshnessWarning);
      freshness = stamp;
      for (const { synced_at: _synced_at, ...r } of rows) {
        const arr = techsByAppt.get(r.appointment_id) ?? [];
        arr.push(r);
        techsByAppt.set(r.appointment_id, arr);
      }
    }

    // ST-77 optional join: batch-fetch parent jobs to get isAutoDispatched.
    // `?ids=` is a simple-IDs lookup that cannot paginate and 400s above ~50
    // ids, so it is chunked rather than truncated (same cap list_jobs_today
    // applies to its own ids call).
    let autoDispatchedByJobId: Map<number, boolean> | null = null;
    if (includeAutoDispatchedFlag && appointments.length > 0) {
      const jobIds = Array.from(
        new Set(appointments.map((a) => a.jobId).filter((id): id is number => typeof id === 'number')),
      );
      if (jobIds.length > 0) {
        const batches = chunk(jobIds, ST_IDS_BATCH_MAX);
        const responses = await Promise.all(
          batches.map((ids) =>
            readST<{ data?: any[] }>(
              env,
              { actor, correlation },
              `/jpm/v2/tenant/${TENANT_ID}/jobs`,
              { ids: ids.join(','), pageSize: ids.length },
            ),
          ),
        );
        autoDispatchedByJobId = new Map(
          responses.flatMap((r) => (r.data ?? []).map((j) => [j.id, !!j.isAutoDispatched] as [number, boolean])),
        );
      }
    }

    const rows = appointments.map((appt) => {
      const row: Record<string, unknown> = {
        appointmentId: appt.id,
        jobId: appt.jobId,
        start: appt.start,
        technicians: (appt.id !== undefined ? techsByAppt.get(appt.id) : undefined) ?? [],
      };
      if (autoDispatchedByJobId) {
        row.isAutoDispatched = appt.jobId !== undefined
          ? autoDispatchedByJobId.get(appt.jobId) ?? null
          : null;
      }
      return row;
    });

    return {
      period: { from, to },
      appointments: rows,
      appointmentCount: rows.length,
      pageCount: paged.pageCount,
      _composite: 'dispatch_override_audit',
      _source: 'live',
      _truncated: paged.truncated,
      _note: NO_OVERRIDE_DETECTION_NOTE,
      ...(includeAutoDispatchedFlag ? { _autoDispatchedJoin: autoDispatchedByJobId ? 'applied' : 'no_appointments' } : {}),
      ...(freshness ?? {}),
      ...(warnings.length > 0 ? { _warnings: warnings } : {}),
      ...(paged.partialFailures.length > 0
        ? { _partial: true, _failures: paged.partialFailures }
        : {}),
    };
  },
  transformResult: defaultShaper,
};
