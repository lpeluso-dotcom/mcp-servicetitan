import { z } from 'zod';
import { McpError } from '../../errors';
import { authHeaders } from '../../auth';
import type { ToolDef } from '../index';

interface Args {
  businessUnitIds: number[];
  startDate: string;
  endDate: string;
  skillBasedAvailability?: boolean;
}

// T3 catalog correction: get_capacity is a POST (not GET).
// ST /dispatch/v2/tenant/{t}/capacity-planning requires a POST body.
export const get_capacity: ToolDef<Args> = {
  name: 'get_capacity',
  description: 'Get dispatch capacity for business units over a date range. Note: this is a POST call to ST (not GET — the body carries the filter params). **Returns BU capacity counts** (`/capacity-planning` endpoint). For SLOT discovery, see `st_get_capacity_slots` which calls `/capacity`. Source: live ST (computed endpoint).',
  zodSchema: {
    businessUnitIds: z.array(z.number().int().positive()).min(1).describe('Business unit IDs to check capacity for'),
    startDate: z.string().describe('Start date (YYYY-MM-DD)'),
    endDate: z.string().describe('End date (YYYY-MM-DD)'),
    skillBasedAvailability: z.boolean().optional().describe('Use skill-based availability matching (default: false)'),
  },
  stEndpoint: {
    method: 'POST',
    path: '/dispatch/v2/tenant/{tid}/capacity-planning',
    source: 'live',
  },
  async handler(env, args, { actor, correlation }) {
    const body = {
      businessUnitIds: args.businessUnitIds,
      startDate: args.startDate,
      endDate: args.endDate,
      skillBasedAvailability: args.skillBasedAvailability ?? false,
    };

    const resp = await env.ST_PROXY.fetch(
      `https://servicetitan-proxy/api/st/read?endpoint=${encodeURIComponent('/dispatch/v2/tenant/000000000/capacity-planning')}`,
      {
        method: 'POST',
        headers: { ...authHeaders(env, correlation, actor), 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }
    );
    if (!resp.ok) throw new McpError('upstream_error', `get_capacity failed: ${resp.status}`, { correlation });
    const data = await resp.json<unknown>();
    return { capacity: data, _source: 'live' };
  },
};
