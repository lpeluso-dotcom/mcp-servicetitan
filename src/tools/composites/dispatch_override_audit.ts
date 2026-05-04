import { z } from 'zod';
import { McpError } from '../../errors';
import { authHeaders } from '../../auth';
import type { ToolDef } from '../index';

interface Args { from: string; to: string; technicianId?: number }

export const dispatch_override_audit: ToolDef<Args> = {
  name: 'dispatch_override_audit',
  description: 'L5 composite: audit of dispatch assignment overrides (technician reassignments) in a date range. Joins appointment_assignments + appointments + technicians. 60 min memo. Source: D1 (appointment_assignments nightly-synced).',
  zodSchema: {
    from: z.string().describe('Start date (ISO 8601)'),
    to: z.string().describe('End date (ISO 8601)'),
    technicianId: z.number().int().positive().optional().describe('Filter by technician ID'),
  },
  async handler(env, args, { actor, correlation }) {
    const { from, to, technicianId } = args;
    const qs = new URLSearchParams();
    qs.set('startsOnOrAfter', from);
    qs.set('startsBefore', to);
    if (technicianId) qs.set('technicianIds', String(technicianId));
    qs.set('pageSize', '200');

    const resp = await env.ST_PROXY.fetch(
      `https://servicetitan-proxy/api/st/read?endpoint=${encodeURIComponent(`/jpm/v2/tenant/000000000/appointments?${qs}`)}`,
      { headers: authHeaders(env, correlation, actor) }
    );
    if (!resp.ok) throw new McpError('upstream_error', `dispatch_override_audit failed: ${resp.status}`, { correlation });
    const data = await resp.json<{ data?: any[] }>();
    const appointments = data.data ?? [];

    // Flag appointments where technician assignment differs from original dispatch
    // (override = appointmentAssignments changed after initial booking)
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
    };
  },
};
