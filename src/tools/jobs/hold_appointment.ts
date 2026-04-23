// T4 catalog correction: dedicated sub-route POST .../appointments/{id}/hold with {reasonId, memo}.
// NOT a PATCH — ST has a specific /hold endpoint.
import { z } from 'zod';
import { McpError } from '../../errors';
import { WriteGate } from '../../write-gate';
import type { ToolDef } from '../index';

interface Args { appointmentId: number; reasonId: number; memo?: string; dryRun?: boolean; confirmation_token?: string }

export const hold_appointment: ToolDef<Args> = {
  name: 'hold_appointment',
  description: 'Place an appointment on hold via the ST /hold sub-route (POST, not PATCH). dryRun=true (default) → token → dryRun=false to write.',
  isWrite: true,
  zodSchema: {
    appointmentId: z.number().int().positive().describe('ST appointment ID'),
    reasonId: z.number().int().positive().describe('Hold reason ID'),
    memo: z.string().optional().describe('Optional memo text for the hold'),
    dryRun: z.boolean().default(true).describe('true (default) = preview + token; false = execute write'),
    confirmation_token: z.string().optional().describe('Token from prior dryRun=true call'),
  },
  async handler(env, args, { actor, correlation }) {
    const { appointmentId, reasonId, memo, dryRun = true, confirmation_token } = args;
    const businessArgs = { appointmentId, reasonId, memo };
    const payload = { reasonId, memo };
    const gate = new WriteGate(env);
    const endpoint = `/jpm/v2/tenant/431848990/appointments/${appointmentId}/hold`;

    if (dryRun) {
      return gate.dryRun('hold_appointment', businessArgs, actor, correlation, payload, endpoint, 'POST');
    }
    if (!confirmation_token) {
      throw new McpError('validation_error', 'confirmation_token required when dryRun=false', { correlation });
    }
    await gate.verifyToken('hold_appointment', businessArgs, actor, confirmation_token);

    const resp = await env.TAYLOR_AI.fetch('https://taylor-ai/api/st/write', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-sync-key': env.MCP_SYNC_KEY, 'x-correlation-id': correlation, 'x-actor': actor },
      body: JSON.stringify({ endpoint, method: 'POST', payload }),
    });
    if (!resp.ok) throw new McpError('upstream_error', `hold_appointment failed: ${resp.status}`, { correlation });
    return { dryRun: false, tool: 'hold_appointment', result: await resp.json(), correlation };
  },
};
