import { z } from 'zod';
import { McpError } from '../../errors';
import { readST } from '../../st';
import { readD1 } from '../../d1';
import { resolveBusinessUnit, resolveTechnician } from '../../name-resolver';
import { defaultShaper } from '../../response-shape';
import { stampMirrorFreshness, type FreshnessStamp } from '../../mirror-freshness';
import type { ToolDef } from '../index';

interface AssignmentRow {
  appointment_id: number;
  technician_id: number;
  technician_name: string | null;
  status: string | null;
  /** Row-level sync timestamp — feeds the mirror-freshness stamp, stripped from output. */
  synced_at: string | null;
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

export const dispatch_override_audit: ToolDef<Args> = {
  name: 'dispatch_override_audit',
  description:
    'L5 composite: audit of dispatch assignment overrides (technician reassignments) in a date range. ' +
    'Joins appointment_assignments + appointments + technicians. v1.4 accepts technicianName / businessUnitName as alternatives to numeric IDs. ' +
    'v1.5.1 (ST-77): pass `includeAutoDispatchedFlag: true` to annotate each row with `isAutoDispatched` (boolean) by batch-fetching the parent jobs.',
  zodSchema: {
    from: z.string().describe('Start date (ISO 8601)'),
    to: z.string().describe('End date (ISO 8601)'),
    technicianId: z.number().int().positive().optional().describe('Filter by technician ID'),
    technicianName: z.string().min(1).optional().describe('Filter by technician name (resolved against technicians D1 — exact > prefix > contains).'),
    businessUnitId: z.number().int().positive().optional().describe('Filter by business unit ID'),
    businessUnitName: z.string().min(1).optional().describe('Filter by business unit name (resolved against business_units D1).'),
    includeAutoDispatchedFlag: z.boolean().optional().describe('When true, batch-fetches parent jobs and annotates each row with `isAutoDispatched`. Adds one extra ST call.'),
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

    const query: Record<string, unknown> = { startsOnOrAfter: from, startsBefore: to, pageSize: 200 };
    if (resolvedTechId !== undefined) query.technicianIds = resolvedTechId;
    if (resolvedBuId !== undefined) query.businessUnitIds = resolvedBuId;

    const data = await readST<{ data?: any[] }>(
      env,
      { actor, correlation },
      `/jpm/v2/tenant/000000000/appointments`,
      query,
    );
    const appointments = data.data ?? [];

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
      const placeholders = apptIds.map(() => '?').join(',');
      const { rows } = await readD1<AssignmentRow>(
        env,
        `SELECT appointment_id, technician_id, technician_name, status, synced_at
         FROM appointment_assignments WHERE appointment_id IN (${placeholders})`,
        apptIds,
      );
      const { _warning: freshnessWarning, ...stamp } = stampMirrorFreshness(rows, {
        table: 'appointment_assignments',
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
    let autoDispatchedByJobId: Map<number, boolean> | null = null;
    if (includeAutoDispatchedFlag && appointments.length > 0) {
      const jobIds = Array.from(new Set(appointments.map((a) => a.jobId).filter((id) => typeof id === 'number')));
      if (jobIds.length > 0) {
        const jobsResp = await readST<{ data?: any[] }>(
          env,
          { actor, correlation },
          `/jpm/v2/tenant/000000000/jobs`,
          { ids: jobIds.join(','), pageSize: Math.min(jobIds.length, 200) },
        );
        autoDispatchedByJobId = new Map((jobsResp.data ?? []).map((j) => [j.id, !!j.isAutoDispatched]));
      }
    }

    const overrides = appointments.map((appt) => {
      const row: Record<string, unknown> = {
        appointmentId: appt.id,
        jobId: appt.jobId,
        start: appt.start,
        technicians: techsByAppt.get(appt.id) ?? [],
      };
      if (autoDispatchedByJobId) {
        row.isAutoDispatched = autoDispatchedByJobId.get(appt.jobId) ?? null;
      }
      return row;
    });

    return {
      period: { from, to },
      overrides,
      overrideCount: overrides.length,
      _composite: 'dispatch_override_audit',
      _source: 'live',
      ...(includeAutoDispatchedFlag ? { _autoDispatchedJoin: autoDispatchedByJobId ? 'applied' : 'no_appointments' } : {}),
      ...(freshness ?? {}),
      ...(warnings.length > 0 ? { _warnings: warnings } : {}),
    };
  },
  transformResult: defaultShaper,
};
