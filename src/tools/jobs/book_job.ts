// T1/T2 catalog correction: campaignId is REQUIRED — ST rejects without it.
import { z } from 'zod';
import { McpError } from '../../errors';
import { WriteGate } from '../../write-gate';
import type { ToolDef } from '../index';

interface Args {
  customerId: number; locationId: number; businessUnitId: number;
  jobTypeId: number; campaignId: number;
  start: string; end: string;
  priority?: string; summary?: string; tagTypeIds?: number[];
  dryRun?: boolean; confirmation_token?: string;
}

export const book_job: ToolDef<Args> = {
  name: 'book_job',
  description: 'Book a new ST job. campaignId is required — ST rejects jobs without it. dryRun=true (default) → token → dryRun=false to write.',
  isWrite: true,
  zodSchema: {
    customerId: z.number().int().positive().describe('ST customer ID'),
    locationId: z.number().int().positive().describe('ST location ID'),
    businessUnitId: z.number().int().positive().describe('ST business unit ID'),
    jobTypeId: z.number().int().positive().describe('ST job type ID'),
    campaignId: z.number().int().positive().describe('ST campaign ID — REQUIRED by ST API'),
    start: z.string().describe('Appointment start ISO 8601 datetime'),
    end: z.string().describe('Appointment end ISO 8601 datetime'),
    priority: z.enum(['Normal', 'Urgent', 'Low']).optional().describe('Job priority'),
    summary: z.string().optional().describe('Job summary / customer notes'),
    tagTypeIds: z.array(z.number().int().positive()).optional().describe('Tag type IDs to apply'),
    dryRun: z.boolean().default(true).describe('true (default) = preview + token; false = execute write'),
    confirmation_token: z.string().optional().describe('Token from prior dryRun=true call'),
  },
  async handler(env, args, { actor, correlation }) {
    const { dryRun = true, confirmation_token, ...businessArgs } = args;
    const payload = businessArgs;
    const gate = new WriteGate(env);
    const endpoint = `/jpm/v2/tenant/431848990/jobs`;

    if (dryRun) {
      return gate.dryRun('book_job', businessArgs, actor, correlation, payload, endpoint, 'POST');
    }
    if (!confirmation_token) {
      throw new McpError('validation_error', 'confirmation_token required when dryRun=false', { correlation });
    }
    await gate.verifyToken('book_job', businessArgs, actor, confirmation_token);

    const resp = await env.TAYLOR_AI.fetch('https://taylor-ai/api/st/write', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-sync-key': env.MCP_SYNC_KEY, 'x-correlation-id': correlation, 'x-actor': actor },
      body: JSON.stringify({ endpoint, method: 'POST', payload }),
    });
    if (!resp.ok) throw new McpError('upstream_error', `book_job failed: ${resp.status}`, { correlation });
    return { dryRun: false, tool: 'book_job', result: await resp.json(), correlation };
  },
};
