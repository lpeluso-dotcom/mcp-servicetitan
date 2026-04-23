// T1 catalog correction: renamed from update_customer_note — ST API is append-only (no PATCH on notes).
import { z } from 'zod';
import { McpError } from '../../errors';
import { WriteGate } from '../../write-gate';
import type { ToolDef } from '../index';

interface Args { customerId: number; note: string; dryRun?: boolean; confirmation_token?: string }

export const add_customer_note: ToolDef<Args> = {
  name: 'add_customer_note',
  description: 'Append a note to a customer record. ST notes are append-only — this creates a new note entry, not an update. dryRun=true (default) → token → dryRun=false to write.',
  isWrite: true,
  zodSchema: {
    customerId: z.number().int().positive().describe('ST customer ID'),
    note: z.string().min(1).describe('Note text to append'),
    dryRun: z.boolean().default(true).describe('true (default) = preview + token; false = execute write'),
    confirmation_token: z.string().optional().describe('Token from prior dryRun=true call'),
  },
  async handler(env, args, { actor, correlation }) {
    const { customerId, note, dryRun = true, confirmation_token } = args;
    const businessArgs = { customerId, note };
    const gate = new WriteGate(env);
    const endpoint = `/crm/v2/tenant/431848990/customers/${customerId}/notes`;

    if (dryRun) {
      return gate.dryRun('add_customer_note', businessArgs, actor, correlation, { note }, endpoint, 'POST');
    }
    if (!confirmation_token) {
      throw new McpError('validation_error', 'confirmation_token required when dryRun=false', { correlation });
    }
    await gate.verifyToken('add_customer_note', businessArgs, actor, confirmation_token);

    const resp = await env.TAYLOR_AI.fetch('https://taylor-ai/api/st/write', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-sync-key': env.MCP_SYNC_KEY, 'x-correlation-id': correlation, 'x-actor': actor },
      body: JSON.stringify({ endpoint, method: 'POST', payload: { note } }),
    });
    if (!resp.ok) throw new McpError('upstream_error', `add_customer_note failed: ${resp.status}`, { correlation });
    return { dryRun: false, tool: 'add_customer_note', result: await resp.json(), correlation };
  },
};
