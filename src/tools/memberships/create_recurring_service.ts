import { z } from 'zod';
import { McpError } from '../../errors';
import { WriteGate } from '../../write-gate';
import type { ToolDef } from '../index';

interface Args {
  membershipId: number;
  serviceTypeId: number;
  locationId: number;
  dryRun?: boolean;
  confirmation_token?: string;
}

// ST rejects with 400 if the membership is not Active.
export const create_recurring_service: ToolDef<Args> = {
  name: 'create_recurring_service',
  description: 'Create a recurring service under an active membership. ST requires the membership to be Active (returns 400 otherwise). dryRun=true (default) → token → dryRun=false to write.',
  isWrite: true,
  zodSchema: {
    membershipId: z.number().int().positive().describe('ST membership ID (must be Active status)'),
    serviceTypeId: z.number().int().positive().describe('ST service type ID for the recurring service'),
    locationId: z.number().int().positive().describe('ST location ID where the service will be performed'),
    dryRun: z.boolean().default(true).describe('true (default) = preview + token; false = execute write'),
    confirmation_token: z.string().optional().describe('Token from prior dryRun=true call'),
  },
  async handler(env, args, { actor, correlation }) {
    const { membershipId, serviceTypeId, locationId, dryRun = true, confirmation_token } = args;
    const businessArgs = { membershipId, serviceTypeId, locationId };
    const payload = { membershipId, serviceTypeId, locationId };
    const endpoint = `/memberships/v2/tenant/431848990/recurring-service-types/${serviceTypeId}/recurring-services`;
    const gate = new WriteGate(env);

    if (dryRun) {
      return gate.dryRun('create_recurring_service', businessArgs, actor, correlation, payload, endpoint, 'POST');
    }
    if (!confirmation_token) {
      throw new McpError('validation_error', 'confirmation_token required when dryRun=false', { correlation });
    }
    await gate.verifyToken('create_recurring_service', businessArgs, actor, confirmation_token);

    const resp = await env.TAYLOR_AI.fetch('https://taylor-ai/api/st/write', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-sync-key': env.MCP_SYNC_KEY, 'x-correlation-id': correlation, 'x-actor': actor },
      body: JSON.stringify({ endpoint, method: 'POST', payload }),
    });
    if (!resp.ok) throw new McpError('upstream_error', `create_recurring_service failed: ${resp.status}`, { correlation });
    return { dryRun: false, tool: 'create_recurring_service', result: await resp.json(), correlation };
  },
};
