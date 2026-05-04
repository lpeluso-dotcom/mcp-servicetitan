import { z } from 'zod';
import { McpError } from '../../errors';
import { authHeaders } from '../../auth';
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
  async handler(env, args, { actor, correlation }) {
    const qs = new URLSearchParams();
    qs.set('campaignIds', String(args.campaignId));
    if (args.from) qs.set('from', args.from);
    if (args.to) qs.set('to', args.to);

    const resp = await env.ST_PROXY.fetch(
      `https://servicetitan-proxy/api/st/read?endpoint=${encodeURIComponent(`/marketing/v2/tenant/000000000/campaigns/${args.campaignId}/costs?${qs}`)}`,
      { headers: authHeaders(env, correlation, actor) }
    );
    if (!resp.ok) throw new McpError('upstream_error', `get_campaign_performance failed: ${resp.status}`, { correlation });
    const data = await resp.json<unknown>();
    return { performance: data, _source: 'live' };
  },
};
