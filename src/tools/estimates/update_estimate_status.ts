import { z } from 'zod';
import { McpError } from '../../errors';
import { WriteGate } from '../../write-gate';
import type { ToolDef } from '../index';

const EstimateStatus = z.enum(['Open', 'Presented', 'Sold', 'Dismissed', 'Expired']);

interface Args {
  estimateId: number;
  status: z.infer<typeof EstimateStatus>;
  soldBy?: number;
  dryRun?: boolean;
  confirmation_token?: string;
}

// status=Sold requires soldBy technicianId — ST rejects without it.
const estimateStatusSchema = z.object({
  estimateId: z.number().int().positive(),
  status: EstimateStatus,
  soldBy: z.number().int().positive().optional(),
  dryRun: z.boolean().default(true),
  confirmation_token: z.string().optional(),
}).refine((d) => d.status !== 'Sold' || d.soldBy !== undefined, {
  message: 'soldBy technicianId is required when status=Sold',
  path: ['soldBy'],
});

export const update_estimate_status: ToolDef<Args> = {
  name: 'update_estimate_status',
  description: 'Update the status of an estimate (Open → Presented → Sold|Dismissed|Expired). status=Sold requires soldBy technicianId (ST rejects without it). dryRun=true (default) → token → dryRun=false to write.',
  isWrite: true,
  zodSchema: estimateStatusSchema.shape as unknown as z.ZodRawShape,
  async handler(env, args, { actor, correlation }) {
    // Re-validate with refine (zodSchema is raw shape only — refine can't live there)
    const parsed = estimateStatusSchema.safeParse(args);
    if (!parsed.success) {
      throw new McpError('validation_error', parsed.error.issues[0]?.message ?? 'invalid args', { correlation });
    }
    const { estimateId, status, soldBy, dryRun = true, confirmation_token } = args;
    const businessArgs = { estimateId, status, soldBy };
    const payload: Record<string, unknown> = { status };
    if (soldBy !== undefined) payload.soldBy = soldBy;
    const endpoint = `/sales/v2/tenant/431848990/estimates/${estimateId}`;
    const gate = new WriteGate(env);

    if (dryRun) {
      return gate.dryRun('update_estimate_status', businessArgs, actor, correlation, payload, endpoint, 'PATCH');
    }
    if (!confirmation_token) {
      throw new McpError('validation_error', 'confirmation_token required when dryRun=false', { correlation });
    }
    await gate.verifyToken('update_estimate_status', businessArgs, actor, confirmation_token);

    const resp = await env.TAYLOR_AI.fetch('https://taylor-ai/api/st/write', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-sync-key': env.MCP_SYNC_KEY, 'x-correlation-id': correlation, 'x-actor': actor },
      body: JSON.stringify({ endpoint, method: 'PATCH', payload }),
    });
    if (!resp.ok) throw new McpError('upstream_error', `update_estimate_status failed: ${resp.status}`, { correlation });
    return { dryRun: false, tool: 'update_estimate_status', result: await resp.json(), correlation };
  },
};
