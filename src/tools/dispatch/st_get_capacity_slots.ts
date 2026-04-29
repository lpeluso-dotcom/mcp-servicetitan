// ============================================================
// st_get_capacity_slots — POST /dispatch/v2/tenant/{tid}/capacity
//
// Distinct from `get_capacity` which calls `/capacity-planning` and returns
// BU capacity counts. This endpoint returns the bookable slot list used by
// the live availability picker — required input for any "what slots are
// available next Tuesday for BU=3" UX.
//
// Both endpoints are POST-as-read (taylor-ai's /api/st/read accepts POST).
// ============================================================
import { z } from 'zod';
import { McpError } from '../../errors';
import { authHeaders } from '../../auth';
import type { ToolDef } from '../index';

interface Args {
  startsOnOrAfter: string;
  endsOnOrBefore: string;
  businessUnitIds?: number[];
  skillBasedAvailability?: boolean;
}

export const st_get_capacity_slots: ToolDef<Args> = {
  name: 'st_get_capacity_slots',
  description:
    'Return bookable capacity SLOTS for a date range (the slot-finder used for live availability). POSTs to /dispatch/v2/tenant/{tid}/capacity. Distinct from `get_capacity` which calls `/capacity-planning` and returns BU capacity counts. Source: live ST.',
  zodSchema: {
    startsOnOrAfter: z
      .string()
      .describe('ISO 8601 datetime — earliest slot start (inclusive)'),
    endsOnOrBefore: z
      .string()
      .describe('ISO 8601 datetime — latest slot end (inclusive)'),
    businessUnitIds: z
      .array(z.number().int().positive())
      .optional()
      .describe('Business unit IDs to constrain slot search'),
    skillBasedAvailability: z
      .boolean()
      .optional()
      .describe('Use skill-based availability matching (default: false)'),
  },
  stEndpoint: {
    method: 'POST',
    path: '/dispatch/v2/tenant/{tid}/capacity',
    source: 'live',
  },
  async handler(env, args, { actor, correlation }) {
    const body: Record<string, unknown> = {
      startsOnOrAfter: args.startsOnOrAfter,
      endsOnOrBefore: args.endsOnOrBefore,
      skillBasedAvailability: args.skillBasedAvailability ?? false,
    };
    if (args.businessUnitIds && args.businessUnitIds.length > 0) {
      body.businessUnitIds = args.businessUnitIds;
    }

    const resp = await env.TAYLOR_AI.fetch(
      `https://taylor-ai/api/st/read?endpoint=${encodeURIComponent('/dispatch/v2/tenant/431848990/capacity')}`,
      {
        method: 'POST',
        headers: { ...authHeaders(env, correlation, actor), 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }
    );
    if (!resp.ok) {
      throw new McpError('upstream_error', `st_get_capacity_slots failed: ${resp.status}`, {
        correlation,
      });
    }
    const data = await resp.json<unknown>();
    return { slots: data, _source: 'live' };
  },
};
