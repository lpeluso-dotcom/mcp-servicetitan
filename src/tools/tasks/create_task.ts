import { z } from 'zod';
import { McpError } from '../../errors';
import { WriteGate } from '../../write-gate';
import type { ToolDef } from '../index';

interface Args {
  name: string;
  jobId: number;
  dueDate?: string;
  assignedToId?: number;
  dryRun?: boolean;
  confirmation_token?: string;
}

// Path must be /taskmanagement/ (no hyphen) — ST 404s on /task-management/.
export const create_task: ToolDef<Args> = {
  name: 'create_task',
  description: 'Create a task linked to a job. Path: /taskmanagement/ (no hyphen — ST 404s on /task-management/). dryRun=true (default) → token → dryRun=false to write.',
  isWrite: true,
  zodSchema: {
    name: z.string().min(1).describe('Task name/description'),
    jobId: z.number().int().positive().describe('ST job ID to link the task to'),
    dueDate: z.string().optional().describe('Due date (ISO 8601 date string)'),
    assignedToId: z.number().int().positive().optional().describe('Employee ID to assign the task to'),
    dryRun: z.boolean().default(true).describe('true (default) = preview + token; false = execute write'),
    confirmation_token: z.string().optional().describe('Token from prior dryRun=true call'),
  },
  async handler(env, args, { actor, correlation }) {
    const { name, jobId, dueDate, assignedToId, dryRun = true, confirmation_token } = args;
    const businessArgs = { name, jobId, dueDate, assignedToId };
    const payload: Record<string, unknown> = { name, jobId };
    if (dueDate) payload.dueDate = dueDate;
    if (assignedToId) payload.assignedToId = assignedToId;
    // /taskmanagement/ — no hyphen (ST-specific path quirk)
    const endpoint = `/taskmanagement/v2/tenant/431848990/tasks`;
    const gate = new WriteGate(env);

    if (dryRun) {
      return gate.dryRun('create_task', businessArgs, actor, correlation, payload, endpoint, 'POST');
    }
    if (!confirmation_token) {
      throw new McpError('validation_error', 'confirmation_token required when dryRun=false', { correlation });
    }
    await gate.verifyToken('create_task', businessArgs, actor, confirmation_token);

    const resp = await env.TAYLOR_AI.fetch('https://taylor-ai/api/st/write', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-sync-key': env.MCP_SYNC_KEY, 'x-correlation-id': correlation, 'x-actor': actor },
      body: JSON.stringify({ endpoint, method: 'POST', payload }),
    });
    if (!resp.ok) throw new McpError('upstream_error', `create_task failed: ${resp.status}`, { correlation });
    return { dryRun: false, tool: 'create_task', result: await resp.json(), correlation };
  },
};
