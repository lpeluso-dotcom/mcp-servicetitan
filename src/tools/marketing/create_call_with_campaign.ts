import { z } from 'zod';
import { McpError } from '../../errors';
import { WriteGate } from '../../write-gate';
import type { ToolDef } from '../index';

interface Args {
  customerId: number;
  campaignId: number;
  leadCallId?: string;
  dryRun?: boolean;
  confirmation_token?: string;
}

// T10 catalog correction: renamed from create_lead_attribution_call.
// ST has no "lead attribution" object — POST /telecom/v3/tenant/.../calls
// with {campaignId, customerId, leadCallId} stitched in.
export const create_call_with_campaign: ToolDef<Args> = {
  name: 'create_call_with_campaign',
  description: 'Create a telecom call record attributed to a marketing campaign. Note: ST has no "lead attribution" object — this POSTs to /telecom/v3/tenant/.../calls with campaignId stitched in. dryRun=true (default) → token → dryRun=false to write.',
  isWrite: true,
  zodSchema: {
    customerId: z.number().int().positive().describe('ST customer ID'),
    campaignId: z.number().int().positive().describe('ST campaign ID to attribute the call to'),
    leadCallId: z.string().optional().describe('External call ID from your call tracking system (e.g. Lace)'),
    dryRun: z.boolean().default(true).describe('true (default) = preview + token; false = execute write'),
    confirmation_token: z.string().optional().describe('Token from prior dryRun=true call'),
  },
  async handler(env, args, { actor, correlation }) {
    const { customerId, campaignId, leadCallId, dryRun = true, confirmation_token } = args;
    const businessArgs = { customerId, campaignId, leadCallId };
    const payload: Record<string, unknown> = { customerId, campaignId };
    if (leadCallId) payload.leadCallId = leadCallId;
    const endpoint = `/telecom/v3/tenant/431848990/calls`;
    const gate = new WriteGate(env);

    if (dryRun) {
      return gate.dryRun('create_call_with_campaign', businessArgs, actor, correlation, payload, endpoint, 'POST');
    }
    if (!confirmation_token) {
      throw new McpError('validation_error', 'confirmation_token required when dryRun=false', { correlation });
    }
    await gate.verifyToken('create_call_with_campaign', businessArgs, actor, confirmation_token);

    const resp = await env.TAYLOR_AI.fetch('https://taylor-ai/api/st/write', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-sync-key': env.MCP_SYNC_KEY, 'x-correlation-id': correlation, 'x-actor': actor },
      body: JSON.stringify({ endpoint, method: 'POST', payload }),
    });
    if (!resp.ok) throw new McpError('upstream_error', `create_call_with_campaign failed: ${resp.status}`, { correlation });
    return { dryRun: false, tool: 'create_call_with_campaign', result: await resp.json(), correlation };
  },
};
