import { z } from 'zod';
import { readST } from '../../st';
import type { ToolDef } from '../index';

interface Args { campaignId: number; from?: string; to?: string }

export const get_campaign_performance: ToolDef<Args> = {
  name: 'get_campaign_performance',
  description: 'Get performance metrics for a campaign (leads, bookings, revenue) via ST Reporting API. Source: live ST (Reporting API — not in D1).',
  zodSchema: {
    campaignId: z.number().int().positive().describe('ST campaign ID'),
    from: z.string().optional().describe('Start date for the period (YYYY-MM-DD)'),
    to: z.string().optional().describe('End date for the period (YYYY-MM-DD)'),
  },
  stEndpoint: { method: 'GET', path: '/marketing/v2/tenant/{tid}/campaigns/{campaignId}/costs', source: 'live' },
  async handler(env, args, { actor, correlation }) {
    const query: Record<string, unknown> = { campaignIds: args.campaignId };
    if (args.from) query.from = args.from;
    if (args.to) query.to = args.to;

    const data = await readST(
      env,
      { actor, correlation },
      `/marketing/v2/tenant/000000000/campaigns/${args.campaignId}/costs`,
      query,
    );
    return { performance: data, _source: 'live' };
  },
};
