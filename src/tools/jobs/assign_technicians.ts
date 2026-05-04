// T5 catalog correction: ST has NO generic PATCH for tech assignment.
// Must be a two-call compound: unassign-technicians → assign-technicians.
// Both calls are included in a single dryRun preview payload.
import { z } from 'zod';
import { McpError } from '../../errors';
import { WriteGate } from '../../write-gate';
import type { ToolDef } from '../index';

interface Args { appointmentId: number; technicianIds: number[]; dryRun?: boolean; confirmation_token?: string }

export const assign_technicians: ToolDef<Args> = {
  name: 'assign_technicians',
  description: 'Assign technicians to an appointment. ST requires a two-call compound: unassign all current techs, then assign the new set. Both calls are shown in the dryRun preview. dryRun=true (default) → token → dryRun=false to write.',
  isWrite: true,
  zodSchema: {
    appointmentId: z.number().int().positive().describe('ST appointment ID'),
    technicianIds: z.array(z.number().int().positive()).min(1).describe('Technician IDs to assign (replaces current assignment)'),
    dryRun: z.boolean().default(true).describe('true (default) = preview + token; false = execute write'),
    confirmation_token: z.string().optional().describe('Token from prior dryRun=true call'),
  },
  async handler(env, args, { actor, correlation }) {
    const { appointmentId, technicianIds, dryRun = true, confirmation_token } = args;
    const businessArgs = { appointmentId, technicianIds };
    const gate = new WriteGate(env);
    // Show the compound operation in the dryRun payload.
    const compoundPayload = {
      steps: [
        { call: 1, endpoint: `/jpm/v2/tenant/000000000/appointment-assignments/unassign-technicians`, method: 'POST', payload: { appointmentId } },
        { call: 2, endpoint: `/jpm/v2/tenant/000000000/appointment-assignments/assign-technicians`, method: 'POST', payload: { appointmentId, technicianIds } },
      ],
    };

    if (dryRun) {
      return gate.dryRun('assign_technicians', businessArgs, actor, correlation, compoundPayload,
        `/jpm/v2/tenant/000000000/appointment-assignments`, 'POST');
    }
    if (!confirmation_token) {
      throw new McpError('validation_error', 'confirmation_token required when dryRun=false', { correlation });
    }
    await gate.verifyToken('assign_technicians', businessArgs, actor, confirmation_token);

    // Call 1: unassign all current technicians from this appointment.
    const unassignResp = await env.ST_PROXY.fetch('https://servicetitan-proxy/api/st/write', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-sync-key': env.MCP_SYNC_KEY, 'x-correlation-id': correlation, 'x-actor': actor },
      body: JSON.stringify({
        endpoint: `/jpm/v2/tenant/000000000/appointment-assignments/unassign-technicians`,
        method: 'POST',
        payload: { appointmentId },
      }),
    });
    if (!unassignResp.ok) {
      throw new McpError('upstream_error', `assign_technicians: unassign step failed: ${unassignResp.status}`, { correlation });
    }

    // Call 2: assign the new technician set.
    const assignResp = await env.ST_PROXY.fetch('https://servicetitan-proxy/api/st/write', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-sync-key': env.MCP_SYNC_KEY, 'x-correlation-id': correlation, 'x-actor': actor },
      body: JSON.stringify({
        endpoint: `/jpm/v2/tenant/000000000/appointment-assignments/assign-technicians`,
        method: 'POST',
        payload: { appointmentId, technicianIds },
      }),
    });
    if (!assignResp.ok) {
      throw new McpError('upstream_error', `assign_technicians: assign step failed: ${assignResp.status}`, { correlation });
    }

    return { dryRun: false, tool: 'assign_technicians', result: await assignResp.json(), correlation };
  },
};
