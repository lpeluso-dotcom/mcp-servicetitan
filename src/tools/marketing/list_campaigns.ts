import { z } from 'zod';
import { readST } from '../../st';
import type { ToolDef } from '../index';

interface Args { active?: boolean; page?: number; pageSize?: number }

export const list_campaigns: ToolDef<Args> = {
  name: 'list_campaigns',
  description: 'List marketing campaigns. Source: D1 (campaigns nightly-synced).',
  zodSchema: {
    active: z.boolean().optional().describe('Filter by active status (default: all)'),
    page: z.number().int().positive().default(1).describe('Page number'),
    pageSize: z.number().int().positive().max(200).default(50).describe('Page size, max 200'),
  },
  stEndpoint: { method: 'GET', path: '/marketing/v2/tenant/{tid}/campaigns', source: 'live' },
  async handler(env, args, { actor, correlation }) {
    const query: Record<string, unknown> = {
      page: args.page ?? 1,
      pageSize: args.pageSize ?? 50,
    };
    if (args.active !== undefined) query.active = args.active;

    const data = await readST<{ data?: unknown[] }>(
      env,
      { actor, correlation },
      `/marketing/v2/tenant/000000000/campaigns`,
      query,
    );
    return { campaigns: data.data ?? [], _source: 'live' };
  },
};
