import { z } from 'zod';
import { McpError } from '../../errors';
import { WriteGate } from '../../write-gate';
import type { ToolDef } from '../index';

interface Args { jobId: number; note: string; dryRun?: boolean; confirmation_token?: string }

export const add_job_note: ToolDef<Args> = {
  name: 'add_job_note',
  description: 'Append a note to a job. ST notes are append-only. dryRun=true (default) → token → dryRun=false to write.',
  isWrite: true,
  zodSchema: {
    jobId: z.number().int().positive().describe('ST job ID'),
    note: z.string().min(1).describe('Note text to append'),
    dryRun: z.boolean().default(true).describe('true (default) = preview + token; false = execute write'),
    confirmation_token: z.string().optional().describe('Token from prior dryRun=true call'),
  },
  async handler(env, args, { actor, correlation }) {
    const { jobId, note, dryRun = true, confirmation_token } = args;
    const businessArgs = { jobId, note };
    const gate = new WriteGate(env);
    const endpoint = `/jpm/v2/tenant/431848990/jobs/${jobId}/notes`;

    if (dryRun) {
      return gate.dryRun('add_job_note', businessArgs, actor, correlation, { note }, endpoint, 'POST');
    }
    if (!confirmation_token) {
      throw new McpError('validation_error', 'confirmation_token required when dryRun=false', { correlation });
    }
    await gate.verifyToken('add_job_note', businessArgs, actor, confirmation_token);

    const resp = await env.TAYLOR_AI.fetch('https://taylor-ai/api/st/write', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-sync-key': env.MCP_SYNC_KEY, 'x-correlation-id': correlation, 'x-actor': actor },
      body: JSON.stringify({ endpoint, method: 'POST', payload: { note } }),
    });
    if (!resp.ok) throw new McpError('upstream_error', `add_job_note failed: ${resp.status}`, { correlation });
    return { dryRun: false, tool: 'add_job_note', result: await resp.json(), correlation };
  },
};
