// T3 catalog correction: PATCH /jpm/v2/tenant/.../appointments/{id}
// with {start, end, arrivalWindowStart, arrivalWindowEnd}.
// Tech assignments stay pinned to old slot — document as compound write if tech-follow needed.
import { z } from 'zod';
import { McpError } from '../../errors';
import { WriteGate } from '../../write-gate';
import type { ToolDef } from '../index';

interface Args {
  appointmentId: number; start: string; end: string;
  arrivalWindowStart: string; arrivalWindowEnd: string;
  dryRun?: boolean; confirmation_token?: string;
}

export const reschedule_appointment: ToolDef<Args> = {
  name: 'reschedule_appointment',
  description: 'Reschedule an appointment (PATCH start/end/arrivalWindow). Tech assignments stay pinned to the old slot — use assign_technicians separately if you need them to follow. dryRun=true (default) → token → dryRun=false to write.',
  isWrite: true,
  zodSchema: {
    appointmentId: z.number().int().positive().describe('ST appointment ID'),
    start: z.string().describe('New appointment start ISO 8601 datetime'),
    end: z.string().describe('New appointment end ISO 8601 datetime'),
    arrivalWindowStart: z.string().describe('Arrival window start ISO 8601 datetime'),
    arrivalWindowEnd: z.string().describe('Arrival window end ISO 8601 datetime'),
    dryRun: z.boolean().default(true).describe('true (default) = preview + token; false = execute write'),
    confirmation_token: z.string().optional().describe('Token from prior dryRun=true call'),
  },
  async handler(env, args, { actor, correlation }) {
    const { appointmentId, dryRun = true, confirmation_token, ...fields } = args;
    const businessArgs = { appointmentId, ...fields };
    const gate = new WriteGate(env);
    const endpoint = `/jpm/v2/tenant/431848990/appointments/${appointmentId}`;

    if (dryRun) {
      return gate.dryRun('reschedule_appointment', businessArgs, actor, correlation, fields, endpoint, 'PATCH');
    }
    if (!confirmation_token) {
      throw new McpError('validation_error', 'confirmation_token required when dryRun=false', { correlation });
    }
    await gate.verifyToken('reschedule_appointment', businessArgs, actor, confirmation_token);

    const resp = await env.TAYLOR_AI.fetch('https://taylor-ai/api/st/write', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-sync-key': env.MCP_SYNC_KEY, 'x-correlation-id': correlation, 'x-actor': actor },
      body: JSON.stringify({ endpoint, method: 'PATCH', payload: fields }),
    });
    if (!resp.ok) throw new McpError('upstream_error', `reschedule_appointment failed: ${resp.status}`, { correlation });
    return { dryRun: false, tool: 'reschedule_appointment', result: await resp.json(), correlation };
  },
};
