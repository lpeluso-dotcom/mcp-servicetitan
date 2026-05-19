import { z } from 'zod';
import { readST } from '../../st-read';
import type { ToolDef } from '../index';

interface Args {
  page?: number;
  pageSize?: number;
}

export const intacct_business_unit_mappings_get: ToolDef<Args> = {
  name: 'intacct_business_unit_mappings_get',
  description:
    'Get Sage Intacct dimension mappings assigned to ServiceTitan business units. ST-77.1 adds this settings endpoint so callers no longer need a manual SQL export. Source: live ST.',
  zodSchema: {
    page: z.number().int().positive().optional().describe('Page number, default 1.'),
    pageSize: z.number().int().positive().max(200).optional().describe('Page size, default 50, max 200.'),
  },
  stEndpoint: {
    method: 'GET',
    path: '/settings/v2/tenant/{tid}/business-units/intacct',
    source: 'live',
  },
  async handler(env, args, { actor, correlation }) {
    const data = await readST<{ data?: unknown[]; hasMore?: boolean }>(
      env,
      '/settings/v2/tenant/000000000/business-units/intacct',
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
      mappings: data.data ?? [],
      has_more: !!data.hasMore,
      _source: 'live',
    };
  },
};
