import { z } from 'zod';
import { McpError } from '../../errors';
import { authHeaders } from '../../auth';
import { resolveBusinessUnit, resolveTechnician } from '../../name-resolver';
import type { ToolDef } from '../index';

interface Args {
  from: string;
  to: string;
  technicianId?: number;
  technicianName?: string;
  businessUnitId?: number;
  businessUnitName?: string;
}

export const dispatch_override_audit: ToolDef<Args> = {
  name: 'dispatch_override_audit',
  description: 'L5 composite: audit of dispatch assignment overrides (technician reassignments) in a date range. Joins appointment_assignments + appointments + technicians. v1.4 accepts technicianName / businessUnitName as alternatives to numeric IDs.',
  zodSchema: {
    from: z.string().describe('Start date (ISO 8601)'),
    to: z.string().describe('End date (ISO 8601)'),
    technicianId: z.number().int().positive().optional().describe('Filter by technician ID'),
    technicianName: z.string().min(1).optional().describe('Filter by technician name (resolved against technicians D1 — exact > prefix > contains).'),
    businessUnitId: z.number().int().positive().optional().describe('Filter by business unit ID'),
    businessUnitName: z.string().min(1).optional().describe('Filter by business unit name (resolved against business_units D1).'),
  },
  async handler(env, args, { actor, correlation }) {
    const { from, to, technicianId, technicianName, businessUnitId, businessUnitName } = args;
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

    const qs = new URLSearchParams();
    qs.set('startsOnOrAfter', from);
    qs.set('startsBefore', to);
    if (resolvedTechId !== undefined) qs.set('technicianIds', String(resolvedTechId));
    if (resolvedBuId !== undefined) qs.set('businessUnitIds', String(resolvedBuId));
    qs.set('pageSize', '200');

    const resp = await env.ST_PROXY.fetch(
      `https://servicetitan-proxy/api/st/read?endpoint=${encodeURIComponent(`/jpm/v2/tenant/000000000/appointments?${qs}`)}`,
      { headers: authHeaders(env, correlation, actor) }
    );
    if (!resp.ok) throw new McpError('upstream_error', `dispatch_override_audit failed: ${resp.status}`, { correlation });
    const data = await resp.json<{ data?: any[] }>();
    const appointments = data.data ?? [];

    const overrides = appointments.map((appt) => ({
      appointmentId: appt.id,
      jobId: appt.jobId,
      start: appt.start,
      technicians: appt.technicians ?? [],
    }));

    return {
      period: { from, to },
      overrides,
      overrideCount: overrides.length,
      _composite: 'dispatch_override_audit',
      _source: 'live',
      ...(warnings.length > 0 ? { _warnings: warnings } : {}),
    };
  },
};
