import { z } from 'zod';
import { readST } from '../../st';
import type { ToolDef } from '../index';

interface Args { jobId: number; page?: number; pageSize?: number }

export const list_estimates_job: ToolDef<Args> = {
  name: 'list_estimates_job',
  description: 'List all estimates for a specific job. Source: D1 (estimates nightly-synced).',
  zodSchema: {
    jobId: z.number().int().positive().describe('ST job ID'),
    page: z.number().int().positive().default(1).describe('Page number'),
    pageSize: z.number().int().positive().max(200).default(50).describe('Page size, max 200'),
  },
  stEndpoint: { method: 'GET', path: '/sales/v2/tenant/{tid}/estimates', source: 'live' },
  async handler(env, args, { actor, correlation }) {
    const query: Record<string, unknown> = {
      jobId: args.jobId,
      page: args.page ?? 1,
      pageSize: args.pageSize ?? 50,
    };
    const data = await readST<{ data?: unknown[] }>(
      env,
      { actor, correlation },
      '/sales/v2/tenant/000000000/estimates',
      query,
    );
    return { estimates: data.data ?? [], _source: 'live' };
  },
};
