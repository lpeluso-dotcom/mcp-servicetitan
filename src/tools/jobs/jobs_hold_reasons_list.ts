import { z } from 'zod';
import { readST } from '../../st-read';
import type { ToolDef } from '../index';

interface Args {
  page?: number;
  pageSize?: number;
}

export const jobs_hold_reasons_list: ToolDef<Args> = {
  name: 'jobs_hold_reasons_list',
  description:
    'List ServiceTitan job hold reasons. ST-77.1 adds this read surface for retrieving hold reasons associated with jobs. Source: live ST.',
  zodSchema: {
    page: z.number().int().positive().optional().describe('Page number, default 1.'),
    pageSize: z.number().int().positive().max(200).optional().describe('Page size, default 50, max 200.'),
  },
  stEndpoint: {
    method: 'GET',
    path: '/jpm/v2/tenant/{tid}/jobs/hold-reasons',
    source: 'live',
  },
  async handler(env, args, { actor, correlation }) {
    const data = await readST<{ data?: unknown[]; hasMore?: boolean }>(
      env,
      '/jpm/v2/tenant/000000000/jobs/hold-reasons',
      {
        actor,
        correlation,
        query: {
          page: args.page ?? 1,
          pageSize: args.pageSize ?? 50,
        },
      },
    );
    return {
      reasons: data.data ?? [],
      has_more: !!data.hasMore,
      _source: 'live',
    };
  },
};
